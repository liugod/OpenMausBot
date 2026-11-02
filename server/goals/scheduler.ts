import { deliverDispatch } from "./dispatch-outbox.ts";
import type { DispatchIntent, ExecutionBudgetStore } from "./execution-budget.ts";
import type { openGoalStore } from "./goal-store.ts";
import { reconcileRuntimePage } from "./runtime-reconcile.ts";
import { acquireSchedulerLock } from "./scheduler-lock.ts";
import type { GoalRuntime, GoalRuntimeStore } from "./runtime-port.ts";

export function createGoalScheduler(deps: {
  lockPath: string;
  goals: ReturnType<typeof openGoalStore>;
  budget: ExecutionBudgetStore;
  runtime: GoalRuntime;
  runtimeStore: GoalRuntimeStore;
  activateRuntime?: () => void;
  deactivateRuntime?: () => void;
  authorize: (intent: DispatchIntent) => true | string;
  prepareReadyWork?: (candidate: ReturnType<ReturnType<typeof openGoalStore>["readyWork"]>[number]) =>
    { intent: DispatchIntent; resolveWritableWorkspace: (reference: string) => string } | undefined;
  prepareReadyReview?: (candidate: ReturnType<ReturnType<typeof openGoalStore>["readyReviews"]>[number]) => DispatchIntent | undefined;
  log: (message: string) => void;
}) {
  let lock: ReturnType<typeof acquireSchedulerLock> | undefined;
  let ticking = false;
  let closed = false;
  let lastWorkstreamId = "";
  const cursors = new Map<string, { goalId: string; taskId: string }>();
  let reviewCursor = { goalId: "", taskId: "" };
  let inputCursor = { goalId: "", taskId: "" };
  return {
    start(): void {
      if (closed) throw new Error("scheduler is closed");
      if (lock) return;
      lock = acquireSchedulerLock(deps.lockPath);
      try { deps.runtime.open(); } catch (error) { lock.close(); lock = undefined; throw error; }
    },
    tick(): void {
      if (!lock || closed || ticking) return;
      ticking = true;
      try {
        for (const stop of deps.goals.pendingStops(100)) {
          try {
            const request = deps.runtimeStore.clientRequest(stop.dispatchKey);
            if (!request) {
              if (deps.runtimeStore.get(stop.rootId)) throw new Error("unmatched root exists for stop intent");
              deps.goals.confirmStop(stop.rootId);
            } else {
              if (request.assignment.id !== stop.rootId) throw new Error("stop root does not match dispatch");
              if (deps.runtime.cancelClientRoot(stop.rootId)) deps.goals.confirmStop(stop.rootId);
            }
          } catch (error) { deps.log(`goal stop reconciliation failed: ${String(error)}`); }
        }
        if (reconcileRuntimePage(deps.goals, deps.runtimeStore, 100) === 100) { deps.deactivateRuntime?.(); return; }
        let audit = deps.goals.auditStaleInputs(inputCursor.goalId, inputCursor.taskId, 100);
        if (audit.scanned === 0 && inputCursor.goalId) audit = deps.goals.auditStaleInputs("", "", 100);
        inputCursor = audit.cursor ?? { goalId: "", taskId: "" };
        if (deps.prepareReadyWork) {
          let streams = deps.goals.readyWorkstreams(lastWorkstreamId, 100);
          if (streams.length === 0 && lastWorkstreamId) { lastWorkstreamId = ""; streams = deps.goals.readyWorkstreams("", 100); }
          for (const streamId of streams) {
            lastWorkstreamId = streamId;
            let cursor = cursors.get(streamId) ?? { goalId: "", taskId: "" };
            let candidates = deps.goals.readyWork(cursor.goalId, cursor.taskId, 100, streamId);
            if (candidates.length === 0 && cursor.goalId) {
              cursor = { goalId: "", taskId: "" };
              candidates = deps.goals.readyWork("", "", 100, streamId);
            }
            for (const candidate of candidates) {
              cursors.set(streamId, { goalId: candidate.goalId, taskId: candidate.task.id });
              try {
                const prepared = deps.prepareReadyWork(candidate);
                if (!prepared) continue;
                deps.goals.prepareWork({ ownerId: candidate.ownerId, goalId: candidate.goalId, taskId: candidate.task.id,
                  commandId: `auto-work:${candidate.task.id}:plan:${candidate.planRevision}`, expectedVersion: candidate.version, intent: prepared.intent },
                prepared.resolveWritableWorkspace);
                break;
              } catch { deps.log("goal ready-work preparation failed"); }
            }
          }
        }
        if (deps.prepareReadyReview) {
          let candidates = deps.goals.readyReviews(reviewCursor.goalId, reviewCursor.taskId, 100);
          if (candidates.length === 0 && reviewCursor.goalId) {
            reviewCursor = { goalId: "", taskId: "" };
            candidates = deps.goals.readyReviews("", "", 100);
          }
          for (const candidate of candidates) {
            reviewCursor = { goalId: candidate.goalId, taskId: candidate.taskId };
            try {
              const intent = deps.prepareReadyReview(candidate);
              if (!intent) continue;
              deps.goals.prepareReview({ goalId: candidate.goalId, ownerId: candidate.ownerId, taskId: candidate.taskId,
                expectedVersion: candidate.version, commandId: `auto-review:${candidate.taskId}:${intent.attemptId}`, intent });
            } catch { deps.log("goal review preparation deferred"); }
          }
        }
        for (const intent of deps.budget.pendingDispatches(100)) {
          try { deliverDispatch(intent.request.dispatchKey, deps.budget, deps.runtime, deps.authorize); }
          catch (error) { deps.log(`goal dispatch failed: ${String(error)}`); }
        }
        deps.activateRuntime?.();
        deps.runtime.tick();
        reconcileRuntimePage(deps.goals, deps.runtimeStore, 100);
      } catch (error) {
        deps.deactivateRuntime?.();
        throw error;
      } finally { ticking = false; }
    },
    close(): void {
      closed = true;
      try { deps.deactivateRuntime?.(); } finally { lock?.close(); lock = undefined; }
    },
  };
}
