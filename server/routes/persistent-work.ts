import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { openGoalStore } from "../goals/goal-store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { taskChangeSchema } from "../goals/task-continuity.ts";
import { PASS, type RouteHandler } from "./table.ts";

const name = z.string().trim().min(1).max(200);
const id = z.string().min(1).max(200);
function pathId(value: string): string | undefined {
  try { const decoded = decodeURIComponent(value); return /^[\w:-]{1,200}$/.test(decoded) ? decoded : undefined; }
  catch { return undefined; }
}
const newArea = z.strictObject({ name, defaultLeadBotId: id.optional() });
const newStream = z.strictObject({ areaId: id, name, kind: z.enum(["project", "ongoing"]) });
const createGoal = z.strictObject({ commandId: id, workstreamId: id, leadBotId: id, title: name, request: z.string().trim().min(1).max(8000), executionLimit: z.number().int().min(1).max(100) });
const itemCriterion = z.strictObject({ id, description: z.string().trim().min(1).max(1000), required: z.boolean(),
  kind: z.enum(["artifact_exists", "json_schema", "lead_review"]), config: z.record(z.string(), z.unknown()) });
const createItem = z.strictObject({ commandId: id, workstreamId: id, assigneeBotId: id, title: name,
  brief: z.string().trim().min(1).max(8000), executionLimit: z.number().int().min(1).max(100),
  budgetPeriod: id.optional(), criteria: z.array(itemCriterion).min(1).max(20) });
const chatTask = z.strictObject({ commandId: id, botId: id, threadId: id, request: z.string().trim().min(1).max(8000), executionLimit: z.number().int().min(1).max(100) });
const globalBudget = z.strictObject({ limit: z.number().int().nonnegative().safe() });
const periodBudget = z.strictObject({ workstreamId: id, periodKey: id, limit: z.number().int().nonnegative().safe() });
const change = z.strictObject({ expectedVersion: z.number().int().positive(), name: name.optional(),
  status: z.enum(["active", "paused", "completed", "archived"]).optional() });

