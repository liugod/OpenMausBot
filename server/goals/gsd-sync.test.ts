import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";
import { syncGsdGoals } from "./gsd-sync.ts";

it("projects real GSD phases into one owner-scoped goal and retains the last snapshot on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-gsd-sync-")), taskId = "fixture-1";
  const hash = createHash("sha256").update(taskId).digest("hex"), state = join(dir, "gsd-integration");
  const tree = join(state, "worktrees", hash);
  mkdirSync(join(tree, ".codex"), { recursive: true }); mkdirSync(join(state, "runs"), { recursive: true });
  const installer = spawnSync(process.execPath, [resolve("../intake/gsd-core-package-v1.21.0/package/bin/install.js"), "--codex", "--local", "--relative-includes", "--no-legacy-cleanup"],
    { cwd: tree, env: { ...process.env, GSD_HOME: join(dir, "gsd-home") }, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  expect(installer.status, installer.stderr).toBe(0);
  writeFileSync(join(state, "runs", `${hash}.json`), JSON.stringify({ taskId, state: "ready", worktree: tree }));
  const goals = openGoalStore(join(dir, "goals.db"));
  try {
    const input = { taskId, ownerId: "owner", title: "Fixture", request: "Build the fixture", leadBotId: "chief", leadThreadId: "thread" };
    const created = goals.createGsdGoal(input);
    expect(goals.createGsdGoal(input)).toEqual(created);
    expect(() => goals.createGsdGoal({ ...input, request: "different" })).toThrow();
    expect(goals.read(created.goalId, "other")).toBeUndefined();
    await syncGsdGoals(dir, goals);
    expect(goals.read(created.goalId, "owner")?.gsd).toMatchObject({ taskId, snapshot: { planning: false, phases: [] }, error: null });
    mkdirSync(join(tree, ".planning"));
    writeFileSync(join(tree, ".planning", "ROADMAP.md"), "# Roadmap\n\n### Phase 1: Foundation\n**Goal**: Build base\n\n### Phase 2: Launch\n**Goal**: Ship safely\n");
    await syncGsdGoals(dir, goals);
    const snapshot = goals.read(created.goalId, "owner")?.gsd;
    expect(snapshot).toMatchObject({ snapshot: { planning: true, phase_count: 2, completed_phases: 0, phases: [{ number: "1", name: "Foundation" }, { number: "2", name: "Launch" }] }, error: null });
    const reopened = openGoalStore(join(dir, "goals.db"));
    try { expect(reopened.read(created.goalId, "owner")?.gsd).toEqual(snapshot); } finally { reopened.close(); }
    expect(goals.read(created.goalId, "owner")?.status).toBe("planning");
    expect(goals.scopes.overview("owner")).toEqual([expect.objectContaining({ goalId: created.goalId, status: "gsd", gsd: expect.objectContaining({ taskId }) })]);
    expect(goals.scopes.overview("other")).toEqual([]);
    expect(goals.bindGsdGoal({ taskId, ownerId: "owner", goalId: created.goalId })).toEqual(created);
    expect(() => goals.bindGsdGoal({ taskId: "another", ownerId: "owner", goalId: created.goalId })).toThrow(/conflict/);
    expect(() => goals.bindGsdGoal({ taskId: "another", ownerId: "other", goalId: created.goalId })).toThrow(/not found/);
    renameSync(join(tree, ".planning", "ROADMAP.md"), join(tree, ".planning", "hidden.md"));
    await syncGsdGoals(dir, goals);
    expect(goals.read(created.goalId, "owner")?.gsd).toMatchObject({ snapshot: snapshot!.snapshot, error: expect.stringContaining("missing") });
    goals.create({ id: "existing", ownerId: "owner", commandId: "existing-command", title: "Existing", request: "Existing request",
      leadBotId: "other-bot", leadThreadId: "other-thread", executionLimit: 3 });
    goals.bindGsdGoal({ taskId: "second-task", goalId: "existing", ownerId: "owner", viewerBotId: "chief" });
    expect(goals.scopes.overview("owner")).toEqual(expect.arrayContaining([expect.objectContaining({ goalId: "existing", assigneeBotId: "chief" })]));
    expect(goals.read("existing", "owner")?.leadBotId).toBe("other-bot");
  } finally { goals.close(); await removeTempDir(dir); }
}, 120_000);

it("upgrades an existing version 10 link without losing its snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-gsd-migrate-")), path = join(dir, "goals.db");
  const first = openGoalStore(path);
  const goal = first.createGsdGoal({ taskId: "old", ownerId: "owner", title: "Old", request: "Preserve it", leadBotId: "bot", leadThreadId: "thread" });
  first.saveGsdSnapshot("old", { planning: true, phases: [{ number: "1" }] }); first.close();
  const old = new DatabaseSync(path);
  old.exec("ALTER TABLE goal_gsd_links DROP COLUMN viewer_bot_id; DELETE FROM goal_schema_migrations WHERE version=11"); old.close();
  const updated = openGoalStore(path);
  try { expect(updated.read(goal.goalId, "owner")?.gsd).toMatchObject({ snapshot: { planning: true, phases: [{ number: "1" }] } }); }
  finally { updated.close(); await removeTempDir(dir); }
});
