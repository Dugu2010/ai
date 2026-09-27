import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // These tests must never reach the network: they exercise in-memory
    // stand-ins for the Sandbox client and the object store. Anything needing
    // credentials is tagged live and excluded here.
    exclude: ["test/live/**", "node_modules/**", "dist/**"],
    environment: "node",
  },
});
