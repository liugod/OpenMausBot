import type { Runtime } from "../runtime/runtime.ts";
import type { RuntimeStore } from "../runtime/store.ts";

export type GoalRuntime = Pick<Runtime, "open" | "tick" | "enqueueClientRoot" | "cancelClientRoot"> & Partial<Pick<Runtime, "clientRootStopped">>;
export type GoalRuntimeStore = Pick<RuntimeStore, "transitions" | "root" | "isClientRoot" | "clientRootHeld" | "clientRequest" | "get">;

export interface GoalRuntimePort {
  runtime: GoalRuntime;
  runtimeStore: GoalRuntimeStore;
  activate(): void;
  deactivate(): void;
}
