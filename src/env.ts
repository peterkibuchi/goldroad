import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    SERVER_URL: z.url().optional(),
  },

  /**
   * The prefix that client-side variables must have. This is enforced both at
   * a type-level and at runtime.
   */
  clientPrefix: "VITE_",

  client: {
    VITE_APP_TITLE: z.string().min(1).optional(),
    /** Canonical public origin every absolute URL is minted from (OAuth
     * client_id, publication URLs, head tags). Read by ~/lib/origin. Defaults
     * to the hosted instance; self-hosters set their own (see SELF_HOSTING.md). */
    VITE_PUBLIC_ORIGIN: z.url().optional(),
    /** PostHog project key — analytics no-op entirely when absent/empty.
     * Build-time client var (see .env.example): one project across dev,
     * preview and prod, separated by the hostname-derived app_env property. */
    VITE_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
    /** PostHog ingestion host; defaults to https://us.i.posthog.com. */
    VITE_PUBLIC_POSTHOG_HOST: z.url().optional(),
    /** Cloudflare Turnstile sitekey — the anti-bot widget on the waitlist and
     * report forms renders only when this is set; absent means those forms
     * behave exactly as before (no widget, no token). Pair with the
     * TURNSTILE_SECRET Worker secret (see .dev.vars.example) or the server
     * skips verification. */
    VITE_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  },

  /**
   * What object holds the environment variables at runtime. This is usually
   * `process.env` or `import.meta.env`.
   */
  runtimeEnv: import.meta.env,

  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
});
