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

- **`packages/ui` has no consumer.** `apps/web` was its last importer and no
  longer declares it. `build:packages` and `typecheck` still build it. Either
  adopt it or delete it; it is not currently load-bearing.
- **Stale reports are still tracked**: `ARCHITECTURE_MIGRATION.md`,
  `AUDIT.md`, `FINAL_INTEGRATION_READINESS.md`, `PHASE3_FINAL.md`,
  `PHASE3_PROGRESS.md`, `PROGRESS.md`, `STATUS.txt`, `UI_FINAL.md`. `AUDIT.md`
  additionally describes the CodeSandbox-era runtime. Left in place rather than
  deleted, since removing tracked history is a call for the owner.
- **`bun run lint` covers `lint:web` and `lint:modal` only.** `apps/api` has no
  lint script, so its style is unchecked (types are checked).
- **`POST /api/workspace/:projectId/command` still exists.** It is
  auth- and ownership-gated and confined to `SAFE_COMMANDS` minus
  `DANGEROUS_PATTERNS`, and no UI calls it. It is a deliberate agent-side
  surface, not a user terminal — but it is the widest door in the API and worth
  a review of whether the route still needs to be reachable from a client.
- **Modal's JS SDK is 0.x beta**; breaking changes can land in a patch bump.
  The pinned surface is recorded in `RUNTIME_ARCHITECTURE.md`.

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