export function createPersistentWorkRoutes(deps: {
  goals: ReturnType<typeof openGoalStore>;
  confirmStopped?: (rootId: string) => boolean;
  ownerFor: (auth: RequestAuth) => string | undefined;
  createGoal?: (ownerId: string, input: z.infer<typeof createGoal>) => { goalId: string; version: number };
  createItem?: (ownerId: string, input: z.infer<typeof createItem>) => { itemId: string; version: number };
  createChatTask?: (ownerId: string, input: z.infer<typeof chatTask>) => { itemId: string; version: number };
}): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (!path.startsWith("/api/persistent-work/")) return PASS;
    const ownerId = deps.ownerFor(auth);
    if (!ownerId) return json(res, 403, { error: "owner authorization required" });
    if (path === "/api/persistent-work/capabilities") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, { chatTasks: Boolean(deps.createChatTask) });
    }
    if (path === "/api/persistent-work/chat-tasks" && deps.createChatTask) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const parsed = chatTask.safeParse(await readBody(req, 16_384));
      if (!parsed.success) return json(res, 400, { error: "invalid task" });
      try { return json(res, 201, deps.createChatTask(ownerId, parsed.data)); }
      catch { return json(res, 409, { error: "task could not be created" }); }
    }
    const continuation = /^\/api\/persistent-work\/(goals|items)\/([\w:%-]+)\/tasks\/([\w:%-]+)\/(continuation|resume|amend)$/.exec(path);
    if (continuation && deps.createGoal && deps.createItem && deps.confirmStopped) {
      const [, kind, encodedGoal, encodedTask, action] = continuation;
      const goalId = pathId(encodedGoal!), taskId = pathId(encodedTask!);
      if (!goalId || !taskId) return json(res, 404, { error: "not found" });
      const standalone = deps.goals.readStandalone(goalId, ownerId);
      const state = deps.goals.readTaskContinuation(goalId, taskId, ownerId);
      if (!state || (kind === "items") !== Boolean(standalone)) return json(res, 404, { error: "not found" });
      if (action === "continuation") return method === "GET" ? json(res, 200, state) : json(res, 405, { error: "method not allowed" });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const input = taskChangeSchema.safeParse(await readBody(req, 16_384));
      if (!input.success) return json(res, 400, { error: "invalid task update" });
      try { return json(res, 200, deps.goals.changeTask(input.data, { goalId, taskId, ownerId }, action === "amend" ? "amend" : "resume", deps.confirmStopped)); }
      catch { return json(res, 409, { error: "task changed, is still running, or its stop is unconfirmed; refresh before retrying" }); }
    }
    const download = /^\/api\/persistent-work\/(goals|items)\/([\w:%-]+)\/artifacts\/([\w:%-]+)$/.exec(path);
    if (download && deps.createGoal && deps.createItem) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const [, kind] = download;
      const containerId = pathId(download[2]!), artifactId = pathId(download[3]!);
      if (!containerId || !artifactId) return json(res, 404, { error: "not found" });
      const standalone = deps.goals.readStandalone(containerId, ownerId);
      if ((kind === "items") !== Boolean(standalone)) return json(res, 404, { error: "not found" });
      const goal = deps.goals.read(containerId, ownerId);
      const artifact = goal?.artifacts.find(entry => entry.id === artifactId);
      const bytes = artifact && deps.goals.readArtifactSnapshot({ goalId: containerId, ownerId, artifactId: artifact.id });
      if (!artifact || !bytes) return json(res, 404, { error: "approved artifact not found" });
      const originalName = artifact.reference.split(/[\\/]/).pop() || "artifact";
      if (url.searchParams.get("preview") === "1") {
        if (bytes.length > 2 * 1024 * 1024 || !/\.(?:txt|md|markdown|csv|json|log)$/i.test(originalName)) return json(res, 415, { error: "preview unavailable" });
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return json(res, 415, { error: "preview unavailable" }); }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(text)),
          "x-content-type-options": "nosniff", "cache-control": "no-store" });
        res.end(text);
        return;
      }
      const safeName = Array.from(originalName, char => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127 ? "_" : char).join("").slice(0, 180);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(Buffer.from(safeName, "utf8").toString("utf8"))}`,
        "x-content-type-options": "nosniff", "x-omb-sha256": artifact.sha256 });
      res.end(bytes);
      return;
    }
    if (path === "/api/persistent-work/goals" && deps.createGoal) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const parsed = createGoal.safeParse(await readBody(req, 16_384));
      if (!parsed.success) return json(res, 400, { error: "invalid goal" });
      try { return json(res, 201, deps.createGoal(ownerId, parsed.data)); }
      catch { return json(res, 409, { error: "goal could not be created" }); }
    }
    const goalMatch = /^\/api\/persistent-work\/goals\/([\w:%-]+)$/.exec(path);
    if (goalMatch && deps.createGoal) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const goalId = pathId(goalMatch[1]!);
      if (!goalId) return json(res, 404, { error: "not found" });
      const goal = deps.goals.readStandalone(goalId, ownerId) ? undefined : deps.goals.read(goalId, ownerId);
      return goal ? json(res, 200, goal) : json(res, 404, { error: "not found" });
    }
    if (path === "/api/persistent-work/items" && deps.createItem) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const parsed = createItem.safeParse(await readBody(req, 16_384));
      if (!parsed.success) return json(res, 400, { error: "invalid item" });
      try { return json(res, 201, deps.createItem(ownerId, parsed.data)); }
      catch { return json(res, 409, { error: "item could not be created" }); }
    }
    const itemMatch = /^\/api\/persistent-work\/items\/([\w:%-]+)$/.exec(path);
    if (itemMatch && deps.createItem) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const itemId = pathId(itemMatch[1]!);
      if (!itemId) return json(res, 404, { error: "not found" });
      const item = deps.goals.readStandalone(itemId, ownerId);
      return item ? json(res, 200, item) : json(res, 404, { error: "not found" });
    }
    if (path === "/api/persistent-work/budgets") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, deps.goals.scopes.budgets(ownerId));
    }
    if (path === "/api/persistent-work/budgets/global" || path === "/api/persistent-work/budgets/period") {
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      const isGlobal = path.endsWith("/global"), raw = await readBody(req, 16_384);
      try {
        if (isGlobal) deps.goals.scopes.setGlobalBudget({ ownerId, ...globalBudget.parse(raw) });
        else deps.goals.scopes.setPeriodBudget({ ownerId, ...periodBudget.parse(raw) });
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: "budget could not be updated" }); }
    }
    if (path === "/api/persistent-work/scopes") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, deps.goals.scopes.list(ownerId));
    }
    if (path === "/api/persistent-work/overview") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const areaId = url.searchParams.get("areaId") ?? undefined;
      if (areaId !== undefined && !id.safeParse(areaId).success) return json(res, 400, { error: "invalid area" });
      return json(res, 200, { items: deps.goals.scopes.overview(ownerId, areaId) });
    }
    if (path === "/api/persistent-work/areas" || path === "/api/persistent-work/workstreams") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const area = path.endsWith("/areas");
      const raw: unknown = await readBody(req, 16_384);
      const parsed = (area ? newArea : newStream).safeParse(raw);
      if (!parsed.success) return json(res, 400, { error: "invalid scope" });
      const scopeId = randomUUID();
      try {
        if (area) deps.goals.scopes.createArea({ ...newArea.parse(parsed.data), id: scopeId, ownerId });
        else deps.goals.scopes.createWorkstream({ ...newStream.parse(parsed.data), id: scopeId, ownerId });
      } catch { return json(res, 409, { error: "scope could not be created" }); }
      return json(res, 201, { id: scopeId });
    }
    const match = /^\/api\/persistent-work\/(areas|workstreams)\/([\w:-]+)$/.exec(path);
    if (!match) return json(res, 404, { error: "not found" });
    if (method !== "PATCH") return json(res, 405, { error: "method not allowed" });
    const parsed = change.safeParse(await readBody(req, 16_384));
    if (!parsed.success) return json(res, 400, { error: "invalid scope update" });
    try {
      deps.goals.scopes.update({ ...parsed.data, id: match[2]!, ownerId, type: match[1] === "areas" ? "area" : "workstream" });
      return json(res, 200, { ok: true });
    } catch { return json(res, 409, { error: "scope update was rejected" }); }
  };
}
