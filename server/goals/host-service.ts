import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import type { Coordinator, CoordinatorOptions } from "../coordinator.ts";
import type { ClientRootRequest } from "../runtime/runtime.ts";
import { openExecutionBudgetStore, type DispatchIntent } from "./execution-budget.ts";
import { openGoalStore } from "./goal-store.ts";
import { createGoalScheduler } from "./scheduler.ts";
import { createGoalToolDispatcher } from "./tool-dispatch.ts";
import type { GoalRunContext } from "./goal-store.ts";
import type { GoalRuntimePort } from "./runtime-port.ts";

export function createPersistentGoalHost(options: {
  dataDir: string;
  isLocalDataDir: (path: string) => boolean;
  authorize: (intent: DispatchIntent) => true | string;
  confirmStopped: (rootId: string) => boolean;
  resolveAuthorizedRoots?: (workspaceRef: string) => readonly string[];
  isCurrentTurn?: (context: GoalRunContext) => boolean;
  canAssignBot?: (context: GoalRunContext, botId: string) => boolean;
  canUseWorkspace?: (context: GoalRunContext, workspaceRef: string) => boolean;
  prepareReadyWork?: Parameters<typeof createGoalScheduler>[0]["prepareReadyWork"];
  prepareReadyReview?: Parameters<typeof createGoalScheduler>[0]["prepareReadyReview"];
  log: (message: string) => void;
}) {
  if (!isAbsolute(options.dataDir) || options.dataDir.startsWith("\\\\") || options.dataDir.startsWith("//") || !options.isLocalDataDir(options.dataDir)) {
    throw new Error("persistent goals require a verified local data directory");
  }
  const path = join(options.dataDir, "goals.db");
  const goals = openGoalStore(path);
  let budget: ReturnType<typeof openExecutionBudgetStore>;
  try { budget = openExecutionBudgetStore(path); } catch (error) { goals.close(); throw error; }
  let scheduler: ReturnType<typeof createGoalScheduler> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let runtimePort: GoalRuntimePort | undefined;
  let dispatchTool: ReturnType<typeof createGoalToolDispatcher> | undefined;
  function contextForTurn(rootId: string, botId: string, threadId: string): GoalRunContext | undefined {
    if (closed || !runtimePort || !options.isCurrentTurn) return undefined;
    const run = runtimePort.runtimeStore.get(rootId);
    if (!run || run.id !== run.rootId || run.status !== "running" || run.assignee.botId !== botId ||
      run.assignee.destination.threadId !== threadId || run.executions < 1) return undefined;
    const context = { rootId, botId, threadId, executionNo: run.executions };
    return options.isCurrentTurn(context) === true ? context : undefined;
  }
  let processing: Promise<void> | undefined;
  let cursor = { goalId: "", taskId: "" };
  function processChecks(): Promise<void> {
    if (processing) return processing;
    const resolveRoots = options.resolveAuthorizedRoots;
    if (!resolveRoots) return Promise.resolve();
    processing = (async () => {
      for (let i = 0; i < 100 && !closed; i++) {
        const next = goals.nextAutomaticAction(cursor.goalId, cursor.taskId, 100);
        if (!next.action) {
          if (next.cursor) { cursor = next.cursor; continue; }
          cursor = { goalId: "", taskId: "" }; break;
        }
        cursor = next.cursor!;
        const action = next.action;
        try {
          if (action.kind === "check") {
            const { kind: _kind, ...input } = action;
            await goals.checkRegisteredArtifact(input, resolveRoots);
          } else if (action.kind === "finalize") {
            const { kind: _kind, ...input } = action;
            await goals.finalizeReview(input, resolveRoots);
          } else {
            const { kind: _kind, ...input } = action;
            const digest = createHash("sha256").update(JSON.stringify([action.goalId, action.taskId, action.expectedVersion, action.code])).digest("hex");
            goals.blockAutomaticAction({ ...input, commandId: `auto-block:${digest}` });
          }
          cursor = { goalId: "", taskId: "" };
          if (!closed) scheduler?.tick();
        } catch { options.log("persistent goal automatic check deferred"); }
      }
    })().catch(() => { options.log("persistent goal automatic processing failed"); }).finally(() => { processing = undefined; });
    return processing;
  }
  const hooks: NonNullable<CoordinatorOptions["persistentGoals"]> = {
    authorizeRoot(request: ClientRootRequest) {
      if (closed) return "Goal service is closed";
      const intent = budget.pendingDispatch(request.dispatchKey);
      if (!intent || JSON.stringify(intent.request) !== JSON.stringify(request)) return "Dispatch is missing or does not match its frozen request";
      return options.authorize(intent);
    },
    admitExecution(rootId, assignmentId, executionNo) {
      if (closed || !scheduler) return false;
      const intent = budget.rootIntent(rootId);
      return !!intent && options.authorize(intent) === true && budget.admit(rootId, assignmentId, executionNo);
    },
    confirmStopped(rootId) { return !closed && options.confirmStopped(rootId) === true; },
  };
  return {
    goals,
    budget,
    coordinatorHooks: hooks,
    canContinueRoot(rootId: string): boolean {
      return !closed && !!runtimePort && runtimePort.runtime.clientRootStopped?.(rootId) === true;
    },
    start(coordinator: Coordinator) {
      if (closed) throw new Error("goal service is closed");
      if (scheduler) throw new Error("goal service already started");
      const port = coordinator.persistentGoalRuntime?.();
      if (!port) throw new Error("coordinator does not support persistent goals");
      const next = createGoalScheduler({ goals, budget, runtime: port.runtime, runtimeStore: port.runtimeStore,
        lockPath: join(options.dataDir, "goal-scheduler.lock.db"), activateRuntime: () => port.activate(), deactivateRuntime: () => port.deactivate(),
        authorize: options.authorize, log: options.log, ...(options.prepareReadyWork ? { prepareReadyWork: options.prepareReadyWork } : {}),
        ...(options.prepareReadyReview ? { prepareReadyReview: options.prepareReadyReview } : {}) });
      try {
        next.start(); scheduler = next; runtimePort = port;
        dispatchTool = createGoalToolDispatcher({ goals, isCurrentRun: context => {
          const current = contextForTurn(context.rootId, context.botId, context.threadId);
          return current?.executionNo === context.executionNo;
        }, canAssignBot: (context, botId) => options.canAssignBot?.(context, botId) === true,
        canUseWorkspace: (context, workspace) => options.canUseWorkspace?.(context, workspace) === true,
        resolveAuthorizedRoots: (_context, workspace) => options.resolveAuthorizedRoots?.(workspace) ?? [] });
        next.tick();
        void processChecks();
        timer = setInterval(() => {
          if (processing) return;
          try { next.tick(); void processChecks(); } catch { options.log("persistent goal scheduler tick failed"); }
        }, 5000);
        timer.unref();
      } catch (error) { scheduler = undefined; runtimePort = undefined; dispatchTool = undefined; next.close(); throw error; }
    },
    roleForTurn(rootId: string, botId: string, threadId: string) {
      const context = contextForTurn(rootId, botId, threadId);
      if (!context) return undefined;
      try { return goals.roleForRun(context, candidate => contextForTurn(candidate.rootId, candidate.botId, candidate.threadId)?.executionNo === candidate.executionNo); }
      catch { return undefined; }
    },
    async callToolForTurn(rootId: string, botId: string, threadId: string, name: string, input: unknown) {
      const context = contextForTurn(rootId, botId, threadId);
      if (!context || !dispatchTool) throw new Error("goal tool is not authorized for this turn");
      return await dispatchTool(context, name, input);
    },
    async tick() { if (!scheduler || closed) throw new Error("goal service is not running"); if (!processing) scheduler.tick(); await processChecks(); },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (processing) await processing;
      runtimePort = undefined; dispatchTool = undefined;
      try { scheduler?.close(); } finally { try { budget.close(); } finally { goals.close(); } }
    },
  };
}
