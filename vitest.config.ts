import { defineConfig } from "vitest/config";

import { fileURLToPath } from "node:url";

// Vitest deliberately uses its own config instead of `vite.config.ts`:
// the TanStack Start, Nitro, and devtools plugins are build/dev-server
// plugins and are not needed (or wanted) when running unit tests.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // The Workers virtual module only exists under workerd; route files
      // import it at module scope, so vite's import-analysis needs a real
      // file to resolve to before any vi.mock could intercept it.
      "cloudflare:workers": fileURLToPath(
        new URL("./src/__tests__/mocks/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
  },
});
