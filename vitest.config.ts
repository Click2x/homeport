import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

// Tests run against TypeScript sources, so no build step is needed first.
export default defineConfig({
  resolve: {
    alias: {
      "@homeport/core": src("core"),
      "@homeport/engine": src("engine"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
