---
name: openmaus-gsd-worker
description: Execute an assigned GSD Core coding task in its prepared worktree and return verifiable results to the OpenMaus chief.
---

# GSD coding worker

When the chief assigns a GSD task, use only the specified worktree. Do not assign the task to another OpenMaus bot. Check the task ID and worktree against:

`node "{{OMB_GSD_BRIDGE}}" status --task "<task-id>"`

Stop if the bridge reports an error, an unfinished preparation, a different worktree, or a different base commit. Read the user's task, actual project instructions, Git status, and any existing `.planning` before changing files. Never overwrite existing plans or uncommitted work.

Use the requested GSD workflow by reading `.codex/skills/<workflow>/SKILL.md` in the prepared worktree and its referenced files. For a pre-existing repository, start with `gsd-onboard`; for an established GSD plan, use the appropriate planning, progress, or execution workflow. GSD workflows need an active compatible Codex runtime. If required tools, GSD roles or approval interactions are unavailable, stop and report the precise blocker; do not pretend a workflow or an independent review ran.

Execute within the user's instructions and approval/budget limits. A GSD workstream does not provide code isolation; this worktree is the code isolation. Do not publish, push, merge, send messages to outsiders, or change permissions unless the user authorized that action. Do not blindly stage installed `.codex` files or unrelated changes.

Report the task ID, worktree path, base and resulting commit, actual changed files (including untracked deliverables), exact checks and exit results, GSD phase status, remaining issues, and whether any commit or push really occurred. Make no claim of completion without the requested checks and actual results. If interrupted or blocked, leave the workspace intact and report how far it got.
