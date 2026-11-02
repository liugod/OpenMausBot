// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentWorkTrial } from "./PersistentWorkTrial";

it("submits a scoped item with an explicit execution budget", async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const data = path.endsWith("/scopes") ? { areas: [{ id: "a", name: "Area", status: "active" }], workstreams: [{ id: "w", areaId: "a", name: "Project", kind: "project", status: "active" }] }
      : path.endsWith("/bots") ? { bots: [{ id: "b", name: "目标助手", modelSelection: { instanceId: "codex" } }, { id: "chief", name: "MausBot", modelSelection: { instanceId: "codex" } }] }
        : path.endsWith("/overview") ? { items: [] } : { itemId: "i" };
    return { ok: true, json: async () => data };
  }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentWorkTrial)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("第一次使用？照这三步就可以");
    expect(host.textContent).toContain("完成后点击“查看成果文件”，再点文件名下载");
    expect(host.querySelector("details")?.open).toBe(false);
    expect(host.textContent).toContain("执行专员（目标助手）");
    expect(host.textContent).toContain("协作负责人（MausBot）");
    expect(host.textContent).toContain("不会自动组成上下级团队");
    const change = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
      await act(async () => { const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
    };
    let selects = host.querySelectorAll("select"); await change(selects[0]!, "a"); selects = host.querySelectorAll("select");
    await change(selects[2]!, "w"); await change(selects[3]!, "b");
    await change(host.querySelector<HTMLInputElement>('input[placeholder="事项名称"]')!, "Brief");
    await change(host.querySelector<HTMLTextAreaElement>("textarea")!, "Write a brief");
    await act(async () => { host.querySelectorAll("form")[2]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.find(x => x.path.endsWith("/budgets/global") && x.method === "PUT")?.body).toEqual({ limit: 12 });
    expect(calls.find(x => x.path.endsWith("/items") && x.method === "POST")?.body).toMatchObject({ workstreamId: "w", assigneeBotId: "b", title: "Brief", executionLimit: 12 });
    expect(host.textContent).toContain("已提交");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
it("shows completed work first and loads its approved file with the correct item address", async () => {
  const fetcher = vi.fn(async (path: string) => {
    const data = path.endsWith("/scopes") ? { areas: [], workstreams: [] } : path.endsWith("/bots") ? { bots: [] }
      : path.endsWith("/overview") ? { items: [{ taskId: "t", itemId: "item:one", title: "Research", status: "succeeded", workstreamId: "w" }] }
        : { artifacts: [{ id: "a", logicalName: "result" }] };
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentWorkTrial)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent?.indexOf("已提交的任务")).toBeLessThan(host.textContent!.indexOf("第一次使用"));
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "查看成果文件")!;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledWith("/api/persistent-work/items/item:one", expect.anything());
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/api/persistent-work/items/item:one/artifacts/a");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
afterEach(() => vi.unstubAllGlobals());
