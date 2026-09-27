import { describe, expect, it } from "vitest";
import workspaceRouter from "../src/routes/workspace.js";
import agentRouter from "../src/routes/agent.js";
import projectsRouter from "../src/routes/projects.js";
import rollbackRouter from "../src/routes/rollback.js";

/**
 * The public HTTP surface.
 *
 * DAI has no user-facing terminal, so "no exec route exists" is a product
 * requirement, not an accident of wiring. This test reads the mounted routers
 * themselves rather than asserting a string in a source file, so re-adding a
 * command endpoint — under any name — fails here.
 *
 * The routers are imported statically: loading `@dai/modal` costs several
 * seconds, and a dynamic import inside the `it` body charges that to the
 * 5s test timeout, which the first router to load would always exceed.
 */

type Router = { stack: unknown[] };

const ROUTERS: Array<[string, Router]> = [
  ["workspace", workspaceRouter as unknown as Router],
  ["agent", agentRouter as unknown as Router],
  ["projects", projectsRouter as unknown as Router],
  ["rollback", rollbackRouter as unknown as Router],
];

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
  it.each(ROUTERS)("%s router exposes no exec-like route", (_name, router) => {
    const routes = endpoints(router);
    expect(routes.length, `${_name} router mounted nothing — wiring changed?`).toBeGreaterThan(0);
    expect(routes.filter((route) => EXEC_LIKE.test(route))).toEqual([]);
  });

  it("keeps the workspace router to file, status, preview and lifecycle reads", () => {
    const paths = [...new Set(endpoints(workspaceRouter as unknown as Router).map((route) => route.split(" ")[1]))];
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
