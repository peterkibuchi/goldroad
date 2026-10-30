const MAX_MESSAGE_CHARS = 200;

/** First line only (drizzle puts `params:` on the next one), with DIDs,
 * JWTs and long token-like runs redacted, then capped. A failed query's
 * message carries its bound params, which for the OAuth session store are a
 * writer's tokens and DPoP key. */
export function safeMessage(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine
    .replace(/did:[a-z]+:[A-Za-z0-9._:%-]+/g, "did:…")
    .replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, "[token]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
    .slice(0, MAX_MESSAGE_CHARS);
}
