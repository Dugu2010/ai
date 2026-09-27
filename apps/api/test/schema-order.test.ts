import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The schema is one multi-statement script, which Postgres runs top to bottom in
 * a single implicit transaction. An `ALTER TABLE x` placed before the
 * `CREATE TABLE x` is invisible on a database that already has the table and
 * fatal on a fresh one — startup aborts and the service crash-loops. This was
 * real: checkpoint_files' migration lines sat above its CREATE.
 */

const schema = readFileSync(
  fileURLToPath(new URL("../src/lib/schema.ts", import.meta.url)),
  "utf8"
);

function firstIndex(re: RegExp): number {
  const m = schema.match(re);
  return m ? (m.index ?? -1) : -1;
}

describe("schema statement order", () => {
  it("creates every table before altering it", () => {
    const altered = new Set(
      [...schema.matchAll(/ALTER TABLE ([a-z_]+)/g)].map((m) => m[1])
    );
    for (const table of altered) {
      const created = firstIndex(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
      const firstAlter = firstIndex(new RegExp(`ALTER TABLE ${table}\\b`));
      expect(created, `no CREATE TABLE for ${table}`).toBeGreaterThan(-1);
      expect(firstAlter, `ALTER before CREATE for ${table}`).toBeGreaterThan(created);
    }
  });
});
