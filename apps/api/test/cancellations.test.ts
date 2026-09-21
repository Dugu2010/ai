import { afterEach, describe, expect, it } from "vitest";
import {
  cancellationCount,
  isCancelled,
  registerCancellation,
  unregisterCancellation,
} from "../src/lib/cancellations.js";

/**
 * Cancellation is cooperative and process-local: one flag per run id, observed
 * only between iterations. These pin the registry itself — the leak guard in
 * particular, since a set that never drains grows for the life of the server.
 */

describe("cancellation registry", () => {
  afterEach(() => {
    for (const runId of ["run-a", "run-b"]) unregisterCancellation(runId);
  });

  it("is not cancelled until it is registered", () => {
    expect(isCancelled("run-a")).toBe(false);
    registerCancellation("run-a");
    expect(isCancelled("run-a")).toBe(true);
  });

  it("releases the entry when the run finishes", () => {
    registerCancellation("run-a");
    unregisterCancellation("run-a");
    expect(isCancelled("run-a")).toBe(false);
  });

  it("keeps one stop from cancelling another run", () => {
    registerCancellation("run-a");
    registerCancellation("run-b");
    unregisterCancellation("run-a");
    expect(isCancelled("run-a")).toBe(false);
    expect(isCancelled("run-b")).toBe(true);
  });

  it("counts live entries so the registry cannot grow without bound", () => {
    const before = cancellationCount();
    registerCancellation("run-a");
    registerCancellation("run-b");
    registerCancellation("run-a");
    expect(cancellationCount()).toBe(before + 2);
    unregisterCancellation("run-a");
    unregisterCancellation("run-b");
    expect(cancellationCount()).toBe(before);
  });

  it("unregistering an unknown run is a no-op", () => {
    const before = cancellationCount();
    unregisterCancellation("never-registered");
    expect(cancellationCount()).toBe(before);
  });
});
