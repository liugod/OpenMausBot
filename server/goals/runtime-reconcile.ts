import type { GoalRuntimeStore } from "./runtime-port.ts";
import type { openGoalStore } from "./goal-store.ts";

export function reconcileRuntimePage(goals: ReturnType<typeof openGoalStore>, runtime: GoalRuntimeStore, limit = 100): number {
  const cursor = goals.runtimeCursor();
  const events = runtime.transitions(cursor, limit);
  for (const event of events) {
    const root = runtime.root(event.assignmentId);
    if (!root) throw new Error(`runtime event ${event.id} has no assignment root`);
    if (runtime.isClientRoot(root.id)) goals.applyRuntimeTransition(event.id, root, runtime.clientRootHeld(root.id));
  }
  const next = events.at(-1)?.id ?? cursor;
  goals.advanceRuntimeCursor(cursor, next);
  return events.length;
}
