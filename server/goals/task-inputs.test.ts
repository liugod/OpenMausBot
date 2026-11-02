import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";
import { taskInputsCurrent } from "./task-inputs.ts";

describe("transitive goal inputs", () => {
  it("detects an upstream artifact revision even before an intermediate task is audited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-transitive-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 10 });
      const task = { id: "a", title: "Task", brief: "Work", assigneeBotId: "bot", required: true, workspaceRef: "workspace", dependsOn: [] as string[],
        criteria: [{ id: "criterion", description: "Review", kind: "lead_review" as const, required: true, config: {} }] };
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "test", tasks: [task, { ...task, id: "b", dependsOn: ["a"] }, { ...task, id: "c", dependsOn: ["b"] }] });
      const raw = new DatabaseSync(path);
      try {
        raw.exec("UPDATE goal_tasks SET status='succeeded' WHERE id IN ('a','b'); UPDATE goal_tasks SET status='running' WHERE id='c'");
        const bytes = Buffer.from("input");
        const sha = createHash("sha256").update(bytes).digest("hex");
        for (const item of ["a", "b", "c"]) raw.prepare(`INSERT INTO goal_attempts (id, goal_id, task_id, root_id, workspace_ref, status, created_at)
          VALUES (?, 'g', ?, ?, 'workspace', ?, 1)`).run(`work-${item}`, item, `root-${item}`, item === "c" ? "running" : "succeeded");
        for (const item of ["a", "b"]) {
          const artifactId = `artifact-${item}`;
          raw.prepare(`INSERT INTO goal_artifacts VALUES (?, 'g', ?, ?, 'output', 1, 'output.txt', ?, ?, 'text/plain', 1, 1)`)
            .run(artifactId, item, `work-${item}`, sha, bytes.length);
          raw.prepare("INSERT INTO goal_artifact_snapshots VALUES (?, ?, ?, ?, 1)").run(artifactId, sha, bytes.length, bytes);
          const evidence = { attemptId: `work-${item}`, requirementRevision: 1, planRevision: 1,
            artifacts: [{ id: artifactId, logicalName: "output", sha256: sha, bytes: bytes.length }] };
          raw.prepare(`INSERT INTO goal_review_attempts (id, goal_id, task_id, root_id, bot_id, thread_id, evidence_json, status, created_at)
            VALUES (?, 'g', ?, ?, 'lead', 'thread', ?, 'applied', 1)`).run(`review-${item}`, item, `review-root-${item}`, JSON.stringify(evidence));
        }
        for (const [downstream, upstream] of [["b", "a"], ["c", "b"]]) {
          raw.prepare("INSERT INTO goal_attempt_dependencies VALUES (?, ?, ?, 1, 1)").run(`work-${downstream}`, upstream!, `review-${upstream}`);
          raw.prepare("INSERT INTO goal_attempt_inputs VALUES (?, ?, ?, 'output', ?, ?)").run(`work-${downstream}`, upstream!, `artifact-${upstream}`, sha, bytes.length);
        }
        expect(taskInputsCurrent(raw, "g", "work-c")).toBe(true);
        raw.prepare(`INSERT INTO goal_artifacts VALUES ('a-new', 'g', 'a', 'work-a', 'output', 2, 'output.txt', ?, ?, 'text/plain', 1, 2)`)
          .run(sha, bytes.length);
        expect(raw.prepare("SELECT status FROM goal_tasks WHERE id='b'").get()?.status).toBe("succeeded");
        expect(taskInputsCurrent(raw, "g", "work-c")).toBe(false);
      } finally { raw.close(); }
    } finally { goals.close(); await removeTempDir(dir); }
  });
});
