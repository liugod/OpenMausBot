import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { openGoalStore } from "../goals/goal-store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPersistentWorkRoutes } from "./persistent-work.ts";
import { DatabaseSync } from "node:sqlite";
import { PASS, type RouteContext } from "./table.ts";

describe("persistent work routes", () => {
  it("downloads only approved artifacts belonging to the authenticated owner and resource type", async () => {
    let bytes = Buffer.from("approved output"), reference = "result.txt";
    const goals = {
      readStandalone: (id: string, owner: string) => id === "item:one" && owner === "one" ? { task: {} } : undefined,
      read: (id: string, owner: string) => id === "item:one" && owner === "one" ? { artifacts: [{ id: "artifact", reference, sha256: "digest" }] } : undefined,
      readArtifactSnapshot: ({ ownerId, artifactId }: { ownerId: string; artifactId: string }) => ownerId === "one" && artifactId === "artifact" ? bytes : undefined,
    } as unknown as ReturnType<typeof openGoalStore>;
    let owner = "one", status = 0, body: unknown;
    const res = { writeHead: (code: number) => { status = code; }, end: (value: unknown) => { body = value; } } as unknown as ServerResponse;
    const route = createPersistentWorkRoutes({ goals, ownerFor: () => owner, createGoal: () => ({ goalId: "g", version: 1 }),
      createItem: () => ({ itemId: "item:one", version: 1 }) });
    const call = async (target: string) => { const url = new URL(target, "http://127.0.0.1"); return route({ req: {} as IncomingMessage, res, path: url.pathname, url, method: "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, code: number, value: unknown) => { status = code; body = value; }) as RouteContext["json"] }); };
    await call("/api/persistent-work/items/item:one/artifacts/artifact");
    expect(status).toBe(200); expect(body).toEqual(bytes);
    await call("/api/persistent-work/items/item%3Aone/artifacts/artifact"); expect(status).toBe(200); expect(body).toEqual(bytes);
    await call("/api/persistent-work/items/item%3Aone/artifacts/artifact?preview=1"); expect(status).toBe(200); expect(body).toBe("approved output");
    reference = "payload.html"; await call("/api/persistent-work/items/item:one/artifacts/artifact?preview=1"); expect(status).toBe(415);
    reference = "result.txt"; bytes = Buffer.from([0xff]); await call("/api/persistent-work/items/item:one/artifacts/artifact?preview=1"); expect(status).toBe(415);
    bytes = Buffer.alloc(2 * 1024 * 1024 + 1); await call("/api/persistent-work/items/item:one/artifacts/artifact?preview=1"); expect(status).toBe(415);
    await call("/api/persistent-work/items/item%2Fone/artifacts/artifact"); expect(status).toBe(404);
    await call("/api/persistent-work/goals/item:one/artifacts/artifact"); expect(status).toBe(404);
    owner = "two"; await call("/api/persistent-work/items/item:one/artifacts/artifact"); expect(status).toBe(404);
  });
  it("uses host identity, rejects spoofed ownership, and lists only that owner's scopes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-work-route-"));
    const goals = openGoalStore(join(dir, "goals.db"));
    let owner: string | undefined = "one";
    const route = createPersistentWorkRoutes({ goals, ownerFor: () => owner });
    const call = async (method: string, target: string, body: unknown = {}) => {
      const output: { status?: number; body?: any } = {};
      const url = new URL(target, "http://127.0.0.1");
      const result = await route({ req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method,
        auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: (async () => body) as RouteContext["readBody"],
        json: ((_res: ServerResponse, status: number, response: unknown) => { output.status = status; output.body = response; }) as RouteContext["json"] });
      return { result, ...output };
    };
    try {
      expect((await call("GET", "/api/elsewhere")).result).toBe(PASS);
      owner = undefined;
      expect((await call("GET", "/api/persistent-work/scopes")).status).toBe(403);
      owner = "one";
      expect((await call("POST", "/api/persistent-work/areas", { name: "Area", ownerId: "two" })).status).toBe(400);
      const created = await call("POST", "/api/persistent-work/areas", { name: "Area" });
      expect(created.status).toBe(201);
      const areaId = created.body.id as string;
      expect((await call("POST", "/api/persistent-work/workstreams", { areaId, name: "Brief", kind: "ongoing" })).status).toBe(201);
      const streamId = (await call("GET", "/api/persistent-work/scopes")).body.workstreams[0].id as string;
      expect((await call("PUT", "/api/persistent-work/budgets/global", { limit: 20, ownerId: "two" })).status).toBe(400);
      expect((await call("PUT", "/api/persistent-work/budgets/global", { limit: 20 })).status).toBe(200);
      expect((await call("PUT", "/api/persistent-work/budgets/period", { workstreamId: streamId, periodKey: "2026-W45", limit: 5 })).status).toBe(200);
      expect((await call("GET", "/api/persistent-work/budgets")).body).toMatchObject({ global: { limit: 20, used: 0 }, periods: [{ workstreamId: streamId, limit: 5, used: 0 }] });
      expect((await call("GET", "/api/persistent-work/scopes")).body.areas).toHaveLength(1);
      expect((await call("GET", `/api/persistent-work/overview?areaId=${areaId}`)).body.items).toEqual([]);
      expect((await call("PATCH", `/api/persistent-work/areas/${areaId}`, { expectedVersion: 1, status: "paused" })).status).toBe(200);
      expect((await call("PATCH", `/api/persistent-work/areas/${areaId}`, { expectedVersion: 1, status: "active" })).status).toBe(409);
      owner = "two";
      expect((await call("GET", "/api/persistent-work/scopes")).body.areas).toEqual([]);
      expect((await call("GET", "/api/persistent-work/budgets")).body).toEqual({ global: null, periods: [] });
      expect((await call("PUT", "/api/persistent-work/budgets/period", { workstreamId: streamId, periodKey: "2026-W45", limit: 10 })).status).toBe(400);
      expect((await call("POST", "/api/persistent-work/workstreams", { areaId, name: "Other", kind: "project" })).status).toBe(409);
    } finally { goals.close(); await removeTempDir(dir); }
  });
});
it("amends the same owner-scoped task through the route and rejects forged or stale changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-continuation-route-")), path = join(dir, "goals.db");
  const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
  let owner = "owner";
  const route = createPersistentWorkRoutes({ goals, ownerFor: () => owner, confirmStopped: () => true,
    createGoal: () => ({ goalId: "g", version: 1 }), createItem: () => ({ itemId: "item", version: 1 }) });
  const call = async (method: string, target: string, body: unknown = {}) => {
    const output: { status?: number; body?: any } = {}, url = new URL(target, "http://127.0.0.1");
    await route({ req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method,
      auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, response: unknown) => { output.status = status; output.body = response; }) as RouteContext["json"] });
    return output;
  };
  try {
    goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Report", request: "Write report", leadBotId: "bot", leadThreadId: "lead", executionLimit: 4 });
    goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1, sourceAttemptId: "plan", reason: "test",
      tasks: [{ id: "task", title: "Report", brief: "Write report", assigneeBotId: "bot", workspaceRef: "allowed", required: true, dependsOn: [],
        criteria: [{ id: "review", description: "Report", required: true, kind: "lead_review", config: {} }] }] });
    const url = "/api/persistent-work/goals/g/tasks/task", input = { commandId: "change", expectedVersion: 2, instruction: "Add sources", externalStateChecked: true };
    expect((await call("GET", `${url}/continuation`)).body.taskRevision).toBe(1);
    expect((await call("POST", `${url}/amend`, { ...input, ownerId: "other" })).status).toBe(400);
    owner = "other";
    expect((await call("POST", `${url}/amend`, input)).status).toBe(404);
    owner = "owner";
    expect((await call("POST", url.replace("/goals/", "/items/") + "/amend", input)).status).toBe(404);
    const result = await call("POST", `${url}/amend`, input);
    expect(result.status).toBe(200); expect(result.body.affectedTaskIds).toEqual(["task"]);
    expect((await call("POST", `${url}/amend`, input)).body).toEqual(result.body);
    expect((await call("POST", `${url}/amend`, { ...input, commandId: "stale" })).status).toBe(409);
    expect((await call("GET", `${url}/continuation`)).body.taskRevision).toBe(2);
    const raw = new DatabaseSync(path);
    try { expect(Number(raw.prepare("SELECT COUNT(*) AS n FROM goals").get()!.n)).toBe(1); }
    finally { raw.close(); }
  } finally { goals.close(); await removeTempDir(dir); }
});
