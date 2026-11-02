// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentTaskButton } from "./PersistentTaskButton";

afterEach(() => vi.unstubAllGlobals());
it("creates an explicit task in the current conversation and leaves ordinary chat alone", async () => {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith("/capabilities")) return { ok: true, json: async () => ({ chatTasks: true }) };
    if (path.endsWith("/budgets")) return { ok: true, json: async () => ({ global: null }) };
    if (path.endsWith("/chat-tasks")) return { ok: true, json: async () => ({ itemId: "item:1" }) };
    throw new Error(`unexpected ${path} ${options?.method}`);
  });
  vi.stubGlobal("fetch", fetcher); const submitted = vi.fn();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentTaskButton, { botId: "b", threadId: "t", text: "写一份简报", hasAttachments: false, disabled: false, onSubmitted: submitted })); await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher.mock.calls.some(([path]) => path.endsWith("/chat-tasks"))).toBe(false);
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "交办为任务")!;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const creation = fetcher.mock.calls.find(([path]) => path.endsWith("/chat-tasks"))!;
    expect(JSON.parse(String(creation[1]?.body))).toMatchObject({ botId: "b", threadId: "t", request: "写一份简报", executionLimit: 12 });
    expect(submitted).toHaveBeenCalledWith("写一份简报"); expect(host.textContent).toContain("任务已提交");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("disables task submission for attachments until they are supported", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => ({ ok: true, json: async () => path.endsWith("/capabilities") ? { chatTasks: true } : { global: null } })));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PersistentTaskButton, { botId: "b", threadId: "t", text: "处理附件", hasAttachments: true, disabled: false, onSubmitted: vi.fn() })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true); expect(host.textContent).toContain("暂不支持附件");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
