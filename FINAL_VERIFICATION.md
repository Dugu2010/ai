# DAI — Verification Report

Supersedes every earlier `PHASE3_*`, `PROGRESS`, `STATUS` and `UI_FINAL` note in
this directory. Those describe intermediate states of the CodeSandbox-era and
the migration; this describes the tree as committed.

Architecture, unchanged and enforced:
**Vercel** (`apps/web`) → **Render** (`apps/api` + PostgreSQL) → **Modal**
(Sandbox + Volume). **NVIDIA NIM** is the model. There is no other runtime, and
nothing in this repository targets one.

Gate run on the committed tree (tip `ec93ddd`):

| Command | Result |
|---|---|
| `bun run build:packages` | rc=0 |
| `bun run typecheck` (types, db, modal, nim, ui, web, api) | rc=0 |
| `bun run lint` (`lint:web` + `lint:modal`) | rc=0 — was exit 1 with 8 `apps/web` errors |
| `bun run test` | **344 passed, 0 failed** |
| `bun run build:web` (`next build`) | rc=0, 7 routes |

Test counts by suite: `packages/modal` **87** (58 + 29 new), `apps/api` **217**
(207 + 10 new), `apps/web` **40** (a new suite — the app previously had vitest
and @testing-library/react declared with no config and no test script, so none
of its presentation layer was checked). The "57 tests" figure in commit
`92feab3` is wrong; it is 40, and that commit message is not amended after the
fact.

## What was verified in this pass

