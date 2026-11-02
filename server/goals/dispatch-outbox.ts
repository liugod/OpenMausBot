import type { EnqueueResult } from "../runtime/types.ts";
import type { GoalRuntime } from "./runtime-port.ts";
import type { DispatchIntent, ExecutionBudgetStore } from "./execution-budget.ts";

export function deliverDispatch(
  key: string,
  store: ExecutionBudgetStore,
  runtime: Pick<GoalRuntime, "enqueueClientRoot">,
  authorize: (intent: DispatchIntent) => true | string,
): EnqueueResult {
  const intent = store.pendingDispatch(key);
  if (!intent) return { ok: false, outcome: "refused", reason: "No pending dispatch" };
  const authorization = authorize(intent);
  if (authorization !== true) return { ok: false, outcome: "refused", reason: authorization };
  const result = runtime.enqueueClientRoot(intent.request);
  if (result.ok) store.acknowledgeDispatch(intent.request.dispatchKey, result.assignment.id);
  return result;
}
