/**
 * Copy existing Modal workspaces into the R2 mirror, so the Vercel cutover does
 * not lose a single project's files.
 *
 * Run this BEFORE setting RUNTIME_PROVIDER=vercel in production. It is safe to
 * re-run: a project already marked imported is skipped, and nothing here deletes
 * anything on the Modal Volume.
 *
 * Reading files out is deliberately done through Modal rather than by mounting
 * the Volume elsewhere: Modal exposes no file API on a Volume, so the only place
 * project bytes are reachable is a live sandbox, which is exactly what the old
 * provider was for. This costs Modal compute once per project and is the last
 * thing DAI ever spends it on.
 *
 *   DATABASE_URL=... MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... \
 *   R2_ACCOUNT_ID=... R2_BUCKET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *   bun run tsx scripts/migrate-runtime-v2.ts [--dry-run] [--project=<id>]
 */

import { ModalProvider, ModalRuntimeService, configFromEnv as modalConfigFromEnv } from "@dai/modal";
import { S3ObjectStore, WorkspaceMirror, configFromEnv as vercelConfigFromEnv, isMirrorConfigured } from "@dai/vercel";
import { pool } from "@dai/db";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONLY = argv.find((arg) => arg.startsWith("--project="))?.split("=")[1];
const BATCH = 40;

async function main(): Promise<void> {
  const modalConfig = modalConfigFromEnv();
  const vercelConfig = vercelConfigFromEnv();
  if (!isMirrorConfigured(vercelConfig)) {
    throw new Error("R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are all required.");
  }

  const mirror = new WorkspaceMirror({
    store: S3ObjectStore.forR2({
      accountId: vercelConfig.r2.accountId,
      bucket: vercelConfig.r2.bucket,
      accessKeyId: vercelConfig.r2.accessKeyId,
      secretAccessKey: vercelConfig.r2.secretAccessKey,
    }),
    rootPrefix: vercelConfig.r2.rootPrefix,
    workspaceRoot: vercelConfig.workspacePath,
  });
  const service = new ModalRuntimeService({ provider: new ModalProvider({ config: modalConfig }) });

  const rows = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM projects
      WHERE runtime_provider IS DISTINCT FROM 'vercel'
         OR runtime_migration_status IS DISTINCT FROM 'vercel_files_imported'
      ORDER BY created_at ASC`
  );
  const targets = ONLY ? rows.rows.filter((row) => row.id === ONLY) : rows.rows;
  console.log(`${targets.length} project(s) to consider${DRY_RUN ? " (dry run)" : ""}.`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of targets) {
    const already = await pool.query<{ one: number }>(
      `SELECT 1 AS one FROM projects
        WHERE id = $1 AND runtime_migration_status = 'vercel_files_imported'`,
      [project.id]
    );
    if (already.rowCount) {
      skipped += 1;
      continue;
    }

    let release: (() => void) | null = null;
    try {
      const acquired = await service.acquire({ projectId: project.id });
      release = () => acquired.close();
      const listed = await acquired.exec(
        'find "$1" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -printf "%P\\n"',
        { timeoutMs: 120_000 }
      );
      if (listed.exitCode !== 0 && !listed.stdout) {
        await markImported(project.id, 0);
        skipped += 1;
        continue;
      }
      const relative = (listed.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
      const root = modalConfig.workspacePath;

      let bytes = 0;
      for (let offset = 0; offset < relative.length; offset += BATCH) {
        const chunk = relative.slice(offset, offset + BATCH);
        const batch = await acquired.readFilesBatch(chunk.map((path) => `${root}/${path}`));
        for (const path of chunk) {
          const entry = batch[`${root}/${path}`];
          if (!entry || !("exists" in entry) || entry.exists !== true) continue;
          const content = entry.isText ? entry.content : entry.binary === null ? null : Buffer.from(entry.binary, "base64");
          if (content === null || content === undefined) continue;
          const absolute = `${root}/${path}`;
          if (!DRY_RUN) await mirror.putFile(project.id, absolute, content);
          bytes += typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
        }
      }

      if (!DRY_RUN) {
        // Clean, so the very first read after cutover is served from the mirror
        // rather than booting a sandbox to answer it.
        await mirror.markClean(project.id);
        await markImported(project.id, bytes);
      }
      imported += 1;
      console.log(`  ${project.name}: ${relative.length} file(s), ${(bytes / 1024).toFixed(1)} KiB`);
    } catch (error) {
      failed += 1;
      console.error(`  ${project.name}: FAILED — ${error instanceof Error ? error.message : error}`);
    } finally {
      release?.();
    }
  }

  service.close();
  console.log(`\nimported=${imported} skipped=${skipped} failed=${failed}`);
  if (failed > 0) {
    console.error("Some projects did not import. Do not switch RUNTIME_PROVIDER until they report success.");
    process.exitCode = 1;
  } else if (!DRY_RUN && imported + skipped > 0) {
    console.log("All workspaces are in R2. Set RUNTIME_PROVIDER=vercel and restart the API.");
  }
  await pool.end();
}

async function markImported(projectId: string, bytes: number): Promise<void> {
  await pool.query(
    `UPDATE projects
        SET runtime_migration_status = 'vercel_files_imported',
            runtime_volume_subpath = 'projects/' || id,
            workspace_bytes = $2,
            workspace_measured_at = now()
      WHERE id = $1`,
    [projectId, bytes]
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
