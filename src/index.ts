import { Elysia } from "elysia";
import { parseExpense } from "./openai.ts";

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
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
