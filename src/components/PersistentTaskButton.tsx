import { useEffect, useRef, useState } from "react";

type Props = { botId: string; threadId: string; text: string; hasAttachments: boolean; disabled: boolean; onSubmitted: (text: string) => void };
export function PersistentTaskButton({ botId, threadId, text, hasAttachments, disabled, onSubmitted }: Props) {
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [limit, setLimit] = useState(12);
  const [budget, setBudget] = useState<{ limit: number; used: number } | null>(null), [message, setMessage] = useState("");
  const [globalLimit, setGlobalLimit] = useState(12);
  const command = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/persistent-work/capabilities", { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const capabilities = await response.json() as { chatTasks: boolean };
      if (!controller.signal.aborted) setEnabled(capabilities.chatTasks === true);
      if (capabilities.chatTasks) {
        const response = await fetch("/api/persistent-work/budgets", { signal: controller.signal });
        if (response.ok && !controller.signal.aborted) {
          const current = (await response.json() as { global: { limit: number; used: number } | null }).global;
          setBudget(current); if (current) setGlobalLimit(current.limit);
        }
      }
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!enabled) return null;
  const submit = async () => {
    const request = text.trim();
    if (!request || busy || disabled || hasAttachments) return;
    const key = JSON.stringify([botId, threadId, request, limit]);
    if (command.current?.key !== key) command.current = { key, id: crypto.randomUUID() };
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/persistent-work/chat-tasks", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: command.current.id, botId, threadId, request, executionLimit: limit }) });
      if (!response.ok) throw new Error("任务没有提交成功，请检查预算或稍后重试；输入内容仍在。");
      command.current = null; onSubmitted(text); setMessage("任务已提交，可在上方查看进度。");
      window.dispatchEvent(new Event("persistent-work-changed"));
      void fetch("/api/persistent-work/budgets").then(async responseBudget => {
        if (responseBudget.ok) setBudget((await responseBudget.json() as { global: { limit: number; used: number } | null }).global);
      }).catch(() => {});
    } catch (error) { setMessage(error instanceof Error ? error.message : "任务没有提交成功，输入内容仍在。"); }
    finally { setBusy(false); }
  };
  const saveGlobal = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/persistent-work/budgets/global", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: globalLimit }) });
      if (!response.ok) throw new Error("总上限没有保存成功。");
      setBudget(current => ({ limit: globalLimit, used: current?.used ?? 0 }));
      setMessage("总执行上限已更新。");
      void fetch("/api/persistent-work/budgets").then(async current => {
        if (current.ok) setBudget((await current.json() as { global: { limit: number; used: number } | null }).global);
      }).catch(() => {});
    } catch (error) { setMessage(error instanceof Error ? error.message : "总上限没有保存成功。"); }
    finally { setBusy(false); }
  };
  return <div className="pointer-events-auto mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary" data-persistent-task-button="">
    <button type="button" className="rounded-lg border border-hairline bg-panel px-3 py-1.5 font-medium text-ink hover:bg-raised disabled:opacity-50"
      disabled={disabled || busy || !text.trim() || hasAttachments} onClick={() => void submit()}>{busy ? "正在交办…" : "交办为任务"}</button>
    <span>未分类 · 本次最多 {limit} 次 · {budget ? `总上限 ${budget.limit} 次，已用 ${budget.used} 次` : `首次总上限 ${limit} 次`}</span>
    <details className="relative"><summary className="cursor-pointer">任务设置</summary>
      <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-hairline bg-panel p-3 shadow-lg">
        <p>归属：未分类。此入口暂不支持更改归属。</p>
        <label className="mt-2 flex items-center gap-2">本次执行上限 <input aria-label="本次执行上限" type="number" min={1} max={100} value={limit}
          onChange={event => setLimit(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} className="w-16 rounded border border-hairline bg-app px-1 py-1" /> 次</label>
        <p className="mt-2">{budget ? `总执行上限 ${budget.limit} 次，已用 ${budget.used} 次。` : `首次交办将同时设置总上限为 ${limit} 次。`}</p>
        {budget && <div className="mt-2 flex items-center gap-2"><label className="flex items-center gap-2">调整总上限 <input aria-label="总执行上限" type="number" min={0} max={10000} value={globalLimit}
          onChange={event => setGlobalLimit(Math.min(10000, Math.max(0, Number(event.target.value) || 0)))} className="w-20 rounded border border-hairline bg-app px-1 py-1" /></label><button type="button" disabled={busy} onClick={() => void saveGlobal()} className="rounded border border-hairline px-2 py-1">保存</button></div>}
        <p className="mt-1">上限计算的是执行次数，不是费用。已有总上限不会因交办新任务被覆盖。</p>
      </div>
    </details>
    {hasAttachments && <span>任务入口暂不支持附件，可先用普通聊天。</span>}
    {message && <span role="status">{message}</span>}
  </div>;
}
