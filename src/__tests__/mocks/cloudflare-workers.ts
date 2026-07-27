/**
 * Test stand-in for the `cloudflare:workers` virtual module (aliased in
 * vitest.config.ts). Route files read bindings at module scope, which makes
 * them untransformable under plain vitest without this; tests needing real
 * behavior behind a binding should mock the lib that uses it instead.
 * Values are patterned fakes — nothing here is a secret.
 */
export const env: Record<string, string> = {
  COOKIE_SECRET: "vitest-fake-cookie-secret",
};
