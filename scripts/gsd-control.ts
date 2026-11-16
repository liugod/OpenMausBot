import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openGsdControl } from "../server/goals/gsd-control.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = resolve(process.env.OMB_GSD_STATE_DIR || join(root, ".persistent-work-trial", "gsd-integration"));
if (process.env.OMB_GSD_STATE_DIR && (process.env.OMB_TEST_GSD_BRIDGE !== "1" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(process.env.OMB_TEST_GSD_BASE || ""))) throw new Error("isolated state requires an explicit fixture endpoint");
const [action, ...args] = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1] || options.has(args[i]!)) throw new Error("invalid arguments");
  options.set(args[i]!, args[i + 1]!);
}
const taskId = options.get("--task"), commandId = options.get("--command"), assignmentId = options.get("--assignment"), ownerId = "local-owner";
if (!taskId) throw new Error("--task is required");
const control = openGsdControl(dirname(stateRoot));
try {
  let result: unknown;
  if (action === "register" && options.size === 2 && assignmentId) result = control.registerRun({ taskId, ownerId, assignmentId });
  else if (action === "request" && options.size === 4 && commandId && options.get("--kind") && options.get("--request")) {
    const kind = options.get("--kind");
    if (kind !== "change" && kind !== "pause" && kind !== "resume") throw new Error("invalid command kind");
    result = control.request({ taskId, ownerId, commandId, kind, request: options.get("--request")! });
  } else if (action === "reserve" && options.size === 2 && commandId) result = control.reserve({ taskId, ownerId, commandId });
  else if (action === "attach" && options.size === 3 && commandId && assignmentId) result = control.attach({ taskId, ownerId, commandId, assignmentId });
  else if (action === "reconcile" && options.size === 2 && commandId) result = control.reconcile({ taskId, ownerId, commandId });
  else if (action === "confirm-change" && options.size === 3 && commandId && options.get("--note")) result = control.confirmChange({ taskId, ownerId, commandId, note: options.get("--note")! });
  else if (action === "rebase-change" && options.size === 3 && commandId && options.get("--note")) result = control.rebaseChange({ taskId, ownerId, commandId, note: options.get("--note")! });
  else if (action === "review-handoff" && options.size === 3 && commandId && options.get("--note")) result = control.reviewHandoff({ taskId, ownerId, commandId, note: options.get("--note")! });
  else if (action === "dismiss" && options.size === 3 && commandId && options.get("--note")) result = control.dismissUncertain({ taskId, ownerId, commandId, note: options.get("--note")! });
  else if (action === "cancel" && options.size === 2 && commandId) result = control.cancelPending({ taskId, ownerId, commandId });
  else if (action === "status" && options.size === 1) result = control.inspect(taskId, ownerId);
  else throw new Error("invalid action or options");
  console.log(JSON.stringify(result));
} finally { control.close(); }
