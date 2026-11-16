import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const taskSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const commandSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const mentionsPath = (text: string, path: string) => process.platform === "win32"
  ? text.replaceAll("\\", "/").toLowerCase().includes(path.replaceAll("\\", "/").toLowerCase()) : text.includes(path);

export function openGsdControl(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "goals.db"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  let runtime: DatabaseSync;
  try { runtime = new DatabaseSync(join(dataDir, "runtime.db"), { readOnly: true }); } catch (error) { db.close(); throw error; }
  function tx<T>(fn: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  function event(id: string, kind: string, detail: unknown) { db.prepare("INSERT INTO goal_gsd_command_events(command_id,kind,detail_json,created_at) VALUES (?,?,?,?)").run(id, kind, JSON.stringify(detail), Date.now()); }
  function link(taskId: string, ownerId: string) {
    taskSchema.parse(taskId);
    const row = db.prepare(`SELECT l.task_id, l.goal_id, l.owner_id, COALESCE(l.viewer_bot_id,g.lead_bot_id) AS chief_id
      FROM goal_gsd_links l JOIN goals g ON g.id=l.goal_id AND g.owner_id=l.owner_id WHERE l.task_id=? AND l.owner_id=?`).get(taskId, ownerId);
    if (!row) throw new Error("GSD goal link not found");
    return row;
  }
  function workspace(taskId: string) {
    const hash = digest(taskSchema.parse(taskId)), root = join(dataDir, "gsd-integration"), base = realpathSync(join(root, "worktrees"));
    const meta = JSON.parse(readFileSync(join(root, "runs", `${hash}.json`), "utf8")) as { taskId?: string; state?: string; worktree?: string };
    const tree = realpathSync(join(base, hash)), rel = relative(base, tree);
    if (rel !== hash || isAbsolute(rel) || meta.taskId !== taskId || meta.state !== "ready" || !meta.worktree || realpathSync(meta.worktree) !== tree) throw new Error("GSD workspace identity mismatch");
    return tree;
  }
  function evidence(taskId: string) {
    const tree = workspace(taskId), path = (name: string) => join(tree, ".planning", name);
    const hash = (name: string) => {
      if (!existsSync(path(name))) return null;
      const file = realpathSync(path(name)), rel = relative(tree, file);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || statSync(file).size > 2_000_000) throw new Error("GSD evidence is outside the workspace or too large");
      return digest(readFileSync(file));
    };
    return { roadmap: hash("ROADMAP.md"), handoff: hash("HANDOFF.json"), requirements: hash("REQUIREMENTS.md"), state: hash("STATE.md") };
  }
  function validPauseHandoff(taskId: string) {
    try {
      const handoff = JSON.parse(readFileSync(join(workspace(taskId), ".planning", "HANDOFF.json"), "utf8"));
      return z.object({ version: z.string().min(1), timestamp: z.string().min(1), status: z.literal("paused") }).safeParse(handoff).success;
    } catch { return false; }
  }
  function handoffHasNoOpenJobs(taskId: string) {
    try {
      const handoff = JSON.parse(readFileSync(join(workspace(taskId), ".planning", "HANDOFF.json"), "utf8")) as { async_jobs?: unknown };
      return Array.isArray(handoff.async_jobs) && handoff.async_jobs.every((job: unknown) => {
        if (!job || typeof job !== "object") return false;
        const status = (job as { status?: unknown }).status;
        return typeof status === "string" && ["completed", "succeeded", "failed", "cancelled"].includes(status.toLowerCase());
      });
    } catch { return false; }
  }
  function assignment(id: string) {
    const row = runtime.prepare("SELECT json FROM assignments WHERE id=?").get(id);
    if (!row) throw new Error("coordination assignment not found");
    return JSON.parse(String(row.json)) as { id: string; status: string; brief: string; requester: { botId?: string }; assignee: { botId: string; destination: { threadId: string } } };
  }
  function verifyAssignment(taskId: string, ownerId: string, id: string, marker: string) {
    const owner = link(taskId, ownerId), run = assignment(id);
    if (run.requester.botId !== owner.chief_id || !run.brief.includes(marker) || !mentionsPath(run.brief, workspace(taskId)) || !run.assignee.botId || !run.assignee.destination.threadId) throw new Error("assignment does not match the linked chief and task workspace");
    return run;
  }
  const control = {
    registerRun(input: { taskId: string; ownerId: string; assignmentId: string }) {
      const task = taskSchema.parse(input.taskId), current = verifyAssignment(task, input.ownerId, input.assignmentId, `[[OMB-GSD:${task}]]`);
      return tx(() => {
        const old = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        if (old && old.assignment_id !== input.assignmentId) {
          const previous = assignment(String(old.assignment_id));
          if (previous.status !== "completed") throw new Error("previous assignment did not complete normally; inspect before rebinding");
          if (old.bot_id !== current.assignee.botId || old.thread_id !== current.assignee.destination.threadId) throw new Error("worker thread changed; inspect before rebinding");
        }
        db.prepare(`INSERT INTO goal_gsd_runs(task_id,assignment_id,bot_id,thread_id,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(task_id) DO UPDATE SET assignment_id=excluded.assignment_id, updated_at=excluded.updated_at`).run(task, input.assignmentId, current.assignee.botId, current.assignee.destination.threadId, Date.now());
        return { taskId: task, assignmentId: input.assignmentId, botId: current.assignee.botId, threadId: current.assignee.destination.threadId, status: current.status };
      });
    },
    request(input: { taskId: string; ownerId: string; commandId: string; kind: "change" | "pause" | "resume"; request: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), kind = z.enum(["change", "pause", "resume"]).parse(input.kind);
      const request = z.string().trim().min(1).max(8000).parse(input.request), fingerprint = digest(JSON.stringify([task, input.ownerId, kind, request]));
      link(task, input.ownerId);
      return tx(() => {
        const old = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=?").get(id);
        if (old) { if (old.fingerprint !== fingerprint) throw new Error("command id conflict"); return old; }
        if (!db.prepare("SELECT 1 FROM goal_gsd_runs WHERE task_id=?").get(task)) throw new Error("GSD worker assignment has not been registered");
        if (db.prepare("SELECT 1 FROM goal_gsd_commands WHERE task_id=? AND kind=? AND state IN ('pending','dispatching','delivering','sent','uncertain')").get(task, kind)) throw new Error("another GSD command of this kind is still unresolved");
        const now = Date.now(), baseline = JSON.stringify(evidence(task));
        db.prepare("INSERT INTO goal_gsd_commands VALUES (?,?,?,?,?,?,'pending',NULL,?,NULL,?,?)").run(id, task, input.ownerId, kind, request, fingerprint, baseline, now, now);
        return db.prepare("SELECT * FROM goal_gsd_commands WHERE id=?").get(id)!;
      });
    },
    reserve(input: { taskId: string; ownerId: string; commandId: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId); link(task, input.ownerId);
      return tx(() => {
        const row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        if (!row || row.state !== "pending") throw new Error("command is not pending; reconcile before retrying");
        if (db.prepare("SELECT 1 FROM goal_gsd_commands WHERE task_id=? AND id<>? AND state IN ('dispatching','delivering','sent','uncertain')").get(task, id)) throw new Error("another GSD command is still in flight or needs review");
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task)!;
        const current = assignment(String(run.assignment_id));
        if (row.kind !== "pause" && current.status !== "completed") throw new Error("worker has not completed normally; inspect actual stop before changing or resuming");
        if (row.kind === "pause" && ["completed", "failed", "cancelled"].includes(current.status)) throw new Error("worker has already stopped; no pause was sent");
        const lastControl = row.kind === "resume" ? db.prepare("SELECT kind,state,result_json FROM goal_gsd_commands WHERE task_id=? AND kind IN ('pause','resume') AND state='applied' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(task) : undefined;
        if (row.kind === "resume" && lastControl?.kind !== "pause") throw new Error("no confirmed GSD pause to resume");
        if (row.kind === "resume") {
          const pause = lastControl?.result_json ? JSON.parse(String(lastControl.result_json)) as { handoff?: string } : {};
          if (!pause.handoff || evidence(task).handoff !== pause.handoff || !validPauseHandoff(task)) throw new Error("GSD handoff changed or is unavailable; inspect before resuming");
          if (!handoffHasNoOpenJobs(task)) throw new Error("GSD handoff lists active or unknown external jobs; inspect them before resuming");
        }
        const baseline = JSON.parse(String(row.baseline_json)) as ReturnType<typeof evidence>, currentEvidence = evidence(task);
        if (row.kind === "change" && (currentEvidence.roadmap !== baseline.roadmap || currentEvidence.requirements !== baseline.requirements || currentEvidence.state !== baseline.state)) {
          db.prepare("UPDATE goal_gsd_commands SET state='conflict',updated_at=? WHERE id=?").run(Date.now(), id);
          return { state: "conflict", commandId: id };
        }
        db.prepare("UPDATE goal_gsd_commands SET state='dispatching',updated_at=? WHERE id=?").run(Date.now(), id);
        return { state: "dispatching", commandId: id, taskId: task, kind: String(row.kind), request: String(row.request), botId: String(run.bot_id), threadId: String(run.thread_id), marker: `[[OMB-GSD-CMD:${id}]]`, taskMarker: `[[OMB-GSD:${task}]]`, baseline, worktree: workspace(task) };
      });
    },
    claimDelivery(input: { taskId: string; ownerId: string; commandId: string; chiefId: string; botId: string; threadId: string; message: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), owner = link(task, input.ownerId);
      return tx(() => {
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        const command = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        if (owner.chief_id !== input.chiefId || !run || run.bot_id !== input.botId || run.thread_id !== input.threadId || !command || command.state !== "dispatching") throw new Error("GSD control delivery is not authorized or already claimed");
        if (!input.message.includes(String(command.request)) || !mentionsPath(input.message, workspace(task))) throw new Error("GSD control delivery is missing the user's request or task workspace");
        const baseline = JSON.parse(String(command.baseline_json)) as ReturnType<typeof evidence>, current = evidence(task);
        if (command.kind === "change" && (current.roadmap !== baseline.roadmap || current.requirements !== baseline.requirements || current.state !== baseline.state)) {
          db.prepare("UPDATE goal_gsd_commands SET state='conflict',updated_at=? WHERE id=?").run(Date.now(), id);
          return { kind: "conflict" };
        }
        db.prepare("UPDATE goal_gsd_commands SET state='delivering',updated_at=? WHERE id=?").run(Date.now(), id);
        return { kind: String(command.kind) };
      });
    },
    attach(input: { taskId: string; ownerId: string; commandId: string; assignmentId: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), a = verifyAssignment(task, input.ownerId, input.assignmentId, `[[OMB-GSD-CMD:${id}]]`);
      return tx(() => {
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        const command = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        if (!run || !command || a.assignee.botId !== run.bot_id || a.assignee.destination.threadId !== run.thread_id) throw new Error("command was not sent to the registered worker thread");
        if (!a.brief.includes(`[[OMB-GSD:${task}]]`) || !a.brief.includes(String(command.request))) throw new Error("control assignment is missing its task identity or user request");
        if (command.state === "sent" && command.assignment_id === input.assignmentId) return { state: "sent", assignmentId: input.assignmentId };
        if (command.state !== "delivering") throw new Error("command is not awaiting a dispatch receipt");
        db.prepare("UPDATE goal_gsd_commands SET state='sent',assignment_id=?,updated_at=? WHERE id=?").run(input.assignmentId, Date.now(), id);
        return { state: "sent", assignmentId: input.assignmentId };
      });
    },
    reconcile(input: { taskId: string; ownerId: string; commandId: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId); link(task, input.ownerId);
      return tx(() => {
        let row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        if (!row || !run) throw new Error("command or worker not found");
        if (row.state === "dispatching" || row.state === "delivering") {
          const marker = `[[OMB-GSD-CMD:${id}]]`;
          const candidates = runtime.prepare("SELECT id FROM assignments WHERE assignee_bot_id=? AND assignee_thread_id=? AND json LIKE ? ORDER BY created_at DESC LIMIT 3")
            .all(String(run.bot_id), String(run.thread_id), `%${marker}%`).flatMap(candidate => {
              try { const a = verifyAssignment(task, input.ownerId, String(candidate.id), marker); return a.brief.includes(`[[OMB-GSD:${task}]]`) && a.brief.includes(String(row!.request)) ? [a] : []; } catch { return []; }
            });
          if (candidates.length !== 1) {
            db.prepare("UPDATE goal_gsd_commands SET state='uncertain',result_json=?,updated_at=? WHERE id=?")
              .run(JSON.stringify({ reason: candidates.length ? "multiple dispatches found" : "dispatch outcome unknown; inspect before retry" }), Date.now(), id);
          } else db.prepare("UPDATE goal_gsd_commands SET state='sent',assignment_id=?,updated_at=? WHERE id=?").run(candidates[0]!.id, Date.now(), id);
          row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=?").get(id)!;
        }
        if (row.state !== "sent" || !row.assignment_id) return { state: String(row.state), result: row.result_json ? JSON.parse(String(row.result_json)) as unknown : null };
        const a = assignment(String(row.assignment_id));
        if (["failed", "cancelled"].includes(a.status)) {
          db.prepare("UPDATE goal_gsd_commands SET state='uncertain',result_json=?,updated_at=? WHERE id=?")
            .run(JSON.stringify({ reason: `worker ${a.status}; inspect actual work before retry` }), Date.now(), id);
        } else if (row.kind === "resume" && ["running", "completed"].includes(a.status)) {
          db.prepare("UPDATE goal_gsd_runs SET assignment_id=?,updated_at=? WHERE task_id=?").run(a.id, Date.now(), task);
          db.prepare("UPDATE goal_gsd_commands SET state='applied',result_json=?,updated_at=? WHERE id=?")
            .run(JSON.stringify({ assignmentStatus: a.status, note: "worker started; inspect its GSD execution and external jobs" }), Date.now(), id);
        } else if (a.status === "completed") {
          const before = JSON.parse(String(row.baseline_json)) as ReturnType<typeof evidence>, after = evidence(task);
          const original = assignment(String(run.assignment_id));
          if (row.kind === "pause" && !["completed", "failed", "cancelled"].includes(original.status)) return { state: "sent", assignmentStatus: a.status, result: { reason: "waiting for the original worker to finish" } };
          if (row.kind === "pause" && original.status === "completed" && after.handoff && after.handoff !== before.handoff && validPauseHandoff(task)) {
            db.prepare("UPDATE goal_gsd_commands SET state='applied',result_json=?,updated_at=? WHERE id=?")
              .run(JSON.stringify({ handoff: after.handoff, externalJobs: "unverified" }), Date.now(), id);
          } else if (row.kind === "change" && (before.roadmap !== after.roadmap || before.requirements !== after.requirements)) {
            db.prepare("UPDATE goal_gsd_commands SET state='uncertain',result_json=?,updated_at=? WHERE id=?")
              .run(JSON.stringify({ reason: "planning files changed; chief must review whether they implement the requested change", before, after }), Date.now(), id);
          } else {
            db.prepare("UPDATE goal_gsd_commands SET state='uncertain',result_json=?,updated_at=? WHERE id=?")
              .run(JSON.stringify({ reason: "worker finished without required independent evidence; inspect before retry", before, after }), Date.now(), id);
          }
        }
        row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=?").get(id)!;
        return { state: String(row.state), assignmentStatus: a.status, result: row.result_json ? JSON.parse(String(row.result_json)) as unknown : null };
      });
    },
    confirmChange(input: { taskId: string; ownerId: string; commandId: string; note: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), note = z.string().trim().min(1).max(4000).parse(input.note);
      link(task, input.ownerId);
      return tx(() => {
        const row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        if (!row || row.kind !== "change" || row.state !== "uncertain" || !row.result_json) throw new Error("change is not awaiting review");
        const result = JSON.parse(String(row.result_json)) as { before?: ReturnType<typeof evidence>; after?: ReturnType<typeof evidence> };
        if (!result.before || !result.after || JSON.stringify(evidence(task)) !== JSON.stringify(result.after) ||
          (result.before.roadmap === result.after.roadmap && result.before.requirements === result.after.requirements)) throw new Error("planning files changed again or no change is available for review");
        db.prepare("UPDATE goal_gsd_commands SET state='applied',result_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify({ ...result, review: note }), Date.now(), id);
        event(id, "change_reviewed", { ...result, review: note });
        return { state: "applied", review: note };
      });
    },
    rebaseChange(input: { taskId: string; ownerId: string; commandId: string; note: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), note = z.string().trim().min(1).max(4000).parse(input.note);
      link(task, input.ownerId);
      return tx(() => {
        const row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        if (!row || row.kind !== "change" || !["pending", "conflict"].includes(String(row.state)) || !run) throw new Error("change is not awaiting a new baseline");
        if (assignment(String(run.assignment_id)).status !== "completed") throw new Error("worker has not completed normally");
        if (db.prepare("SELECT 1 FROM goal_gsd_commands WHERE task_id=? AND id<>? AND state IN ('dispatching','delivering','sent','uncertain')").get(task, id)) throw new Error("another command is still in flight or needs review");
        const before = JSON.parse(String(row.baseline_json)) as unknown, after = evidence(task);
        db.prepare("UPDATE goal_gsd_commands SET state='pending',baseline_json=?,result_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(after), JSON.stringify({ rebase: note, before, after }), Date.now(), id);
        event(id, "baseline_reviewed", { review: note, before, after });
        return { state: "pending", baseline: after, review: note };
      });
    },
    reviewHandoff(input: { taskId: string; ownerId: string; commandId: string; note: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), note = z.string().trim().min(1).max(4000).parse(input.note);
      link(task, input.ownerId);
      return tx(() => {
        const pause = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        if (!pause || pause.kind !== "pause" || pause.state !== "applied" || !run || assignment(String(run.assignment_id)).status !== "completed") throw new Error("pause is not settled");
        if (!validPauseHandoff(task) || !handoffHasNoOpenJobs(task)) throw new Error("handoff is invalid or has active or unknown external jobs");
        const current = evidence(task).handoff;
        const previous = pause.result_json ? JSON.parse(String(pause.result_json)) as unknown : null;
        db.prepare("UPDATE goal_gsd_commands SET result_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify({ handoff: current, externalJobs: "reviewed", review: note }), Date.now(), id);
        event(id, "handoff_reviewed", { previous, handoff: current, review: note });
        return { handoff: current, review: note };
      });
    },
    cancelPending(input: { taskId: string; ownerId: string; commandId: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId); link(task, input.ownerId);
      return tx(() => {
        const row = db.prepare("SELECT state FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        if (!row || !["pending", "conflict"].includes(String(row.state))) throw new Error("only an undispatched command can be cancelled");
        db.prepare("UPDATE goal_gsd_commands SET state='cancelled',updated_at=? WHERE id=?").run(Date.now(), id);
        return { state: "cancelled" };
      });
    },
    dismissUncertain(input: { taskId: string; ownerId: string; commandId: string; note: string }) {
      const task = taskSchema.parse(input.taskId), id = commandSchema.parse(input.commandId), note = z.string().trim().min(1).max(4000).parse(input.note);
      link(task, input.ownerId);
      return tx(() => {
        const row = db.prepare("SELECT * FROM goal_gsd_commands WHERE id=? AND task_id=? AND owner_id=?").get(id, task, input.ownerId);
        const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(task);
        if (!row || row.state !== "uncertain" || !run) throw new Error("command is not awaiting review");
        if (assignment(String(run.assignment_id)).status !== "completed") throw new Error("registered worker did not complete normally; verify actual stop before retry");
        const marker = `[[OMB-GSD-CMD:${id}]]`;
        const active = runtime.prepare("SELECT 1 FROM assignments WHERE assignee_bot_id=? AND assignee_thread_id=? AND json LIKE ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1")
          .get(String(run.bot_id), String(run.thread_id), `%${marker}%`);
        if (active) throw new Error("control assignment may still be active");
        db.prepare("UPDATE goal_gsd_commands SET state='cancelled',result_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify({ review: note, previous: row.result_json ? JSON.parse(String(row.result_json)) as unknown : null, current: evidence(task) }), Date.now(), id);
        event(id, "uncertain_reviewed", { review: note, previous: row.result_json ? JSON.parse(String(row.result_json)) as unknown : null, current: evidence(task) });
        return { state: "cancelled", review: note };
      });
    },
    inspect(taskId: string, ownerId: string) {
      const owner = link(taskId, ownerId);
      const run = db.prepare("SELECT * FROM goal_gsd_runs WHERE task_id=?").get(taskId);
      const commands = db.prepare("SELECT id,kind,request,state,assignment_id,baseline_json,result_json,created_at,updated_at FROM goal_gsd_commands WHERE task_id=? AND owner_id=? ORDER BY created_at,id").all(taskId, ownerId);
      return { taskId, chiefId: String(owner.chief_id), run: run ? { assignmentId: String(run.assignment_id), botId: String(run.bot_id), threadId: String(run.thread_id), status: assignment(String(run.assignment_id)).status } : null,
        commands: commands.map(row => ({ id: String(row.id), kind: String(row.kind), request: String(row.request), state: String(row.state),
          assignment_id: row.assignment_id ? String(row.assignment_id) : null, baseline_json: String(row.baseline_json), result_json: row.result_json ? String(row.result_json) : null,
          created_at: Number(row.created_at), updated_at: Number(row.updated_at), assignmentStatus: row.assignment_id ? assignment(String(row.assignment_id)).status : null })) };
    },
    reconcileSent() {
      const rows = db.prepare("SELECT id,task_id,owner_id FROM goal_gsd_commands WHERE state='sent' ORDER BY created_at LIMIT 100").all();
      for (const row of rows) {
        try { control.reconcile({ taskId: String(row.task_id), ownerId: String(row.owner_id), commandId: String(row.id) }); } catch { continue; }
      }
    },
    close() { runtime.close(); db.close(); },
  };
  return control;
}
