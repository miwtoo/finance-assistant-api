import { Elysia } from "elysia";
import { parseExpense } from "./openai.ts";
import { syncDraftToLedger, isSyncConfigured, validateDraftForSync } from "./sync.ts";
import type { SyncDraftPayload } from "./types.ts";

const CORS_ORIGIN = "http://localhost:5173";
const MAX_INPUT_LENGTH = 1000;

const app = new Elysia()
  .onRequest(({ request, set }) => {
    set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
    set.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Content-Type";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
  })
  .get("/", () => ({
    name: "finance-assistant-api",
    version: "0.1.0",
    mode: "mvp",
  }))
  .get("/api/health", () => ({
    status: "ok",
    mode: "mvp",
  }))
  .post("/api/parse-expense", async ({ body, set }) => {
    // Guard malformed/null/empty body
    if (!body || typeof body !== "object" || !("text" in body)) {
      set.status = 400;
      return { error: "Missing or invalid 'text' field" };
    }

    const { text } = body as { text?: string };

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      set.status = 400;
      return { error: "Missing or invalid 'text' field" };
    }

    if (text.trim().length > MAX_INPUT_LENGTH) {
      set.status = 400;
      return { error: `Input exceeds maximum length of ${MAX_INPUT_LENGTH} characters` };
    }

    if (!process.env.OPENAI_API_KEY) {
      set.status = 503;
      return { error: "OPENAI_API_KEY not configured; parsing unavailable" };
    }

    try {
      const draft = await parseExpense(text.trim());
      return { draft };
    } catch (err) {
      console.error("parseExpense error:", err);
      set.status = 502;
      return { error: "Parsing service unavailable. Please try again later." };
    }
  })
  .post("/api/sync-draft", async ({ body, set }) => {
    // Strict body guard before any type assertion
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "Missing or invalid request body" };
    }

    const raw = body as Record<string, unknown>;

    // Validate each field with strict types before sync
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
      set.status = 400;
      return { error: "id must be a non-empty string" };
    }
    if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || (raw.amount as number) <= 0) {
      set.status = 400;
      return { error: "Amount must be a finite positive number" };
    }
    if (raw.currency !== "THB") {
      set.status = 400;
      return { error: "Only THB currency is supported for sync" };
    }
    if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
      set.status = 400;
      return { error: "Description must be a non-empty string" };
    }
    if (typeof raw.spentAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.spentAt)) {
      set.status = 400;
      return { error: "Date must be in YYYY-MM-DD format" };
    }
    if (raw.merchant !== null && raw.merchant !== undefined && typeof raw.merchant !== "string") {
      set.status = 400;
      return { error: "Merchant must be a string or null" };
    }
    if (raw.categoryHint !== null && raw.categoryHint !== undefined && typeof raw.categoryHint !== "string") {
      set.status = 400;
      return { error: "Category hint must be a string or null" };
    }

    // Check config AFTER body validation so 503 is only about missing config
    if (!isSyncConfigured()) {
      console.error("Ledger sync not configured (missing FIREFLY_BASE_URL, FIREFLY_ACCESS_TOKEN, or FIREFLY_SOURCE_ACCOUNT_NAME)");
      set.status = 503;
      return { error: "Ledger sync not configured" };
    }

    const payload: SyncDraftPayload = {
      id: (raw.id as string).trim(),
      amount: raw.amount as number,
      currency: raw.currency as string,
      description: raw.description as string,
      spentAt: raw.spentAt as string,
      merchant: raw.merchant === null ? null : (raw.merchant as string),
      categoryHint: raw.categoryHint === null ? null : (raw.categoryHint as string),
      confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? (raw.confidence as number) : 0,
      rawText: typeof raw.rawText === "string" ? raw.rawText : "",
    };

    try {
      const result = await syncDraftToLedger(payload, payload.id);
      return { synced: true, transactionId: result.transactionId };
    } catch (err) {
      // Log full details server-side
      console.error("syncDraftToLedger error:", err);
      set.status = 502;
      return { error: "Ledger sync failed. Check backend logs and Firefly configuration." };
    }
  })
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
