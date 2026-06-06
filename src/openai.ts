import type { ExpenseDraft } from "./types.ts";

const OPENAI_TIMEOUT_MS = 15_000;

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an expense parser. Parse the user's expense description into a JSON object with these exact fields:
- "amount": number (the monetary amount, must be > 0)
- "currency": string (default "THB" if not specified; always uppercase)
- "description": string (short description of the expense)
- "spentAt": string (date in YYYY-MM-DD format; assume today if not mentioned)
- "merchant": string or null (where the expense occurred, if identifiable)
- "categoryHint": string or null (e.g., "food", "transport", "utilities")
- "confidence": number (0 to 1, how confident you are this is a correctly parsed expense)
- "rawText": string (the original user input)

Rules:
- Only handle already-paid personal expenses. Do NOT handle income, transfers, credit, or debt.
- Assume currency is THB if not explicitly mentioned. Always use uppercase for currency.
- Today's date is ${today}. Use this date (YYYY-MM-DD) if the date is not mentioned.
- Ensure amount is a positive number.
- If the input is not clearly an expense, still parse what you can but set confidence low (below 0.3).
- Return ONLY valid JSON, no other text.`;
}

export async function parseExpense(text: string): Promise<ExpenseDraft> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if ((err as Error).name === "AbortError") {
      throw new Error("OpenAI request timed out");
    }
    throw new Error("Failed to reach OpenAI API");
  } finally {
    clearTimeout(timeoutId);
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid response from parsing service");
  }

  if (!response.ok) {
    console.error("OpenAI API error:", JSON.stringify(data));
    throw new Error("Parsing service request failed");
  }

  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const content = choices?.[0]?.message as { content?: string } | undefined;
  const messageContent = content?.content;
  if (!messageContent) {
    throw new Error("Parsing service returned empty response");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(messageContent) as Record<string, unknown>;
  } catch {
    throw new Error("Failed to parse service response");
  }

  const today = new Date().toISOString().slice(0, 10);

  // Strict validation: only accept finite amount > 0
  const amount =
    typeof parsed.amount === "number" && Number.isFinite(parsed.amount) && parsed.amount > 0
      ? parsed.amount
      : 0;

  // confidence: finite, clamp 0..1
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

  // description: non-empty
  const description =
    typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description.trim()
      : "(no description)";

  // currency: uppercase, default THB
  const currency =
    typeof parsed.currency === "string" && parsed.currency.trim().length > 0
      ? parsed.currency.trim().toUpperCase()
      : "THB";

  // spentAt: YYYY-MM-DD or fallback to today
  const spentAt =
    typeof parsed.spentAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.spentAt)
      ? parsed.spentAt
      : today;

  const draft: ExpenseDraft = {
    amount,
    currency,
    description,
    spentAt,
    merchant: parsed.merchant && typeof parsed.merchant === "string" ? parsed.merchant : null,
    categoryHint:
      parsed.categoryHint && typeof parsed.categoryHint === "string" ? parsed.categoryHint : null,
    confidence,
    rawText: text,
  };

  // Downgrade confidence for zero/invalid amount
  if (draft.amount <= 0) {
    draft.confidence = Math.min(draft.confidence, 0.2);
  }

  return draft;
}
