export interface ExpenseDraft {
  amount: number;
  currency: string;
  description: string;
  spentAt: string; // YYYY-MM-DD
  merchant: string | null;
  categoryHint: string | null;
  confidence: number; // 0..1
  rawText: string;
}

/** Payload received by POST /api/sync-draft */
export interface SyncDraftPayload {
  id: string;
  amount: number;
  currency: string;
  description: string;
  spentAt: string; // YYYY-MM-DD
  merchant: string | null;
  categoryHint: string | null;
  confidence: number; // 0..1
  rawText: string;
}

export interface ParseExpenseRequest {
  text: string;
}
