import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

type Area = { id: string; name: string; status: string };
type Stream = { id: string; areaId: string; name: string; kind: "project" | "ongoing"; status: string };
type Work = { taskId: string; title: string; status: string; itemId?: string; goalId?: string; blocker?: string; workstreamId: string };
type Bot = { id: string; name: string; hidden?: boolean; modelSelection?: { instanceId: string } };
type Artifact = { id: string; logicalName: string };
const botLabel = (bot: Bot) => bot.name === "目标助手" ? "执行专员（目标助手）"
  : bot.name === "MausBot" ? "协作负责人（MausBot）" : bot.name;
const call = async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  return await res.json() as T;
};
const status: Record<string, string> = { planned: "待执行", ready: "排队中", running: "执行中", checking: "检查与复核", succeeded: "已完成", blocked: "受阻", waiting_user: "需要处理", cancelled: "已取消" };
const routeId = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ":");
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500";
const button = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
export function PersistentWorkTrial() {
  const [areas, setAreas] = useState<Area[]>([]), [streams, setStreams] = useState<Stream[]>([]), [bots, setBots] = useState<Bot[]>([]), [items, setItems] = useState<Work[]>([]);
  const [areaId, setArea] = useState(""), [streamId, setStream] = useState(""), [botId, setBot] = useState("");
  const [areaName, setAreaName] = useState(""), [streamName, setStreamName] = useState(""), [kind, setKind] = useState<"project" | "ongoing">("project");
  const [title, setTitle] = useState(""), [brief, setBrief] = useState(""), [fileName, setFileName] = useState("result.txt");
  const [limit, setLimit] = useState(12), [period, setPeriod] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [refresh, setRefresh] = useState(0);
  const [details, setDetails] = useState<Record<string, Artifact[]>>({});
  const pendingCommand = useRef<{ fingerprint: string; id: string } | null>(null);
  const selected = streams.find(s => s.id === streamId);
  const reload = useCallback(async () => {
    const [scopes, list, overview] = await Promise.all([call<{areas:Area[];workstreams:Stream[]}>("/api/persistent-work/scopes"), call<{bots:Bot[]}>("/api/bots"), call<{items:Work[]}>("/api/persistent-work/overview")]);
    setAreas(scopes.areas); setStreams(scopes.workstreams); setBots(list.bots.filter(b => !b.hidden && b.modelSelection?.instanceId === "codex")); setItems(overview.items);
  }, []);
  useEffect(() => { void reload().catch(() => setMessage("无法连接本机服务。")); const timer = setInterval(() => { void reload().catch(() => {}); }, 5000); return () => clearInterval(timer); }, [reload, refresh]);
  useEffect(() => {
    if (botId) return;
    const preferred = bots.find(bot => bot.name === "目标助手") ?? (bots.length === 1 ? bots[0] : undefined);
    if (preferred) setBot(preferred.id);
  }, [botId, bots]);
  async function perform(fn: () => Promise<void>) { setBusy(true); setMessage(""); try { await fn(); await reload(); } catch (e) { setMessage(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } }
  const addArea = (e: FormEvent) => { e.preventDefault(); void perform(async () => { const x = await call<{id:string}>("/api/persistent-work/areas", "POST", { name: areaName }); setArea(x.id); setAreaName(""); }); };
  const addStream = (e: FormEvent) => { e.preventDefault(); void perform(async () => { const x = await call<{id:string}>("/api/persistent-work/workstreams", "POST", { areaId, name: streamName, kind }); setStream(x.id); setStreamName(""); }); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (!selected) return; const fingerprint = JSON.stringify([streamId, botId, title, brief, fileName, limit, period]);
    if (pendingCommand.current?.fingerprint !== fingerprint) pendingCommand.current = { fingerprint, id: crypto.randomUUID() };
    const commandId = pendingCommand.current.id; void perform(async () => {
    await call("/api/persistent-work/budgets/global", "PUT", { limit });
    if (selected.kind === "ongoing") await call("/api/persistent-work/budgets/period", "PUT", { workstreamId: streamId, periodKey: period, limit });
    await call("/api/persistent-work/items", "POST", { commandId, workstreamId: streamId, assigneeBotId: botId, title, brief: `${brief}\n请将最终成果保存为 ${fileName}，并登记为 result。`, executionLimit: limit,
      ...(selected.kind === "ongoing" ? { budgetPeriod: period } : {}), criteria: [
        { id: "file", description: "已登记实际成果文件", required: true, kind: "artifact_exists", config: { logicalName: "result" } },
        { id: "review", description: `成果符合任务要求：${brief}`, required: true, kind: "lead_review", config: {} },
      ] });
    pendingCommand.current = null; setTitle(""); setBrief(""); setMessage("已提交，系统会自动执行和复核。"); setRefresh(v => v + 1);
  }); };
  async function showFiles(item: Work) { const type = item.itemId ? "items" : "goals", id = item.itemId ?? item.goalId; if (!id) return; try {
    const data = await call<{artifacts:Artifact[]}>(`/api/persistent-work/${type}/${routeId(id)}`);
    setDetails(previous => ({ ...previous, [item.taskId]: data.artifacts ?? [] }));
  } catch { setMessage("无法读取成果。"); } }
  return <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900"><div className="mx-auto max-w-5xl space-y-6">
    <header><p className="text-sm font-semibold text-blue-700">OPENMAUSBOT · 本机试用</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">把任务交给目标助手</h1><p className="mt-2 text-sm text-slate-600">告诉助手要做什么，它会生成文件、检查并复核；完成后你可以下载。</p><a href="/index.html?persistent-work=1" className="mt-3 inline-block text-sm font-medium text-blue-700 underline">打开聊天界面（新入口试用）</a></header>
    {items.length > 0 && <section aria-labelledby="work-progress" className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3"><div><h2 id="work-progress" className="text-lg font-semibold">已提交的任务</h2><p className="mt-1 text-sm text-slate-600">任务提交后会自动处理，不用重复提交。</p></div><button className="shrink-0 text-sm text-blue-700" onClick={() => setRefresh(v => v + 1)}>刷新状态</button></div>
      <ul className="mt-3 divide-y divide-slate-100">{items.map(item => { const type = item.itemId ? "items" : "goals", id = item.itemId ?? item.goalId; return <li key={item.taskId} className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{item.title}</span><span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">{status[item.status] ?? item.status}</span></div>
        {item.status === "succeeded" && id ? <div className="mt-2"><p className="text-sm text-emerald-700">已完成并通过复核。点击下方按钮，再点文件名下载。</p><button className="mt-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800" onClick={() => void showFiles(item)}>查看成果文件</button>
          {details[item.taskId] && (details[item.taskId]!.length ? <ul className="mt-2 space-y-1">{details[item.taskId]!.map(a => <li key={a.id}><a className="text-sm font-medium text-blue-700 underline" href={`/api/persistent-work/${type}/${routeId(id)}/artifacts/${encodeURIComponent(a.id)}`}>{a.logicalName} · 点击下载</a></li>)}</ul> : <p className="mt-2 text-sm text-slate-600">暂未找到可下载的成果。</p>)}</div>
          : <p className="mt-2 text-sm text-slate-600">{item.status === "checking" ? "正在检查并复核成果，请稍等。" : item.status === "running" ? "助手正在处理，请稍等。" : item.status === "blocked" ? "任务遇到问题，暂时无法继续。" : item.status === "waiting_user" ? "任务需要你的进一步说明。" : "任务已提交，等待处理。"}</p>}
      </li>; })}</ul>
    </section>}
    <section aria-labelledby="getting-started" className="rounded-2xl border border-blue-100 bg-blue-50 p-5 text-slate-800">
      <h2 id="getting-started" className="text-base font-semibold">第一次使用？照这三步就可以</h2>
      <ol className="mt-3 grid gap-3 text-sm leading-6 md:grid-cols-3">
        <li><strong>1. 建分类。</strong>创建“工作范围”和里面的“项目”；已有的可以直接选。</li>
        <li><strong>2. 交任务。</strong>选择项目和负责本次任务的助手，写清楚要做什么、怎样算完成。</li>
        <li><strong>3. 拿成果。</strong>提交后看页面上方的任务状态，完成后点击“查看成果文件”，再点文件名下载。</li>
      </ol>
      <p className="mt-3 text-xs leading-5 text-slate-600">例如：范围填“市场研究”，项目填“行业简报”，任务写“把我提供的文字整理成简报，列出三点结论”。</p>
      <p className="mt-1 text-xs leading-5 text-slate-600">持续事务目前仍需每次手动提交，不会自动定时执行。试用数据单独保存在本机。</p>
    </section>
    <div className="grid gap-5 md:grid-cols-2"><section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-semibold">1. 选择或创建工作分类</h2><p className="mt-1 text-sm leading-6 text-slate-600">工作范围是大分类，项目是分类下的一件事。</p><form onSubmit={addArea} className="mt-3 flex gap-2"><input required className={input} placeholder="例如：市场研究" value={areaName} onChange={e => setAreaName(e.target.value)} /><button className={`${button} shrink-0 whitespace-nowrap`} disabled={busy}>创建</button></form>
    <label className="mt-4 block text-sm">选择已有范围，或先在上方创建<select className={`${input} mt-1`} value={areaId} onChange={e => {setArea(e.target.value);setStream("");}}><option value="">请选择</option>{areas.filter(a => a.status === "active").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    {areaId && <form onSubmit={addStream} className="mt-3 space-y-2"><p className="text-sm text-slate-600">首次使用这个范围？在这里创建一个项目。</p><input className={input} required placeholder="例如：每周简报" value={streamName} onChange={e => setStreamName(e.target.value)} /><div className="flex gap-2"><select className={input} value={kind} onChange={e => setKind(e.target.value as "project" | "ongoing")}><option value="project">项目</option><option value="ongoing">持续事务</option></select><button className={`${button} whitespace-nowrap`} disabled={busy}>{kind === "ongoing" ? "创建持续事务" : "创建项目"}</button></div></form>}</section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-semibold">2. 交代要做什么</h2><p className="mt-1 text-sm leading-6 text-slate-600">选择项目，写清楚要求，助手会完成并检查成果。</p><form onSubmit={submit} className="mt-3 space-y-3"><select required className={input} value={streamId} onChange={e => setStream(e.target.value)}><option value="">选择项目或持续事务</option>{streams.filter(s => s.areaId === areaId && s.status === "active").map(s => <option key={s.id} value={s.id}>{s.name}（{s.kind === "ongoing" ? "持续" : "项目"}）</option>)}</select>
    <label className="block text-sm text-slate-700">谁来负责这次任务？
      <select required className={`${input} mt-1`} value={botId} onChange={e => setBot(e.target.value)}><option value="">选择助手</option>{bots.map(b => <option key={b.id} value={b.id}>{botLabel(b)}</option>)}</select>
    </label>
    <p className="text-xs leading-5 text-slate-500">执行专员适合具体任务；协作负责人是系统自带的负责人助手。这里只是选择本次任务由谁执行和复核，不会自动组成上下级团队。</p>
    <input required className={input} placeholder="事项名称" value={title} onChange={e => setTitle(e.target.value)} /><textarea required className={`${input} min-h-28`} placeholder="说明希望完成什么，以及怎样才算完成" value={brief} onChange={e => setBrief(e.target.value)} />
    <details className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"><summary className="cursor-pointer font-medium text-slate-700">更多设置（通常不用修改）</summary>
      <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs text-slate-600">成果文件名<input required className={`${input} mt-1`} value={fileName} onChange={e => setFileName(e.target.value)} /></label><label className="text-xs text-slate-600">总执行次数上限<input className={`${input} mt-1`} type="number" min="1" max="100" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label></div>
      {selected?.kind === "ongoing" && <label className="mt-2 block text-xs text-slate-600">本次预算周期<input className={`${input} mt-1`} value={period} onChange={e => setPeriod(e.target.value)} /></label>}
      <p className="mt-2 text-xs leading-5 text-slate-500">默认使用 result.txt。次数上限同时限制本次事项和所有试用事项的累计运行；助手执行和复核会占用次数。</p>
    </details>
    <button className={button} disabled={busy || !selected || !botId}>提交并开始</button>{!selected && <p className="text-xs text-slate-500">请先在左侧创建或选择范围，再选择项目。</p>}</form></section></div>
    {message && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{message}</p>}

  </div></main>;
}
