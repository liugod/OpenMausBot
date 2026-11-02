import { z } from "zod";
import { captureArtifact } from "./artifacts.ts";
import type { GoalRunContext, openGoalStore } from "./goal-store.ts";

export function createReviewTools(deps: {
  goals: ReturnType<typeof openGoalStore>;
  context: GoalRunContext;
  isCurrentRun: (context: GoalRunContext) => boolean;
  resolveAuthorizedRoots: (workspaceRef: string) => readonly string[];
  allowVersionAdvance?: (expectedVersion: number) => boolean;
}) {
  return {
    getReviewContext() {
      const { ownerId: _owner, attemptId: _attempt, goalId, standalone, ...visible } = deps.goals.reviewContext(deps.context, deps.isCurrentRun);
      return standalone ? visible : { ...visible, goalId };
    },
    async readArtifact(input: unknown) {
      const args = z.strictObject({ artifactId: z.string().min(1), offset: z.number().int().nonnegative(),
        length: z.number().int().min(1).max(65536) }).parse(input);
      const before = deps.goals.reviewContext(deps.context, deps.isCurrentRun);
      const artifact = before.evidence.artifacts.find(item => item.id === args.artifactId);
      if (!artifact || artifact.bytes > 64 * 1024 * 1024) throw new Error("review artifact is unavailable");
      const content = await captureArtifact(artifact, deps.resolveAuthorizedRoots(before.evidence.workspaceRef), 64 * 1024 * 1024);
      const after = deps.goals.reviewContext(deps.context, deps.isCurrentRun);
      if (before.attemptId !== after.attemptId || JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) throw new Error("review evidence changed");
      return { artifactId: artifact.id, sha256: artifact.sha256, offset: args.offset, bytes: artifact.bytes,
        data: content.subarray(args.offset, args.offset + args.length).toString("base64") };
    },
    submitReview(input: unknown) {
      const bound = deps.goals.reviewContext(deps.context, deps.isCurrentRun);
      const result = deps.goals.submitReviewFromRun(input, deps.context, deps.isCurrentRun, deps.allowVersionAdvance);
      if (!bound.standalone) return result;
      const { goalId: _goal, ...visible } = result;
      return visible;
    },
  };
}
