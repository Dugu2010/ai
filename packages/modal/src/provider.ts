/**
 * Owns the long-lived Modal objects DAI needs: the App that namespaces them,
 * the single shared workspace Volume, and one immutable, named runtime Image.
 *
 * The image is resolved by name first. Building is an explicit, rarely-run
 * operation (`ensureImage({ build: true })`, driven by scripts/build-runtime-image.ts)
 * so creating a Sandbox never pays for an image build.
 */

import { App, Image, ModalClient, Volume } from "modal";
import { configFromEnv, type ModalRuntimeConfig } from "./config.js";
import { toRuntimeError } from "./errors.js";

export interface ProviderDeps {
  config?: ModalRuntimeConfig;
  /** Injectable for tests; a real client is built from MODAL_TOKEN_* otherwise. */
  client?: ModalClient;
}

export class ModalProvider {
  readonly config: ModalRuntimeConfig;
  readonly client: ModalClient;
  private appPromise: Promise<App> | null = null;
  private volumePromise: Promise<Volume> | null = null;
  private imagePromise: Promise<Image> | null = null;

  constructor(deps: ProviderDeps = {}) {
    this.config = deps.config ?? configFromEnv();
    this.client = deps.client ?? new ModalClient();
  }

  get sandboxes() {
    return this.client.sandboxes;
  }

  /** `createIfMissing` is documented on App.fromName, so first use self-provisions. */
  app(): Promise<App> {
    this.appPromise ??= this.client.apps
      .fromName(this.config.appName, { createIfMissing: true })
      .catch((error: unknown) => {
        throw toRuntimeError(error, `Unable to resolve Modal app "${this.config.appName}"`);
      });
    return this.appPromise;
  }

  /**
   * One Volume for all projects. Each project mounts its own subPath, which
   * keeps durable workspace isolation without a Volume per project.
   */
  volume(): Promise<Volume> {
    this.volumePromise ??= this.client.volumes
      .fromName(this.config.volumeName, { createIfMissing: true })
      .catch((error: unknown) => {
        throw toRuntimeError(error, `Unable to resolve Modal volume "${this.config.volumeName}"`);
      });
    return this.volumePromise;
  }

  /** Resolve the published runtime image by name. */
  image(): Promise<Image> {
    this.imagePromise ??= this.client.images
      .fromName(this.config.imageName)
      .catch((error: unknown) => {
        throw toRuntimeError(
          error,
          `Modal image "${this.config.imageName}" is not published. Build it with: bun run tsx scripts/build-runtime-image.ts`
        );
      });
    return this.imagePromise;
  }

  /**
   * Build the runtime image from the base registry image and publish it under
   * the configured name. Idempotent: republishing a name replaces its tag.
   */
  async buildAndPublishImage(): Promise<Image> {
    const app = await this.app();
    try {
      const base = this.client.images.fromRegistry(this.config.baseImage);
      const built = await base.dockerfileCommands(this.config.imageCommands).build(app);
      await built.publish(this.config.imageName);
      this.imagePromise = Promise.resolve(built);
      return built;
    } catch (error) {
      throw toRuntimeError(error, `Failed to build Modal image "${this.config.imageName}"`);
    }
  }

  /** Drop cached references so the next call re-resolves from Modal. */
  reset(): void {
    this.imagePromise = null;
  }

  close(): void {
    this.client.close();
  }
}
