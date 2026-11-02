import { useEffect, useState, type FormEvent } from "react";
import { FolderKanban, Plus } from "lucide-react";
import { activeLocale } from "@/lib/i18n";

type Area = { id: string; name: string; status: string };
type Workstream = { id: string; areaId: string; name: string; kind: "project" | "ongoing"; status: string };
type Item = { taskId: string; title: string; status: string; areaId: string; workstreamId: string; blocker?: string };
type Scopes = { areas: Area[]; workstreams: Workstream[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

export function PersistentWorkPreview() {
  const enabled = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("persistent-work-preview") === "1";
  const chinese = activeLocale().startsWith("zh");
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [areaId, setAreaId] = useState("");
  const [open, setOpen] = useState(false);
  const [areaName, setAreaName] = useState("");
  const [streamName, setStreamName] = useState("");
  const [kind, setKind] = useState<"project" | "ongoing">("ongoing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void request<Scopes>("/api/persistent-work/scopes", { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setScopes(result); }).catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  useEffect(() => {
    if (!open || !scopes) return;
    const controller = new AbortController();
    const query = areaId ? `?areaId=${encodeURIComponent(areaId)}` : "";
    void request<{ items: Item[] }>(`/api/persistent-work/overview${query}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setItems(result.items); setError(""); } }).catch(() => { if (!controller.signal.aborted) setError(chinese ? "无法读取事项。" : "Could not load work items."); });
    return () => controller.abort();
  }, [areaId, chinese, open, scopes]);
  if (!enabled || !scopes) return null;

  const reload = async () => setScopes(await request<Scopes>("/api/persistent-work/scopes"));
  const addArea = async (event: FormEvent) => {
    event.preventDefault();
    if (!areaName.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const created = await request<{ id: string }>("/api/persistent-work/areas", { method: "POST", body: JSON.stringify({ name: areaName.trim() }) });
      setAreaName(""); setItems([]); setAreaId(created.id); await reload();
    } catch { setError(chinese ? "无法创建工作范围，请重试。" : "Could not create the area. Try again."); }
    finally { setBusy(false); }
  };
  const addStream = async (event: FormEvent) => {
    event.preventDefault();
    if (!areaId || !streamName.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await request("/api/persistent-work/workstreams", { method: "POST", body: JSON.stringify({ areaId, name: streamName.trim(), kind }) });
      setStreamName(""); await reload();
    } catch { setError(chinese ? "无法创建工作事务，请检查范围状态。" : "Could not create the workstream. Check the area status."); }
    finally { setBusy(false); }
  };
  const visibleStreams = scopes.workstreams.filter(stream => !areaId || stream.areaId === areaId);
  const statuses: Record<string, string> = chinese ? { planned: "待开始", ready: "待执行", running: "执行中", checking: "检查中", waiting_user: "需要你", blocked: "受阻", succeeded: "已完成", cancelled: "已取消" }
    : { planned: "Planned", ready: "Ready", running: "In progress", checking: "Checking", waiting_user: "Needs you", blocked: "Blocked", succeeded: "Done", cancelled: "Cancelled" };
  const inputClass = "min-w-0 rounded-md border border-hairline bg-app px-2 py-1.5 text-[12px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus";
  return <div className="rounded-lg border border-hairline/60 bg-panel text-ink" data-persistent-work-preview="">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      <FolderKanban size={15} aria-hidden="true" /><span className="flex-1">{chinese ? "工作范围" : "Work areas"}</span>
      <span className="text-[11px] font-normal text-ink-secondary">{chinese ? "预览" : "Preview"}</span>
    </button>
    {open && <div className="space-y-3 border-t border-hairline/50 p-3 text-[12px]">
      <label className="block space-y-1"><span className="text-ink-secondary">{chinese ? "筛选范围" : "Filter by area"}</span>
        <select className={`${inputClass} w-full`} value={areaId} onChange={event => { setItems([]); setAreaId(event.target.value); }}>
          <option value="">{chinese ? "全部范围" : "All areas"}</option>
          {scopes.areas.filter(area => area.status !== "archived").map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select>
      </label>
      <div><p className="mb-1 font-medium">{chinese ? "项目与持续事务" : "Projects and ongoing work"}</p>
        {visibleStreams.length ? <ul className="space-y-1">{visibleStreams.map(stream => <li key={stream.id} className="flex gap-2 text-ink-secondary">
          <span className="min-w-0 flex-1 truncate text-ink">{stream.name}</span><span>{stream.status === "paused" ? (chinese ? "已暂停" : "Paused")
            : stream.kind === "ongoing" ? (chinese ? "持续" : "Ongoing") : (chinese ? "项目" : "Project")}</span>
        </li>)}</ul> : <p className="text-ink-secondary">{chinese ? "还没有项目或持续事务。" : "No projects or ongoing work yet."}</p>}
      </div>
      <div><p className="mb-1 font-medium">{chinese ? "事项" : "Work items"}</p>
        {items.length ? <ul className="space-y-1.5">{items.map(item => <li key={item.taskId} className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words">{item.title}</span><span className="shrink-0 text-ink-secondary">{statuses[item.status] ?? item.status}</span>
        </li>)}</ul> : <p className="text-ink-secondary">{chinese ? "当前没有事项。" : "No work items yet."}</p>}
      </div>
      <form onSubmit={addArea} className="flex gap-1.5">
        <input className={`${inputClass} flex-1`} value={areaName} maxLength={200} onChange={event => setAreaName(event.target.value)}
          aria-label={chinese ? "新工作范围名称" : "New area name"} placeholder={chinese ? "新工作范围" : "New area"} />
        <button className="rounded-md bg-raised px-2 text-ink hover:bg-menu-hover disabled:opacity-50" disabled={busy || !areaName.trim()} aria-label={chinese ? "创建范围" : "Create area"}><Plus size={14} /></button>
      </form>
      {areaId && <form onSubmit={addStream} className="space-y-1.5">
        <input className={`${inputClass} w-full`} value={streamName} maxLength={200} onChange={event => setStreamName(event.target.value)}
          aria-label={chinese ? "新事务名称" : "New workstream name"} placeholder={chinese ? "新项目或持续事务" : "New project or ongoing work"} />
        <div className="flex gap-1.5"><select className={`${inputClass} flex-1`} aria-label={chinese ? "事务类型" : "Workstream type"} value={kind}
          onChange={event => setKind(event.target.value as "project" | "ongoing")}><option value="ongoing">{chinese ? "持续事务" : "Ongoing"}</option><option value="project">{chinese ? "项目" : "Project"}</option></select>
          <button className="rounded-md bg-raised px-2 text-ink hover:bg-menu-hover disabled:opacity-50" disabled={busy || !streamName.trim()}>{chinese ? "创建" : "Create"}</button></div>
      </form>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>}
  </div>;
}
