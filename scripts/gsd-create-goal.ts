import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openGoalStore } from "../server/goals/goal-store.ts";
import { syncGsdGoals } from "../server/goals/gsd-sync.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = resolve(process.env.OMB_GSD_STATE_DIR || join(root, ".persistent-work-trial", "gsd-integration"));
const args = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1] || options.has(args[i]!)) throw new Error("invalid arguments");
  options.set(args[i]!, args[i + 1]!);
}
const taskId = options.get("--task"), title = options.get("--title"), request = options.get("--request"), existingGoal = options.get("--goal");
if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(taskId) || !(existingGoal ? options.size === 2 : options.size === 3 && title && request)) throw new Error("usage: --task <id> --goal <existing goal id> OR --task <id> --title <title> --request <request>");
const hash = createHash("sha256").update(taskId).digest("hex");
const meta = JSON.parse(readFileSync(join(stateRoot, "runs", `${hash}.json`), "utf8")) as { taskId: string; state: string; worktree: string };
if (meta.taskId !== taskId || meta.state !== "ready" || realpathSync(meta.worktree) !== realpathSync(join(stateRoot, "worktrees", hash))) throw new Error("GSD task not ready or workspace mismatch");
const testBase = process.env.OMB_TEST_GSD_BRIDGE === "1" ? process.env.OMB_TEST_GSD_BASE : undefined;
if (testBase && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(testBase)) throw new Error("test endpoint must be loopback");
if (process.env.OMB_GSD_STATE_DIR && !testBase) throw new Error("an isolated GSD state directory requires an explicit fixture endpoint");
const base = testBase || "http://127.0.0.1:19753";
const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
if (!health.ok || (await health.json() as { app?: string }).app !== "openmausbot") throw new Error("OpenMausBot unavailable");
const response = await fetch(`${base}/api/bots?messages=0`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error("bot roster unavailable");
const roster = await response.json() as { bots: Array<{ id: string; threadId: string; chiefOfStaff?: boolean; hidden?: boolean }> };
const chiefs = roster.bots.filter(bot => bot.chiefOfStaff && !bot.hidden);
if (chiefs.length !== 1 || !chiefs[0]?.threadId) throw new Error("expected one chief with a thread");
const dataDir = dirname(stateRoot), goals = openGoalStore(join(dataDir, "goals.db"));
try {
  const goal = existingGoal ? goals.bindGsdGoal({ taskId, goalId: existingGoal, ownerId: "local-owner", viewerBotId: chiefs[0].id }) :
    goals.createGsdGoal({ taskId, ownerId: "local-owner", title: title!, request: request!, leadBotId: chiefs[0].id, leadThreadId: chiefs[0].threadId });
  await syncGsdGoals(dataDir, goals);
  console.log(JSON.stringify({ ...goal, gsd: goals.read(goal.goalId, "local-owner")?.gsd }));
} finally { goals.close(); }
