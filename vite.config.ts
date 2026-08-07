import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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

const config = defineConfig({
  define: { __BUILD_SHA__: JSON.stringify(BUILD_SHA) },
  resolve: { tsconfigPaths: true },
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