**Frontend carries no backend material.** Built the way `vercel.json` now tells
Vercel to build, then scanned `.next/static`: zero occurrences of
`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `NIM_API_KEY`, `JWT_SECRET`,
`CSRF_SECRET`, `DATABASE_URL`, `@dai/db`, `@dai/modal`, `@dai/nim` or
`ModalClient`. The frontend reads exactly one env var,
`process.env.NEXT_PUBLIC_API_URL`. `express` and `jsonwebtoken` hits during the
scan were checked and are not real: one was the substring `expressions` in a
minified vendor chunk (0 word-boundary matches), the other is a file Next.js
vendors inside its own `dist/compiled/`.

**Dead secret-reading code removed**, not left "just in case": `lib/auth.ts`,
`lib/csrf.ts`, `lib/rate-limit.ts`, `lib/size-limits.ts`, `lib/design-tokens.ts`,
`lib/command-validation.ts`, `lib/path-validation.ts`, `components/index.ts` —
each confirmed 0-importer, and `apps/web` no longer depends on any backend package.

**Two defects that would have shipped silently:**

1. `purgeWorkspace` mounted the entire shared Volume and then ran `rm -rf` on a
   *relative* path with no `workdir`. It resolved against the Sandbox's default
   directory, printed `absent`, and reported success — so deleting a project
   never reclaimed any storage while the quota kept counting it. It now removes
   the absolute mounted path, validates the id *before* provisioning compute,
   and its allowlist no longer accepts a leading space or dash.
2. `POST /:id/agent/stop` cancelled any `runId` supplied after checking only the
   project, so a guessed id could cancel another tenant's run; it also wrote
   `outcome=cancelled` before the loop had produced a result.

**Event contract is closed on both sides.** All 19 `ActivityEventType` members
appear at least once in `apps/api` sources, and the UI's `EVENT_META` covers
exactly those 19 — no type the UI handles that the server never emits, and none
the server emits that the UI drops.

**No chain-of-thought exposure.** `agent-loop.ts` parses only `message.content`
and `tool_calls`; the `thinking` span is wall-clock around the NIM call. A test
asserts that an event whose detail carries `reasoning` / `thought` /
`chainOfThought` / `thinking` keys renders nothing.

**No user-facing terminal.** The UI calls only `/agent`, `/agent/stop`,
`/agent/status`. The `Terminal` glyph in the timeline is a lucide icon for
command events.

## Provider credits consumed

**Zero.** `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` and `NIM_API_KEY` are absent
from this environment; no Modal or NIM request was made, and no Sandbox was
created by any test. Ordinary CI therefore costs nothing, by design and now by
test.

## Remaining known issues

- **`bun run lint` covers `lint:web` and `lint:modal` only.** `apps/api` has no
  lint script, so its style is unchecked (types are checked).
- **The command allowlist is not the security boundary, and cannot be.** `bash`
  and `sh` are allowlisted because the agent needs shells. A payload pass now
  strips quoting and scans the whole command, so `bash -c 'rm -rf /'` and
  friends are refused, but real isolation comes from the Modal Sandbox and the
  per-project Volume subPath. Treat the allowlist as accident-reduction.
- **Modal's JS SDK is 0.x beta**; breaking changes can land in a patch bump.
  The pinned surface is recorded in `RUNTIME_ARCHITECTURE.md`.
- **No DOM test environment.** `apps/web` has no jsdom/happy-dom, so there are
  no component render tests — the 40 tests cover the pure logic behind the
  components, not the rendering.

Resolved in the pass that followed this report: `packages/ui` had no consumer
and was removed; the superseded reports moved to `docs/archive/` behind a new
top-level `README.md`; and `POST /api/workspace/:projectId/command` was deleted
(see below).

## Genuinely unverified

These need live Modal credentials or a browser, and nothing here stands in for
them:

- **Any real Sandbox behaviour.** No Sandbox has ever been created from this
  repository. Unverified against a live provider: that a Volume mount produces a
  working `/workspace`, that `applyFileMutations` writes the bytes it claims,
  that a dev server actually binds and its preview URL loads, that `du`-based
  usage matches the Volume's real accounting, and that the fixed purge path
  deletes a real directory. The new purge test asserts the argv the code builds,
  which is the defect that was fixed — not the filesystem outcome.
- **The Modal runtime image.** `scripts/build-runtime-image.ts` has never run;
  without it, `MODAL_IMAGE_NAME` resolves to nothing and no workspace can boot.
- **Anything visual or interactive.** Layout at the 640/1024px boundaries,
  dark/light appearance, focus-visible rings, the toast animation, screen-reader
  announcements and keyboard traversal were established by reading the code and
  the CSS token set, and by unit-testing the pure logic — not by rendering in a
  browser. `apps/web` has no DOM environment installed (no jsdom/happy-dom), so
  component-level tests do not exist yet; the suite covers the functions behind
  the components.
- **Undo against a real workspace**, including the conflict path where a file
  was edited after the checkpoint.
- **End-to-end agent quality** with a real NIM model, and any claim about how
  well it codes.
- **Deployment.** Neither the Render blueprint nor the Vercel build has been run
  against those platforms from here.

---

# Pre-live hardening pass

Run after the report above, still with **zero** provider contact.

Gate on the committed tree:

| Command | Result |
|---|---|
| `bun run build:packages` | rc=0 |
| `bun run typecheck` (types, db, modal, nim, web, api) | rc=0 |
| `bun run lint` | rc=0 |
| `bun run build:web` | rc=0 |
| `bun run test` | **372 passed, 0 failed** (modal 87, api 245, web 40) |

## The command endpoint was removed, not guarded

`POST /api/workspace/:projectId/command` was commented "Internal endpoint used
by the agent tooling". Nothing used it. The agent executes through in-process
`Workspace` calls in `lib/agent-run.ts`, which applies the same
`validateCommandOptions` check *and* `budget.commandTimeoutMs()`; no code in
`apps/api` or `apps/web` ever fetched that route, and the only references left
were in archived Freestyle-era reports.

Meanwhile the route was the one command path that escaped metering: it called
`acquireWorkspace` (a possible Sandbox creation) outside the budget and capped
its timeout at the global 300s rather than the per-run limit. So it offered no
capability the agent path lacks, and weaker guarantees than it. Removed, along
with its now-unused imports. `validateCommand`/`validateCommandOptions` are
unchanged and remain in force on the agent path.

`test/http-surface.test.ts` now pins the whole mounted surface, so a
command-like route under any name (`command|exec|shell|terminal|tty|spawn|run-`)
fails the suite rather than being re-added quietly.

## Command validation strengthened, not weakened

`bash -c 'rm -rf /'` previously passed validation, and a test asserted it did.
The anchored `DANGEROUS_PATTERNS` can only inspect a command's first word, so
anything wrapped in a shell was invisible to them. A second pass now strips
quote characters and scans the whole string for root/home/`/workspace` recursive
deletes, `--no-preserve-root`, `mkfs`, `dd of=/dev/…` and fork bombs.
`bash -c 'rm -rf node_modules'`, `bash -c 'npm test'` and `rm -rf /workspace/build`
are still accepted — 11 refusal cases and 9 allow cases are pinned in
`test/validation.test.ts`, which also pins that a bare `rm`/`find`/`kill` is
refused for not being allowlisted.

This is accident reduction, not a boundary: `bash` and `sh` must stay available,
so isolation remains the Sandbox plus the Volume subPath. The old test that
pinned the limitation as accepted behaviour was replaced rather than deleted.

## Cost guards re-checked in code

- File operations report `requiresRuntime: true` with the reason Modal exposes
  no Volume file API; there is no cheap path to pretend otherwise, and the
  budget meters what it costs.
- Activations, exec calls, runtime seconds and iterations are each capped by
  `RuntimeBudget` and covered by `test/runtime-policy.test.ts` (25 tests).
- A dev server is launched only after `isPortListening` says the port is free,
  so a run cannot stack duplicates.
- No sleep, ping or noise-command keeps a Sandbox alive anywhere;
  `idleTimeoutMs` reclaims compute and nothing fights it. The 15s
  `setInterval` in `lib/sandbox-queue.ts` polls PostgreSQL only, and the
  `Connection: keep-alive` header in `routes/agent.ts` is SSE, not runtime.
- Every test in the suite runs without credentials; the live suite is separate
  and opt-in.

## Documentation

Added a top-level `README.md` that states the architecture canonically —
including that Kubernetes is not part of DAI — and moved the eight superseded
reports to `docs/archive/` with `docs/archive/README.md` explaining what each
was and why it is stale. `git mv` preserved their history; nothing was deleted.
