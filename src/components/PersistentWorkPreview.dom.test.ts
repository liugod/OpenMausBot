// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { PersistentWorkPreview } from "./PersistentWorkPreview";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  setLocale("en");
});

describe("persistent work sidebar preview", () => {
  it("stays hidden and makes no request without the explicit preview", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(PersistentWorkPreview)));
    expect(host.textContent).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows scoped work after the user opens the panel", async () => {
    window.history.replaceState(null, "", "/?persistent-work-preview=1"); setLocale("zh-CN");
    const fetcher = vi.fn(async (path: string) => ({ ok: true, json: async () => path.includes("overview")
      ? { items: [{ taskId: "t", title: "本周简报", status: "running", areaId: "a", workstreamId: "w" }] }
      : { areas: [{ id: "a", name: "业务研究", status: "active" }], workstreams: [{ id: "w", areaId: "a", name: "市场简报", kind: "ongoing", status: "active" }] } }));
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(createElement(PersistentWorkPreview)); await Promise.resolve(); });
    const button = host.querySelector<HTMLButtonElement>("[data-persistent-work-preview] button")!;
    expect(button.textContent).toContain("工作范围");
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(host.textContent).toContain("市场简报");
    expect(host.textContent).toContain("本周简报");
    expect(host.textContent).toContain("执行中");
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});
