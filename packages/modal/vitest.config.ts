import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // These tests must never reach the network: they exercise an in-memory
    // stand-in for the Modal client. Anything requiring credentials is tagged
    // live and excluded here.
    exclude: ["test/live/**", "node_modules/**", "dist/**"],
    environment: "node",
  },
});
