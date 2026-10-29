import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { randomUUID } from "node:crypto";

/**
 * The commit this bundle was built from, stamped in at build time so a deployed
 * Worker can say which source it is running.
 *
 * `WORKERS_CI_COMMIT_SHA` is injected by Workers Builds; outside it (local
 * builds, `vite preview`) there is no commit to name and the value is "dev".
 * Consumers must treat "dev" as "no claim" rather than as a mismatch — the
 * point is to catch a production deploy that silently stopped updating, and a
 * developer's laptop is not that.
 */
const BUILD_SHA = process.env.WORKERS_CI_COMMIT_SHA ?? "dev";

/**
 * Different for every build, unlike BUILD_SHA ("dev" off CI, and the same
 * when one commit is rebuilt with other settings). The edge cache keys stored
 * pages on it, because a page names this build's hashed assets.
 */
const BUILD_ID = randomUUID();

const config = defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: { tsconfigPaths: true },
  build: {
    rolldownOptions: {
      output: {
        // Route chunks are named after their route files, and the default
        // sanitizer keeps the `@` of `@{$handle}`. Cloudflare's asset server
        // answers `/assets/@…` with a 307 to `/assets/%40…`, which cost every
        // reader page a redirect per route chunk before it could hydrate. This
        // is the default's character set, minus `@`.
        sanitizeFileName: (name) => name.replace(/[^\w./-]/g, "_"),
      },
    },
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
});

export default config;
