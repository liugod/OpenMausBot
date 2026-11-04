import { z } from "zod";
import { GOAL_TOOL_ROLES } from "../drivers/agents-goal-tools.ts";
import type { GoalRunContext, openGoalStore } from "./goal-store.ts";
import { createPlanningTools } from "./planning-tools.ts";
import { createReviewTools } from "./review-tools.ts";
import { createWorkTools } from "./work-tools.ts";

const empty = z.strictObject({});

export function createGoalToolDispatcher(deps: {
  goals: ReturnType<typeof openGoalStore>;
  isCurrentRun: (context: GoalRunContext) => boolean;
  canAssignBot: (context: GoalRunContext, botId: string) => boolean;
  canUseWorkspace: (context: GoalRunContext, workspaceRef: string) => boolean;
  resolveAuthorizedRoots: (context: GoalRunContext, workspaceRef: string) => readonly string[];
}) {
  const issued = new Map<string, { version: number; fingerprint: string }>();
  function identity(context: GoalRunContext, role: "plan" | "work" | "review"): string {
    if (role === "plan") {
      const state = deps.goals.planningContext(context, deps.isCurrentRun);
      return JSON.stringify([role, state.goalId, state.ownerId, state.attemptId, state.areaId, state.workstreamId, state.requirementRevision, state.planRevision]);
    }
    if (role === "work") {
      const state = deps.goals.workContext(context, deps.isCurrentRun);
      return JSON.stringify([role, state.goalId, state.ownerId, state.attemptId, state.taskId, state.requirementRevision, state.planRevision, state.task]);
    }
    const state = deps.goals.reviewContext(context, deps.isCurrentRun);
    return JSON.stringify([role, state.goalId, state.ownerId, state.attemptId, state.taskId, state.evidence]);
  }
  function runKey(context: GoalRunContext): string {
    return JSON.stringify([context.rootId, context.botId, context.threadId, context.executionNo]);
  }
  function remember(context: GoalRunContext, role: "plan" | "work" | "review", version: number): void {
    const key = runKey(context);
    issued.delete(key);
    issued.set(key, { version, fingerprint: identity(context, role) });
    if (issued.size > 1000) issued.delete(issued.keys().next().value!);
  }
  return async (context: GoalRunContext, name: string, input: unknown): Promise<unknown> => {
    const role = deps.goals.roleForRun(context, deps.isCurrentRun);
    if (!role || !Object.hasOwn(GOAL_TOOL_ROLES, name) || !GOAL_TOOL_ROLES[name]!.includes(role)) throw new Error("tool is not authorized for this run");
    const allowVersionAdvance = (expectedVersion: number) => {
      const prior = issued.get(runKey(context));
      if (!prior || prior.version !== expectedVersion) return false;
      try { return prior.fingerprint === identity(context, role); } catch { return false; }
    };
    if (role === "plan") {
      const tools = createPlanningTools({ goals: deps.goals, context, isCurrentRun: deps.isCurrentRun,
        canAssignBot: botId => deps.canAssignBot(context, botId), canUseWorkspace: workspace => deps.canUseWorkspace(context, workspace), allowVersionAdvance });
      if (name === "goal_context") { empty.parse(input); const result = tools.getGoalContext(); remember(context, role, result.version); return result; }
      if (name === "goal_workspace_for_task") return tools.workspaceForTask(input);
      if (name === "submit_goal_plan") return tools.submitPlan(input);
    }
    if (role === "work") {
      const tools = createWorkTools({ goals: deps.goals, context, isCurrentRun: deps.isCurrentRun,
        resolveAuthorizedRoots: workspace => deps.resolveAuthorizedRoots(context, workspace), allowVersionAdvance });
      if (name === "goal_context") { empty.parse(input); const result = tools.getGoalContext(); remember(context, role, result.version); return result; }
      if (name === "register_goal_artifact") { const result = await tools.registerArtifact(input); remember(context, role, result.version); return result; }
      if (name === "save_goal_checkpoint") { const result = tools.saveCheckpoint(input); remember(context, role, result.version); return result; }
      if (name === "submit_goal_task_result") return tools.submitTaskResult(input);
      if (name === "list_goal_inputs") { empty.parse(input); return tools.listInputs(); }
      if (name === "read_goal_input") return tools.readInput(input);
    }
    if (role === "review") {
      const tools = createReviewTools({ goals: deps.goals, context, isCurrentRun: deps.isCurrentRun,
        resolveAuthorizedRoots: workspace => deps.resolveAuthorizedRoots(context, workspace), allowVersionAdvance });
      if (name === "goal_context") { empty.parse(input); const result = tools.getReviewContext(); remember(context, role, result.version); return result; }
      if (name === "read_goal_review_artifact") return tools.readArtifact(input);
      if (name === "submit_goal_review") return tools.submitReview(input);
    }
    throw new Error("tool is not available");
  };
}
