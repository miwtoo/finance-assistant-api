import type { ExpenseDraft } from "./types.ts";

/* ---------- env helpers ---------- */

export function isSyncConfigured(): boolean {
  return !!(
    process.env.FIREFLY_BASE_URL &&
    process.env.FIREFLY_ACCESS_TOKEN &&
    process.env.FIREFLY_SOURCE_ACCOUNT_NAME
  );
}

function getBaseUrl(): string {
  const raw = process.env.FIREFLY_BASE_URL;
  if (!raw) throw new Error("FIREFLY_BASE_URL missing");
  // strip trailing slash, then ensure /api/v1 suffix
  let url = raw.replace(/\/+$/, "");
  if (!/\/api\/v1$/i.test(url)) {
    url += "/api/v1";
  }
  return url;
}

function getAccessToken(): string {
  const token = process.env.FIREFLY_ACCESS_TOKEN;
  if (!token) throw new Error("FIREFLY_ACCESS_TOKEN missing");
  return token;
}

function getSourceAccountName(): string {
  const name = process.env.FIREFLY_SOURCE_ACCOUNT_NAME;
  if (!name || name.trim().length === 0) throw new Error("FIREFLY_SOURCE_ACCOUNT_NAME missing or empty");
  return name.trim();
}

/* ---------- validation ---------- */

export function validateDraftForSync(draft: ExpenseDraft): string | null {
  if (typeof draft.amount !== "number" || !Number.isFinite(draft.amount) || draft.amount <= 0) {
    return "Amount must be a finite positive number";
  }
  if (draft.currency !== "THB") {
    return "Only THB currency is supported for sync";
  }
  if (!draft.description || typeof draft.description !== "string" || draft.description.trim().length === 0) {
    return "Description must be a non-empty string";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.spentAt)) {
    return "Date must be in YYYY-MM-DD format";
  }
  if (draft.merchant !== null && typeof draft.merchant !== "string") {
    return "Merchant must be a string or null";
  }
  if (draft.categoryHint !== null && typeof draft.categoryHint !== "string") {
    return "Category hint must be a string or null";
  }
  return null;
}

/* ---------- sync ---------- */

export interface SyncResult {
  transactionId: string | null;
}

/**
 * Sync a confirmed expense draft to the ledger (Firefly III) as a withdrawal.
 *
 * @param draft  - validated draft fields (amount, currency, etc.)
 * @param draftId - confirmed draft id used as external_id for idempotency
 * @throws Error (caught by caller, sanitized for response)
 */
export async function syncDraftToLedger(
  draft: ExpenseDraft,
  draftId: string,
): Promise<SyncResult> {
  const baseUrl = getBaseUrl();
  const token = getAccessToken();
  const sourceName = getSourceAccountName();

  const validation = validateDraftForSync(draft);
  if (validation) {
    throw new Error(`Validation error: ${validation}`);
  }

  const transaction: Record<string, unknown> = {
    type: "withdrawal",
    date: draft.spentAt,
    amount: draft.amount.toFixed(2),
    description: draft.description.trim(),
    currency_code: "THB",
    source_name: sourceName,
    destination_name: draft.merchant || draft.description.trim(),
    external_id: draftId,
  };

  // Append optional fields only when present
  if (draft.categoryHint) {
    transaction.category_name = draft.categoryHint;
  }

  const body: Record<string, unknown> = {
    error_if_duplicate_hash: true,
    transactions: [transaction],
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/transactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Ledger sync network error:", err);
    throw new Error("Ledger sync failed. Check backend logs and Firefly configuration.");
  }

  if (!response.ok) {
    // Log full details server-side but throw sanitized
    let detail = `Ledger API returned HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as Record<string, unknown>;
      if (typeof errorBody.message === "string") {
        detail += `: ${errorBody.message}`;
      }
    } catch {
      // ignore parse failure
    }
    console.error("Ledger sync API error:", detail);
    throw new Error("Ledger sync failed. Check backend logs and Firefly configuration.");
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    console.error("Ledger sync response parse error");
    throw new Error("Invalid JSON response from ledger API");
  }

  // Extract transaction ID: try data.id, then nested data.data.id / transaction_journal_id
  const result: SyncResult = { transactionId: null };

  if (typeof data.id === "string" || typeof data.id === "number") {
    result.transactionId = String(data.id);
  }

  if (!result.transactionId && data.data && typeof data.data === "object") {
    const inner = data.data as Record<string, unknown>;
    if (typeof inner.id === "string" || typeof inner.id === "number") {
      result.transactionId = String(inner.id);
    }
    const attrs = inner.attributes as Record<string, unknown> | undefined;
    if (attrs?.transactions && Array.isArray(attrs.transactions) && attrs.transactions.length > 0) {
      const txn = attrs.transactions[0] as Record<string, unknown>;
      if (txn.transaction_journal_id) {
        result.transactionId = String(txn.transaction_journal_id);
      }
    }
  }

  return result;
}
