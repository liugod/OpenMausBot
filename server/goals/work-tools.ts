import { createHash } from "node:crypto";
import { z } from "zod";

import type { GoalRunContext, openGoalStore } from "./goal-store.ts";

const artifactInput = z.strictObject({ commandId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
  logicalName: z.string().min(1), reference: z.string().min(1) });
const inputChunk = z.strictObject({ artifactId: z.string().min(1), offset: z.number().int().nonnegative(), length: z.number().int().min(1).max(65536) });

function artifactId(attemptId: string, commandId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["goal-artifact", attemptId, commandId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWorkTools(deps: {
  goals: ReturnType<typeof openGoalStore>;
  context: GoalRunContext;
  isCurrentRun: (context: GoalRunContext) => boolean;
  resolveAuthorizedRoots: (workspaceRef: string) => readonly string[];
  allowVersionAdvance?: (expectedVersion: number) => boolean;
}) {
  return {
    saveCheckpoint(input: unknown) {
      const bound = deps.goals.workContext(deps.context, deps.isCurrentRun);
      const result = deps.goals.saveTaskCheckpoint(input, deps.context, deps.isCurrentRun);
      if (!bound.standalone) return result;
      const { goalId: _goalId, ...visible } = result;
      return visible;
    },
    listInputs() {
      return deps.goals.listWorkInputs(deps.context, deps.isCurrentRun);
    },
    readInput(input: unknown) {
      const args = inputChunk.parse(input);
      return deps.goals.readWorkInput(deps.context, deps.isCurrentRun, args.artifactId, args.offset, args.length);
    },
    getGoalContext() {
      const { ownerId: _ownerId, attemptId: _attemptId, goalId, standalone, ...visible } = deps.goals.workContext(deps.context, deps.isCurrentRun);
      return standalone ? { ...visible } : { ...visible, goalId };
    },
    async registerArtifact(input: unknown) {
      const args = artifactInput.parse(input);
      const bound = deps.goals.workContext(deps.context, deps.isCurrentRun);
      const id = artifactId(bound.attemptId, args.commandId);
      const result = await deps.goals.registerArtifact({ ...args, ownerId: bound.ownerId, goalId: bound.goalId,
        taskId: bound.taskId, attemptId: bound.attemptId, artifactId: id }, deps.resolveAuthorizedRoots, () => deps.isCurrentRun(deps.context), () => {
        if (args.expectedVersion !== bound.version) return false;
        try {
          const current = deps.goals.workContext(deps.context, deps.isCurrentRun);
          return current.goalId === bound.goalId && current.taskId === bound.taskId && current.attemptId === bound.attemptId &&
            current.requirementRevision === bound.requirementRevision && current.planRevision === bound.planRevision;
        } catch { return false; }
      });
      if (!bound.standalone) return result;
      const { goalId: _goalId, ...visible } = result;
      return visible;
    },
    submitTaskResult(input: unknown) {
      const bound = deps.goals.workContext(deps.context, deps.isCurrentRun);
      const result = deps.goals.submitTaskResultFromRun(input, deps.context, deps.isCurrentRun, deps.allowVersionAdvance);
      if (!bound.standalone) return result;
      const { goalId: _goalId, ...visible } = result;
      return visible;
    },
  };
}
