import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";

describe("automatic checks", () => {
  it("blocks missing artifacts and never treats an absent file as a pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-auto-check-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead", executionLimit: 3 });
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "test", tasks: [{ id: "task", title: "Task", brief: "Work", assigneeBotId: "worker", required: true,
          workspaceRef: "workspace", dependsOn: [], criteria: [{ id: "file", description: "File", kind: "artifact_exists", required: true, config: { logicalName: "result" } }] }] });
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`INSERT INTO goal_attempts (id, goal_id, task_id, root_id, workspace_ref, status, created_at) VALUES ('work','g','task','root','workspace','succeeded',1);
          UPDATE goal_tasks SET status='checking' WHERE id='task';
          INSERT INTO goal_task_results (attempt_id, goal_id, task_id, requirement_revision, plan_revision, result_json, created_at) VALUES ('work','g','task',1,1,'{"artifactIds":[]}',1);`);
      } finally { raw.close(); }
      const pending = goals.nextAutomaticAction("", "", 100).action;
      expect(pending).toMatchObject({ kind: "block", code: "missing_artifact" });
      if (!pending || pending.kind !== "block") throw new Error("expected missing-artifact action");
      const { kind: _kind, ...input } = pending;
      goals.blockAutomaticAction({ ...input, commandId: "block" });
      expect(goals.read("g", "owner")?.tasks[0]).toMatchObject({ status: "blocked", blocker: "missing_artifact" });
      expect(goals.nextAutomaticAction("", "", 100).action).toBeUndefined();
    } finally { goals.close(); await removeTempDir(dir); }
  });
});
