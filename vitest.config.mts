import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run per-package tests without Electron/Orca Desktop.
    include: ["packages/*/test/**/*.test.ts"],
    reporters: ["default"],
  },
});
