/**
 * Test stand-in for the `cloudflare:workers` virtual module (aliased in
 * vitest.config.ts). Route files read bindings at module scope, which makes
 * them untransformable under plain vitest without this; tests needing real
 * behavior behind a binding should mock the lib that uses it instead.
 * Values are patterned fakes — nothing here is a secret. `DB` exists only so
 * `drizzle(env.DB)` constructs in route handlers; no test ever executes a
 * query against it (store libs are mocked, or checked via .toSQL()).
 */
export const env: Record<string, unknown> = {
  COOKIE_SECRET: "vitest-fake-cookie-secret",
  DB: {},
};
