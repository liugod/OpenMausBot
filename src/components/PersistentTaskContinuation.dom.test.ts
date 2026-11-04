// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentTaskContinuation } from "./PersistentTaskContinuation";

afterEach(() => vi.unstubAllGlobals());

it("continues the same item after inspecting its note and sends only explicit owner input", async () => {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith("/continuation")) return { ok: true, json: async () => ({ checkpoint: { summary: "已有草稿", nextStep: "核实来源" } }) };
    if (options?.method === "POST") return { ok: true };
    return { ok: true, json: async () => ({ version: 7 }) };
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const changed = vi.fn();
  try {
    await act(async () => root.render(createElement(PersistentTaskContinuation, { path: "/api/persistent-work/items/item:one", taskId: "task:one", blocked: true, onChanged: changed })));
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    expect(host.textContent).toContain("尚待核实"); expect(host.textContent).toContain("已有草稿");
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "先检查现有草稿");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const resume = [...host.querySelectorAll("button")].find(button => button.textContent === "按原要求续跑")!;
    expect(resume.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(resume.disabled).toBe(false);
    await act(async () => { resume.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const posted = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(posted[0]).toBe("/api/persistent-work/items/item:one/tasks/task%3Aone/resume");
    expect(JSON.parse(String(posted[1]!.body))).toMatchObject({ expectedVersion: 7, externalStateChecked: true, instruction: "先检查现有草稿" });
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
