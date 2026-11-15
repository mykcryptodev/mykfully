import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // tsconfig keeps `jsx: preserve` for Next; tests (e.g. the X preview renderer) need JSX compiled.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30000 },
});
