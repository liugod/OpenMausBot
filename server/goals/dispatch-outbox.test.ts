import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner } from "../runtime/testing/fake-runner.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { deliverDispatch } from "./dispatch-outbox.ts";
import { openExecutionBudgetStore, type DispatchIntent } from "./execution-budget.ts";

describe("goal dispatch outbox", () => {
  it("reconciles a crash after runtime acceptance without creating another root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-outbox-"));
    try {
      const goalPath = join(dir, "goals.db");
      const runtimePath = join(dir, "runtime.db");
      const intent: DispatchIntent = { goalId: "g", attemptId: "a", authorizationRef: "owner-ref",
        request: { dispatchKey: "goal:g:attempt:a", rootId: "root", requesterRef: "a", brief: "Work", level: "ask",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "thread" } } } };
      const goals = openExecutionBudgetStore(goalPath);
      goals.create("g", 1);
      expect(goals.prepareDispatch(intent)).toBe("prepared");
      expect(goals.prepareDispatch(intent)).toBe("duplicate");
      expect(() => goals.prepareDispatch({ ...intent, request: { ...intent.request, brief: "changed" } })).toThrow(/conflict/);
      const runtimeStore = openRuntimeStore(runtimePath);
      const runtime = new Runtime(runtimeStore, new FakeRunner());
      runtime.open();
      expect(deliverDispatch(intent.request.dispatchKey, goals, runtime, () => "denied")).toMatchObject({ ok: false, reason: "denied" });
      expect(runtimeStore.all()).toHaveLength(0);
      expect(runtime.enqueueClientRoot(intent.request)).toMatchObject({ ok: true, duplicate: false });
      runtimeStore.close();
      goals.close();

      const restoredGoals = openExecutionBudgetStore(goalPath);
      const restoredRuntimeStore = openRuntimeStore(runtimePath);
      try {
        const restoredRuntime = new Runtime(restoredRuntimeStore, new FakeRunner(), {
          admitClientExecution: (root, id, no) => restoredGoals.admit(root, id, no),
        });
        restoredRuntime.open();
        expect(restoredGoals.pendingDispatches(10)).toEqual([intent]);
        expect(deliverDispatch(intent.request.dispatchKey, restoredGoals, restoredRuntime, () => true))
          .toMatchObject({ ok: true, duplicate: true, assignment: { id: "root" } });
        expect(restoredGoals.pendingDispatches(10)).toEqual([]);
        expect(restoredRuntimeStore.all()).toHaveLength(1);
      } finally { restoredRuntimeStore.close(); restoredGoals.close(); }
    } finally { await removeTempDir(dir); }
  });
});
