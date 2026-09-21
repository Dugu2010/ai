import { describe, expect, it } from "vitest";

/**
 * The public HTTP surface.
 *
 * DAI has no user-facing terminal, so "no exec route exists" is a product
 * requirement, not an accident of wiring. This test reads the mounted routers
 * themselves rather than asserting a string in a source file, so re-adding a
 * command endpoint — under any name — fails here.
 */

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
};

function endpoints(router: { stack: unknown[] }): string[] {
  return router.stack
    .map((layer) => (layer as Layer).route)
    .filter((route): route is NonNullable<Layer["route"]> => Boolean(route))
    .flatMap((route) =>
      Object.keys(route.methods)
        .filter((method) => route.methods[method])
        .map((method) => `${method.toUpperCase()} ${route.path}`)
    );
}

// Names that would let a caller run an arbitrary command.
const EXEC_LIKE = /(command|exec|shell|terminal|tty|spawn|run-)/i;

describe("no arbitrary-command endpoint is mounted", () => {
  it.each([
    ["workspace", "../src/routes/workspace.js"],
    ["agent", "../src/routes/agent.js"],
    ["projects", "../src/routes/projects.js"],
    ["rollback", "../src/routes/rollback.js"],
  ] as const)("%s router exposes no exec-like route", async (_name, modulePath) => {
    const module = (await import(modulePath)) as { default: { stack: unknown[] } };
    const routes = endpoints(module.default);
    expect(routes.length, `${_name} router mounted nothing — wiring changed?`).toBeGreaterThan(0);
    expect(routes.filter((route) => EXEC_LIKE.test(route))).toEqual([]);
  });

  it("keeps the workspace router to file, status, preview and lifecycle reads", async () => {
    const module = (await import("../src/routes/workspace.js")) as { default: { stack: unknown[] } };
    const paths = [...new Set(endpoints(module.default).map((route) => route.split(" ")[1]))];
    expect(paths.sort()).toEqual([
      "/:projectId",
      "/:projectId/concurrency",
      "/:projectId/file",
      "/:projectId/preview",
      "/:projectId/preview/proxy",
      "/:projectId/preview/stop",
      "/:projectId/restart",
      "/:projectId/status",
    ]);
  });
});
