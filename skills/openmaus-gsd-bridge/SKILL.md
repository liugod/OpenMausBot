---
name: openmaus-gsd-bridge
description: Coordinate a user-requested GSD Core coding task in a separate Git worktree and report actual progress and evidence.
---

# OpenMausBot / GSD bridge

Use when the user asks to use GSD for a coding project. This is a local development workflow, not a background scheduler. Follow the user's requested scope and preserve existing projects, bot configurations and data.

1. Determine the exact absolute Git repository root and the intended task from the user or reliable current project context. Never substitute a guessed repository. Do not ask to repeat information already available; if the target remains unclear, ask which repository to use.
2. Choose a stable unique task ID (ASCII letters, numbers, hyphens or underscores), record it for retries, and run the installed bridge script:

   `node "{{OMB_GSD_BRIDGE}}" prepare --repository "<absolute Git root>" --task "<task-id>"`

   When constructing a PowerShell command, use literal single-quoted arguments and double any embedded apostrophe; do not interpolate project names or paths as executable code. It refuses dirty source checkouts and prepares a detached worktree at the current committed HEAD with GSD v1.21.0. A retry with the same ID returns the existing record. Treat `needs_inspection` or any error as a stop: report the actual reason rather than deleting files or silently inventing another task ID.
3. Create the linked OpenMaus goal immediately after preparation, using the exact task ID, a short task title and the user's full request:

   `node --experimental-strip-types "{{OMB_GSD_GOAL}}" --task "<task-id>" --title "<title>" --request "<request>"`

   If the user explicitly identifies an existing OpenMaus goal, instead run `node --experimental-strip-types "{{OMB_GSD_GOAL}}" --task "<task-id>" --goal "<goal-id>"`; never guess which existing goal to modify. Use safe literal arguments as above. The stable task ID makes retries idempotent. If linking fails, report the error and do not claim the phases are syncing. The goal is a progress record and does not itself start a second execution.
4. Call `list_bots` and select a suitable existing coding bot. Assign it the exact task ID, returned `worktree`, `baseCommit`, the user's full request, limits, and acceptance criteria with `coordinate_bots`. Tell it to use its `openmaus-gsd-worker` skill, execute in that worktree and read the installed `.codex/skills/gsd-onboard/SKILL.md` for an existing project or the specific requested GSD workflow. Tell it not to work in the source checkout, not to overwrite existing planning state, and to report actual files, test results and Git status. Preserve the user's approval and budget limits; never assume GSD may publish, merge, message outsiders or change permissions.
5. An assignment receipt means dispatched, not completed. End your turn and wait for the actual worker result using the host's normal coordination mechanism. Do not start a second copy while the first is in progress. If the runtime cannot load or execute the GSD workflow, or asks for user input, report that state and stop rather than claiming success.
6. On return, use `node "{{OMB_GSD_BRIDGE}}" status --task "<task-id>"` to read the current worktree HEAD, tracked-change indicator and GSD phase snapshot. This is a status projection, not independent proof of correctness. Check actual files, tests and Git results before reporting completion. If the worktree is detached, report that; do not claim a branch, commit or push unless it actually exists.

The GSD planner/executor agent roles are distinct from OpenMaus bots; do not claim typed GSD multi-agent dispatch, automatic execution limits, persistent recovery, or a verified final result without evidence. The host periodically projects GSD roadmap phases into the linked goal; it does not convert phase completion into goal acceptance or start GSD itself.
