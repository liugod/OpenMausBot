import { z } from "zod";

import { parseGoalPlan, type GoalRunContext, type openGoalStore } from "./goal-store.ts";
import { goalWorkspaceRef } from "./workspace-refs.ts";

const submitSchema = z.strictObject({ commandId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
  requirementRevision: z.number().int().positive(), reason: z.string().min(1), tasks: z.array(z.unknown()).min(1).max(200) });

export function createPlanningTools(deps: {
  goals: ReturnType<typeof openGoalStore>;
  context: GoalRunContext;
  isCurrentRun: (context: GoalRunContext) => boolean;
  canAssignBot: (botId: string) => boolean;
  canUseWorkspace: (workspaceRef: string) => boolean;
  allowVersionAdvance?: (expectedVersion: number) => boolean;
}) {
  return {
    getGoalContext() {
      const { ownerId: _ownerId, attemptId: _attemptId, ...visible } = deps.goals.planningContext(deps.context, deps.isCurrentRun);
      return visible;
    },
    workspaceForTask(input: unknown) {
      const { taskId } = z.strictObject({ taskId: z.string().min(1).max(200) }).parse(input);
      const bound = deps.goals.planningContext(deps.context, deps.isCurrentRun);
      const reference = goalWorkspaceRef(bound.workstreamId, taskId);
      if (!deps.canUseWorkspace(reference)) throw new Error("task workspace is unavailable or unauthorized");
      return { workspaceRef: reference };
    },
    submitPlan(input: unknown) {
      const args = submitSchema.parse(input);
      const bound = deps.goals.planningContext(deps.context, deps.isCurrentRun);
      const plan = parseGoalPlan({ ...args, goalId: bound.goalId, ownerId: bound.ownerId, sourceAttemptId: bound.attemptId });
      for (const task of plan.tasks) {
        if (!deps.canAssignBot(task.assigneeBotId)) throw new Error("task assignee is unavailable or unauthorized");
        if (!deps.canUseWorkspace(task.workspaceRef)) throw new Error("task workspace is unavailable or unauthorized");
      }
      return deps.goals.submitPlanFromRun(plan, deps.context, deps.isCurrentRun, deps.allowVersionAdvance);
    },
  };
}
