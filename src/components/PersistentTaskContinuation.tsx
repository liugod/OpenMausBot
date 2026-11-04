import { useEffect, useRef, useState } from "react";

export function PersistentTaskContinuation({ path, taskId, blocked, onChanged }: {
  path: string; taskId: string; blocked: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const operation = useRef<{ action: string; instruction: string; body: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(`${path}/tasks/${encodeURIComponent(taskId)}/continuation`, { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const state = await response.json() as { checkpoint?: { summary: string; nextStep: string } };
      if (!controller.signal.aborted && state.checkpoint) setNote(`${state.checkpoint.summary} 下一步：${state.checkpoint.nextStep}`);
    }).catch(() => {});
    return () => controller.abort();
  }, [open, path, taskId]);
  const submit = async (action: "resume" | "amend") => {
    if (busy || !checked || !instruction.trim()) return;
    setBusy(true); setError("");
    try {
      if (!operation.current || operation.current.action !== action || operation.current.instruction !== instruction) {
        const response = await fetch(path);
        if (!response.ok) throw new Error("无法读取任务，请刷新后重试。");
        const detail = await response.json() as { version: number };
        operation.current = { action, instruction, body: JSON.stringify({ commandId: crypto.randomUUID(), expectedVersion: detail.version,
          instruction: instruction.trim(), externalStateChecked: true }) };
      }
      const response = await fetch(`${path}/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: operation.current.body });
      if (!response.ok) {
        operation.current = null;
        throw new Error("任务仍在运行、状态已变化或停止未确认，请刷新后重试。");
      }
      operation.current = null; setOpen(false); setInstruction(""); setChecked(false); onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法更新任务。"); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="rounded-md px-2 py-1 text-accent hover:bg-raised" onClick={() => setOpen(!open)}>{blocked ? "继续处理" : "补充要求"}</button>
    {open && <form className="w-full space-y-2 rounded-lg bg-raised p-3" aria-label="继续任务" onSubmit={event => { event.preventDefault(); void submit("amend"); }}>
      {note && <p className="text-xs text-ink-secondary">上次进度记录（尚待核实）：{note}</p>}
      <label className="block">补充要求或下一步<textarea value={instruction} maxLength={8000} required disabled={busy}
        onChange={event => setInstruction(event.target.value)} className="mt-1 w-full rounded border border-hairline bg-panel p-2" /></label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} />我已核对现有文件及已发生的外部操作，按此继续。</label>
      <div className="flex gap-2"><button type="submit" disabled={busy || !checked || !instruction.trim()} className="rounded bg-panel px-3 py-2">提交补充要求</button>
        {blocked && <button type="button" disabled={busy || !checked || !instruction.trim()} className="rounded bg-panel px-3 py-2" onClick={() => void submit("resume")}>按原要求续跑</button>}</div>
      {error && <p role="status">{error}</p>}
    </form>}
  </>;
}
