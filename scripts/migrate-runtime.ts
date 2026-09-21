/**
 * One-time CodeSandbox -> Modal workspace migration.
 *
 *   bun run tsx scripts/migrate-runtime.ts [--dry-run] [--import-dir <dir>] [--project <id>]
 *
 * What it does, per project still pointing at the retired provider:
 *   1. Ensures the project's durable Modal workspace (a subPath of the shared
 *      Volume) exists. This provisions no compute.
 *   2. Records the Modal mapping and a migration status on the project row.
 *   3. If `--import-dir` contains an exported archive for the project, unpacks
 *      it into the workspace in a single upload.
 *
 * The previous provider's identifiers are preserved in `legacy_sandbox_id`;
 * nothing is deleted. Archives are only ever read from a directory an operator
 * supplies — this script never contacts the old provider.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModalProvider, ModalRuntimeService, configFromEnv, volumeSubPath } from "@dai/modal";
import { query, updateProject } from "@dai/db";

interface LegacyProject {
  id: string;
  slug: string;
  sandbox_id: string | null;
  legacy_sandbox_id: string | null;
  runtime_provider: string | null;
}

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    importDir: argv[argv.indexOf("--import-dir") + 1] ?? "",
    projectId: argv[argv.indexOf("--project") + 1] ?? "",
  };
}

function findArchive(importDir: string, project: LegacyProject): string | null {
  if (!importDir) return null;
  const candidates = [
    project.legacy_sandbox_id,
    project.sandbox_id,
    project.slug,
    project.id,
  ].filter((value): value is string => Boolean(value));
  for (const name of candidates) {
    for (const ext of [".tar.gz", ".tgz", ".tar"]) {
      const path = join(importDir, `${name}${ext}`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    console.error("[migrate] MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required.");
    process.exit(1);
  }

  const service = new ModalRuntimeService({ provider: new ModalProvider({ config: configFromEnv() }) });

  const where = args.projectId
    ? "WHERE (runtime_provider IS NULL OR runtime_provider = 'codesandbox_retired') AND id = $1"
    : "WHERE runtime_provider IS NULL OR runtime_provider = 'codesandbox_retired'";
  const params = args.projectId ? [args.projectId] : [];
  const { rows } = await query<LegacyProject>(
    `SELECT id, slug, sandbox_id, legacy_sandbox_id, runtime_provider FROM projects ${where}`,
    params
  );

  console.log(`[migrate] ${rows.length} project(s) pending; dry-run=${args.dryRun}; import-dir=${args.importDir || "(none)"}`);

  let ready = 0;
  let imported = 0;
  let awaiting = 0;
  let failed = 0;

  for (const project of rows) {
    const label = `${project.slug} (${project.id})`;
    if (args.dryRun) {
      const archive = findArchive(args.importDir, project);
      console.log(`[migrate] would migrate ${label}; archive=${archive ?? "none"}`);
      continue;
    }

    try {
      await service.ensureWorkspace(project.id);
      await updateProject(project.id, {
        runtimeProvider: "modal",
        runtimeVolumeSubPath: volumeSubPath(project.id),
        status: "provisioning",
        // A Modal workspace is empty until files are imported; never claim
        // otherwise. The Sandbox itself is created on first use.
        runtimeMigrationStatus: "modal_workspace_ready",
        sandboxId: null,
      });
      ready++;

      const archive = findArchive(args.importDir, project);
      if (!archive) {
        await updateProject(project.id, { runtimeMigrationStatus: "modal_awaiting_import" });
        awaiting++;
        console.log(`[migrate] ${label}: workspace ready, no archive supplied -> files NOT imported`);
        continue;
      }

      await service.importWorkspaceArchive(project.id, archive);
      await updateProject(project.id, { runtimeMigrationStatus: "modal_files_imported" });
      imported++;
      console.log(`[migrate] ${label}: imported ${archive}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await updateProject(project.id, { runtimeMigrationStatus: "modal_import_failed", lastError: message }).catch(
        () => undefined
      );
      console.error(`[migrate] ${label}: FAILED — ${message}`);
    }
  }

  console.log(`[migrate] done: ${ready} workspace(s) ready, ${imported} imported, ${awaiting} awaiting import, ${failed} failed`);
  service.close();
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("[migrate] unhandled:", error);
  process.exit(1);
});
