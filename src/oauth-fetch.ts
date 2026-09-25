import { OAuthErrorCode } from "@modelcontextprotocol/client";
import { failure } from "./diagnostics.js";

const codes = new Set<string>(Object.values(OAuthErrorCode));

/** SDK 2.1 logs OAuth recovery causes. Keep token-endpoint payloads out of stderr
 * without replacing its authentication logic or intercepting process-wide logging.
 */
export async function privateOAuthFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const tokenRequest = init?.body instanceof URLSearchParams && init.body.has("grant_type");
  if (!tokenRequest) return fetch(input, init);
  try {
    const response = await fetch(input, init);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) throw new Error("Token response too large");
        chunks.push(value);
      }
    } finally {
      await reader?.cancel();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!response.ok || (body && typeof body === "object" && "error" in body)) {
      const code = body && typeof body === "object" && "error" in body ? body.error : undefined;
      return Response.json({ error: typeof code === "string" && codes.has(code) ? code : "server_error" }, {
        status: response.status, headers: response.headers,
      });
    }
    if (!body || typeof body !== "object") throw new Error("Invalid token response");
    return new Response(text, { status: response.status, headers: response.headers });
  } catch {
    // Fetch and decoding errors can also contain remote text. Cancellation is
    // classified from the caller's signal, not from this exception's message.
    throw failure("oauth_failed", { operation: "auth" });
  }
}
