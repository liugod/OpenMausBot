# Persistent goals: implementation and release status

Status: **not release ready**. The code is local and uncommitted. The persistent-goal components are internal and are not enabled or exposed by the production server, UI, or MCP interface.

Baseline: OpenMausBot `ac08cf72a70f4d334ea39e9044ecc514c0c1056c`, Node 24.18.0 and pnpm 10.33.0. The original bounded group-goal mechanism is outside this integration.

## Evidence

On 2026-11-02 08:07–08:14 China time a disposable fixture using the installed Codex CLI and `gpt-6.1-terra` exercised native coordination: the lead delegated to two bots, both completed, and the lead resumed and synthesized their work. The local evidence is `../intake/openmaus-m0-live-long/m0-live.json`. An earlier `gpt-5.4` attempt was unsupported by the account; another attempt timed out. These results demonstrate native coordination only, not persistent-goal operation or the PRD's file-delivery scenarios.

The current isolated runtime and goal suites passed 189 tests on 2026-11-02. Artifact validation also has a separately bundled worker test that runs outside the repository without `node_modules`. These are internal component tests, not a release or real-model acceptance test.

## Implemented internally

- SQLite-backed goals, plans, tasks, attempts, artifacts, result claims, checks, runtime event cursors, dispatch and stop outboxes, idempotency keys, budget reservations, database version guards, and a single scheduler ownership lock.
- Host-bound planning and work tool adapters: their goal, owner, attempt, bot and thread are derived from a verified running context, rather than accepted from model arguments. Production wiring and the authoritative context callbacks do not yet exist.
- Scheduling with frozen dispatch intent, host authorization and admission callbacks, replay, dependency checks and bounded round-robin preparation. No work runs when the required host hooks are absent. Management roots deny ordinary child enqueue, but all alternate host delegation paths must be audited before that restriction can be considered complete.
- Pause and cancellation preserve running work and record stop intents; cancellation is only confirmed after runtime quiescence and an authoritative host stop callback. Interrupted client trees are held after restart rather than blindly rerun. There is no user-facing reconciliation flow or production stop confirmation callback yet.
- Registered artifacts are opened under host-authorized roots, hashed and rechecked; stale, missing or inaccessible files cannot silently pass. Artifact constraints and JSON Schema checks distinguish pass, fail and unknown. JSON Schema executes in a resource-limited, timed worker that is bundled independently for packaged builds. Review and completion decisions remain unimplemented.

## Release blockers

1. Integrate the scheduler lifecycle, durable storage, trusted identity and workspace resolution, authorization, admission, and host stop proof into the production server; expose authenticated APIs and native UI. Implement atomic goal creation and planning dispatch.
2. Install the planning and work tools into the actual bot capability bridge, enforce management restrictions across every dispatch route, and validate end-to-end isolation and permissions. Provide automatic checking and safe review, revision, retry, delivery, and acceptance flows.
3. Complete recovery and explicit reconciliation for interrupted operations and external effects, reservation accounting, startup/shutdown ownership, local-filesystem validation, backup/restore, and migration coverage. Waiting attempts currently consume concurrency slots, so independent work can be blocked (H01 is unmet).
4. Exercise the PRD acceptance scenarios with real models, actual files, restart, cancellation, user interaction and release builds. The prior native-coordination fixture is not a substitute.

No push, publication, deployment, or production acceptance has been performed.
