/**
 * Build and publish DAI's Modal runtime image.
 *
 * Run once per environment (and again when the toolchain changes), NOT during a
 * request: Sandbox creation resolves the image by name and never rebuilds it.
 *
 *   MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... bun run tsx scripts/build-runtime-image.ts
 */

import { ModalProvider, configFromEnv } from "@dai/modal";

async function main(): Promise<void> {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    console.error("[image] MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required.");
    process.exit(1);
  }
  const config = configFromEnv();
  const provider = new ModalProvider({ config });

  console.log(`[image] base=${config.baseImage} publish-as=${config.imageName} app=${config.appName}`);
  console.log(`[image] layers:\n${config.imageCommands.join("\n")}`);

  const started = Date.now();
  const image = await provider.buildAndPublishImage();
  console.log(`[image] built and published in ${((Date.now() - started) / 1000).toFixed(1)}s (imageId=${image.imageId})`);
  provider.close();
}

main().catch((error) => {
  console.error("[image] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
