import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PersistentTaskContinuation } from "./PersistentTaskContinuation";
import { FileText, X } from "lucide-react";

type Work = { taskId: string; title: string; status: string; assigneeBotId: string; sourceThreadId?: string; itemId?: string; goalId?: string };
type Artifact = { id: string; logicalName: string; taskId?: string; revision?: number };
const labels: Record<string, string> = { planned: "待执行", ready: "排队中", running: "执行中", checking: "检查与复核", succeeded: "已完成", blocked: "受阻", waiting_user: "需要你", cancelled: "已取消" };
const routeId = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ":");
const workPath = (work: Work) => `/api/persistent-work/${work.itemId ? "items" : "goals"}/${routeId(work.itemId ?? work.goalId ?? "")}`;

export function PersistentWorkChat({ botId, threadId, panel = false }: { botId: string; threadId?: string; panel?: boolean }) {
  const [items, setItems] = useState<Work[]>([]);
  const [selected, setSelected] = useState<Work | null>(null);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const requestSeq = useRef(0);
  const available = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!available.current) return;
    try {
      const response = await fetch("/api/persistent-work/overview", { signal });
      if (!response.ok) { if (response.status === 403 || response.status === 404) available.current = false; if (!signal?.aborted) setFetchFailed(true); return; }
      const data = await response.json() as { items: Work[] };
      if (!signal?.aborted) { setFetchFailed(false); setItems(data.items.filter(item => item.assigneeBotId === botId && (!item.sourceThreadId || item.sourceThreadId === threadId))); }
    } catch { if (!signal?.aborted) setFetchFailed(true); }
  }, [botId, threadId]);
  useEffect(() => {
    const controller = new AbortController(); void refresh(controller.signal);
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(controller.signal); }, 5000);
    const changed = () => void refresh(controller.signal); window.addEventListener("persistent-work-changed", changed);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("persistent-work-changed", changed); };
  }, [refresh]);
  useEffect(() => { requestSeq.current++; setSelected(null); setFiles([]); setContent(""); setError(""); }, [botId, threadId]);
  useEffect(() => {
    const current = selected && items.find(item => item.taskId === selected.taskId);
    if (current && current.status !== "succeeded") { requestSeq.current++; setSelected(null); }
  }, [items, selected]);
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { requestSeq.current++; setSelected(null); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const open = async (item: Work) => {
    const seq = ++requestSeq.current;
    setSelected(item); setFiles([]); setContent(""); setError(""); setLoading(true);
    try {
      const detail = await fetch(workPath(item));
      if (!detail.ok) throw new Error("无法读取任务成果。");
      const result = await detail.json() as { artifacts?: Artifact[]; task?: { status: string }; tasks?: { id: string; status: string }[] };
      if (seq !== requestSeq.current) return;
      const taskStatus = item.itemId ? result.task?.status : result.tasks?.find(task => task.id === item.taskId)?.status;
      if (taskStatus !== "succeeded") throw new Error("任务状态已变化，请刷新后查看。");
      const candidates = (result.artifacts ?? []).filter(file => !file.taskId || file.taskId === item.taskId);
      const approved = candidates.filter(file => !candidates.some(other => other.logicalName === file.logicalName && (other.revision ?? 0) > (file.revision ?? 0)));
      setFiles(approved);
      if (!approved.length) throw new Error("暂时没有可查看的成果文件。");
      const response = await fetch(`${workPath(item)}/artifacts/${encodeURIComponent(approved[0]!.id)}?preview=1`);
      if (response.status === 415) throw new Error("这个文件暂不支持在线预览，可以下载查看。");
      if (!response.ok) throw new Error("无法预览成果，可尝试下载。");
      const text = await response.text();
      if (seq === requestSeq.current) setContent(text);
    } catch (reason) { if (seq === requestSeq.current) setError(reason instanceof Error ? reason.message : "无法读取任务成果。"); }
    finally { if (seq === requestSeq.current) setLoading(false); }
  };
  if (!panel && !items.length && !selected) return null;
  const taskList = <section aria-label="该助手的任务" className={panel ? "shrink-0 border-b border-hairline p-4 text-sm" : "mx-5 mb-2 rounded-xl border border-hairline bg-panel p-3 text-sm"} data-persistent-work-chat="">
      <div className="mb-2 flex items-center justify-between gap-2"><span className="font-medium">该助手的任务</span><span className="text-xs text-ink-secondary">{items.length} 项</span></div>
      {fetchFailed && <p role="status" className="mb-2 text-xs text-ink-secondary">暂时无法刷新任务，请检查服务连接。</p>}
      {!items.length && !fetchFailed && <p className="text-xs leading-5 text-ink-secondary">还没有任务。在对话框写下要求，点击“交办为任务”。</p>}
      <ul className="space-y-2">{(showAll ? items : items.slice(-3)).map(item => <li key={item.taskId} className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{item.title}</span><span className="text-xs text-ink-secondary">{labels[item.status] ?? item.status}</span>
        {item.status === "succeeded" && (item.itemId || item.goalId) && <button type="button" className="rounded-md px-2 py-1 text-accent hover:bg-raised" onClick={() => void open(item)}>查看报告</button>}
        {["succeeded", "blocked"].includes(item.status) && (item.itemId || item.goalId) && <PersistentTaskContinuation path={workPath(item)} taskId={item.taskId}
          blocked={item.status === "blocked"} onChanged={() => { void refresh(); window.dispatchEvent(new Event("persistent-work-changed")); }} />}
      </li>)}</ul>
      {items.length > 3 && <button type="button" className="mt-2 text-xs text-accent" onClick={() => setShowAll(!showAll)}>{showAll ? "收起任务" : `显示全部 ${items.length} 项`}</button>}
    </section>;
  const report = selected && <aside aria-label="成果报告" className={panel ? "flex min-h-0 flex-1 flex-col" : "fixed inset-y-0 right-0 z-[100] flex w-full max-w-[32rem] flex-col border-l border-hairline bg-app shadow-xl"}>
      <header className="flex items-start gap-3 border-b border-hairline p-4"><FileText size={19} aria-hidden="true" className="mt-1 shrink-0" /><div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold">{selected.title}</h2><p className="mt-1 text-xs text-ink-secondary">已完成 · 已复核</p></div><button type="button" aria-label="关闭报告" className="rounded-md p-1 hover:bg-raised" onClick={() => { requestSeq.current++; setSelected(null); }}><X size={19} /></button></header>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4" aria-live="polite">
        {loading ? <p className="text-sm text-ink-secondary">正在读取成果…</p> : error ? <p role="status" className="text-sm text-ink-secondary">{error}</p>
          : <div className="chat-md break-words text-sm leading-6"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{content}</Markdown></div>}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-hairline p-4"><button type="button" className="rounded-lg bg-raised px-3 py-2 text-sm hover:bg-menu-hover" onClick={() => { requestSeq.current++; setSelected(null); }}>回到对话</button>
        {files.map(file => <a key={file.id} className="rounded-lg px-3 py-2 text-sm text-accent hover:bg-raised" href={`${workPath(selected)}/artifacts/${encodeURIComponent(file.id)}`}>下载 {file.logicalName}</a>)}
      </footer>
    </aside>;
  if (panel) return <aside aria-label="任务与成果" className="hidden h-full w-80 shrink-0 flex-col border-l border-hairline bg-panel lg:flex" data-persistent-work-panel="">
    {taskList}{report || <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-ink-secondary"><FileText size={24} aria-hidden="true" /><p className="mt-3 text-sm font-medium text-ink">成果报告</p><p className="mt-2 text-xs leading-5">任务完成并通过复核后，点击“查看报告”，在这里阅读。</p></div>}
  </aside>;
  return <>{taskList}{report}</>;
}
