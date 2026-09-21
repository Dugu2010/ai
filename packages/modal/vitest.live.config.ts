import { defineConfig } from "vitest/config";

/**
 * Opt-in suite that talks to real Modal. Requires MODAL_TOKEN_ID/SECRET.
 *   bunx vitest run --config packages/modal/vitest.live.config.ts
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    // Sandbox creation, image resolution and Volume mounting are all remote.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Live tests share one Volume subPath namespace per run; serialise them.
    fileParallelism: false,
  },
});
