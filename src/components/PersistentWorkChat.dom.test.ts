// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentWorkChat } from "./PersistentWorkChat";

afterEach(() => vi.unstubAllGlobals());

it("shows only the current bot's tasks and opens the reviewed report", async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path.endsWith("/overview")) return { ok: true, json: async () => ({ items: [
      { taskId: "t", itemId: "item:one", title: "研究报告", status: "succeeded", assigneeBotId: "bot" },
      { taskId: "other", itemId: "item:two", title: "另一个助手的任务", status: "succeeded", assigneeBotId: "other" },
      { taskId: "other-thread", itemId: "item:three", title: "另一个对话的任务", status: "succeeded", assigneeBotId: "bot", sourceThreadId: "other-thread" },
    ] }) };
    if (path.includes("?preview=1")) return { ok: true, text: async () => "# 结论\n\n实际内容" };
    return { ok: true, json: async () => ({ task: { status: "succeeded" }, artifacts: [{ id: "a", logicalName: "报告" }] }) };
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentWorkChat, { botId: "bot", threadId: "current-thread" })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("研究报告"); expect(host.textContent).not.toContain("另一个助手的任务"); expect(host.textContent).not.toContain("另一个对话的任务");
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "查看报告")!;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('aside[aria-label="成果报告"]')?.textContent).toContain("实际内容");
    expect(fetcher).toHaveBeenCalledWith("/api/persistent-work/items/item:one/artifacts/a?preview=1");
    expect(host.querySelector("aside a")?.getAttribute("href")).toBe("/api/persistent-work/items/item:one/artifacts/a");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="关闭报告"]')!.click(); });
    expect(host.querySelector("aside")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("does not preview if the task changed after the status list was loaded", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/overview")
    ? { ok: true, json: async () => ({ items: [{ taskId: "t", itemId: "item:one", title: "报告", status: "succeeded", assigneeBotId: "bot" }] }) }
    : { ok: true, json: async () => ({ task: { status: "blocked" }, artifacts: [{ id: "a", logicalName: "报告" }] }) }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentWorkChat, { botId: "bot" })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector("aside")?.textContent).toContain("任务状态已变化");
    expect(host.querySelector("aside a")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps the task and report area visible as a desktop column", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/overview")
    ? { ok: true, json: async () => ({ items: [{ taskId: "t", itemId: "item:one", title: "报告", status: "succeeded", assigneeBotId: "bot" }] }) }
    : path.includes("?preview=1") ? { ok: true, text: async () => "报告内容" }
    : { ok: true, json: async () => ({ task: { status: "succeeded" }, artifacts: [{ id: "a", logicalName: "result.md" }] }) }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentWorkChat, { botId: "bot", panel: true })); await Promise.resolve(); await Promise.resolve(); });
    const panel = host.querySelector<HTMLElement>('[data-persistent-work-panel]')!;
    expect(panel.textContent).toContain("成果报告");
    await act(async () => { panel.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(panel.querySelector('aside[aria-label="成果报告"]')?.textContent).toContain("报告内容");
    await act(async () => { panel.querySelector<HTMLButtonElement>('button[aria-label="关闭报告"]')!.click(); });
    expect(panel.textContent).toContain("成果报告");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
