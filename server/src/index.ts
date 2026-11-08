// FocusGuard SpacetimeDB module.
// All session state lives here. The desktop app logs window changes; reducers decide
// instantly from cached rules, queue Nemotron "judge" jobs for unknown windows,
// raise interventions (the overlay), and schedule the 10-second iMessage alert.

import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

const ALERT_DELAY_MICROS = 10_000_000n; // 10 s off-task before the agent texts the user

// ---------- Tables ----------

const session = table(
  { name: 'session', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    goal: t.string(),
    minutes: t.u32(),
    phone: t.string(),
    profileJson: t.string(),
    status: t.string(), // 'active' | 'ended'
    startedAt: t.timestamp(),
    endedAt: t.option(t.timestamp()),
    latestEventId: t.u64(),
  }
);

const activityEvent = table(
  { name: 'activity_event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    ts: t.timestamp(),
    app: t.string(),
    title: t.string(),
    url: t.string(),
    verdict: t.string(), // 'pending' | 'on_task' | 'off_task'
    reason: t.string(),
    confidence: t.f32(),
    source: t.string(), // 'rule' | 'judge' | 'pending'
  }
);

const relevanceRule = table(
  { name: 'relevance_rule', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    kind: t.string(), // 'domain' | 'app' | 'keyword'
    pattern: t.string(),
    verdict: t.string(), // 'on_task' | 'off_task'
    source: t.string(), // 'profile' | 'judge'
  }
);

const intervention = table(
  { name: 'intervention', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    eventId: t.u64(),
    distraction: t.string(),
    reason: t.string(),
    shownAt: t.timestamp(),
    resolvedAt: t.option(t.timestamp()),
    alerted: t.bool(),
  }
);

const agentJob = table(
  { name: 'agent_job', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    kind: t.string(), // 'profile' | 'judge' | 'alert' | 'debrief'
    eventId: t.u64(),
    interventionId: t.u64(),
    status: t.string(), // 'queued' | 'running' | 'done' | 'failed'
    createdAt: t.timestamp(),
  }
);

const agentTrace = table(
  { name: 'agent_trace', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    jobId: t.u64(),
    step: t.u32(),
    tool: t.string(),
    args: t.string(),
    result: t.string(),
    ts: t.timestamp(),
  }
);

const sessionSummary = table(
  { name: 'session_summary', public: true },
  {
    sessionId: t.u64().primaryKey(),
    metricsJson: t.string(),
    text: t.string(),
    sent: t.bool(),
    createdAt: t.timestamp(),
  }
);

// Fires 10 s after an intervention is shown.
const alertCheck = table(
  { name: 'alert_check' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    interventionId: t.u64(),
  }
);

// Fires when the session's time box runs out.
const sessionTimer = table(
  { name: 'session_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
  }
);

const spacetimedb = schema({
  session,
  activityEvent,
  relevanceRule,
  intervention,
  agentJob,
  agentTrace,
  sessionSummary,
  alertCheck,
  sessionTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type SessionRow = NonNullable<ReturnType<Ctx['db']['session']['id']['find']>>;
type EventRow = NonNullable<ReturnType<Ctx['db']['activityEvent']['id']['find']>>;

const RuleInput = t.object('RuleInput', {
  kind: t.string(),
  pattern: t.string(),
  verdict: t.string(),
});

// ---------- Helpers ----------

function ownedSession(ctx: Ctx, sessionId: bigint): SessionRow {
  const s = ctx.db.session.id.find(sessionId);
  if (!s) throw new SenderError('session not found');
  if (!s.owner.isEqual(ctx.sender)) throw new SenderError('not your session');
  return s;
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

const BROWSERS = ['google chrome', 'safari', 'arc', 'brave browser', 'microsoft edge', 'firefox', 'chromium', 'opera', 'vivaldi', 'zen'];

// Most specific evidence wins: a keyword in the page title ("dijkstra") beats a whole-domain
// rule (youtube.com), which beats an app rule. Ties go to off_task.
function matchRule(ctx: Ctx, sessionId: bigint, ev: { app: string; title: string; url: string }) {
  const host = hostOf(ev.url);
  const app = norm(ev.app);
  const isBrowser = BROWSERS.includes(app);
  const text = norm(`${ev.title} ${ev.url}`);
  let best: { verdict: string; pattern: string; kind: string; score: number } | undefined;
  for (const r of ctx.db.relevanceRule.sessionId.filter(sessionId)) {
    const p = norm(r.pattern);
    if (!p) continue;
    let score = 0;
    const d = p.replace(/^www\./, '');
    if (r.kind === 'keyword' && p.length >= 3 && text.includes(p)) score = 4;
    else if (r.kind === 'domain' && host && (host === d || host.endsWith('.' + d))) score = 3;
    else if (r.kind === 'app' && app === p && !isBrowser) score = 1; // app rules never cover a browser
    if (score === 0) continue;
    if (r.verdict === 'off_task') score += 0.5;
    if (!best || score > best.score) best = { verdict: r.verdict, pattern: r.pattern, kind: r.kind, score };
  }
  return best;
}

// Reuse an earlier verdict for the exact same window in this session (instant "Back" button).
function rememberedVerdict(ctx: Ctx, sessionId: bigint, ev: { app: string; title: string; url: string }) {
  let found: EventRow | undefined;
  for (const e of ctx.db.activityEvent.sessionId.filter(sessionId)) {
    if (e.verdict !== 'pending' && e.source === 'judge' && e.app === ev.app && e.title === ev.title && e.url === ev.url) {
      if (!found || e.id > found.id) found = e;
    }
  }
  return found;
}

function openIntervention(ctx: Ctx, sessionId: bigint) {
  for (const iv of ctx.db.intervention.sessionId.filter(sessionId)) {
    if (iv.resolvedAt === undefined) return iv;
  }
  return undefined;
}

// React to the verdict of the session's latest (current) window.
function applyVerdict(ctx: Ctx, s: SessionRow, ev: EventRow) {
  if (s.status !== 'active' || ev.id !== s.latestEventId) return;
  const open = openIntervention(ctx, s.id);
  if (ev.verdict === 'on_task' && open) {
    ctx.db.intervention.id.update({ ...open, resolvedAt: ctx.timestamp });
  } else if (ev.verdict === 'off_task' && !open) {
    const iv = ctx.db.intervention.insert({
      id: 0n,
      sessionId: s.id,
      eventId: ev.id,
      distraction: ev.url ? `${hostOf(ev.url)} — ${ev.title}` : `${ev.app} — ${ev.title}`,
      reason: ev.reason,
      shownAt: ctx.timestamp,
      resolvedAt: undefined,
      alerted: false,
    });
    ctx.db.alertCheck.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + ALERT_DELAY_MICROS),
      interventionId: iv.id,
    });
  }
}

function queueJob(ctx: Ctx, sessionId: bigint, kind: string, eventId = 0n, interventionId = 0n) {
  ctx.db.agentJob.insert({ id: 0n, sessionId, kind, eventId, interventionId, status: 'queued', createdAt: ctx.timestamp });
}

function endSessionInternal(ctx: Ctx, s: SessionRow) {
  if (s.status !== 'active') return;
  ctx.db.session.id.update({ ...s, status: 'ended', endedAt: ctx.timestamp });
  const open = openIntervention(ctx, s.id);
  if (open) ctx.db.intervention.id.update({ ...open, resolvedAt: ctx.timestamp });
  queueJob(ctx, s.id, 'debrief');
}

// ---------- Reducers called by the desktop app ----------

export const startSession = spacetimedb.reducer(
  { goal: t.string(), minutes: t.u32(), phone: t.string() },
  (ctx, { goal, minutes, phone }) => {
    if (!goal.trim()) throw new SenderError('goal required');
    if (minutes < 1 || minutes > 600) throw new SenderError('minutes must be 1-600');
    for (const old of ctx.db.session.owner.filter(ctx.sender)) {
      if (old.status === 'active') endSessionInternal(ctx, old);
    }
    const s = ctx.db.session.insert({
      id: 0n,
      owner: ctx.sender,
      goal: goal.trim(),
      minutes,
      phone: phone.trim(),
      profileJson: '',
      status: 'active',
      startedAt: ctx.timestamp,
      endedAt: undefined,
      latestEventId: 0n,
    });
    ctx.db.sessionTimer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + BigInt(minutes) * 60_000_000n),
      sessionId: s.id,
    });
    queueJob(ctx, s.id, 'profile');
  }
);

export const logActivity = spacetimedb.reducer(
  { sessionId: t.u64(), app: t.string(), title: t.string(), url: t.string() },
  (ctx, { sessionId, app, title, url }) => {
    const s = ownedSession(ctx, sessionId);
    if (s.status !== 'active') return;
    const hit = matchRule(ctx, sessionId, { app, title, url });
    const memo = hit ? undefined : rememberedVerdict(ctx, sessionId, { app, title, url });
    const decided = hit
      ? { verdict: hit.verdict, reason: `matched ${hit.kind} rule "${hit.pattern}"`, confidence: 1, source: 'rule' }
      : memo
        ? { verdict: memo.verdict, reason: memo.reason, confidence: memo.confidence, source: 'memory' }
        : { verdict: 'pending', reason: '', confidence: 0, source: 'pending' };
    const ev = ctx.db.activityEvent.insert({ id: 0n, sessionId, ts: ctx.timestamp, app, title, url, ...decided });
    const updated = { ...s, latestEventId: ev.id };
    ctx.db.session.id.update(updated);
    if (decided.verdict === 'pending') queueJob(ctx, sessionId, 'judge', ev.id);
    applyVerdict(ctx, updated, ev);
  }
);

export const endSession = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  endSessionInternal(ctx, ownedSession(ctx, sessionId));
});

// ---------- Reducers called by the agent ----------

export const recordVerdict = spacetimedb.reducer(
  { eventId: t.u64(), verdict: t.string(), reason: t.string(), confidence: t.f32() },
  (ctx, { eventId, verdict, reason, confidence }) => {
    if (verdict !== 'on_task' && verdict !== 'off_task') throw new SenderError('bad verdict');
    const ev = ctx.db.activityEvent.id.find(eventId);
    if (!ev) throw new SenderError('event not found');
    const s = ownedSession(ctx, ev.sessionId);
    const updated = { ...ev, verdict, reason, confidence, source: 'judge' };
    ctx.db.activityEvent.id.update(updated);
    applyVerdict(ctx, s, updated);
  }
);

function upsertRule(ctx: Ctx, sessionId: bigint, kind: string, pattern: string, verdict: string, source: string) {
  const p = norm(pattern);
  if (!p || !['domain', 'app', 'keyword'].includes(kind) || !['on_task', 'off_task'].includes(verdict)) return;
  for (const r of ctx.db.relevanceRule.sessionId.filter(sessionId)) {
    if (r.kind === kind && norm(r.pattern) === p) {
      if (r.verdict !== verdict) ctx.db.relevanceRule.id.update({ ...r, verdict, source });
      return;
    }
  }
  ctx.db.relevanceRule.insert({ id: 0n, sessionId, kind, pattern: p, verdict, source });
}

export const saveRule = spacetimedb.reducer(
  { sessionId: t.u64(), kind: t.string(), pattern: t.string(), verdict: t.string() },
  (ctx, { sessionId, kind, pattern, verdict }) => {
    ownedSession(ctx, sessionId);
    upsertRule(ctx, sessionId, kind, pattern, verdict, 'judge');
  }
);

export const saveProfile = spacetimedb.reducer(
  { sessionId: t.u64(), profileJson: t.string(), rules: t.array(RuleInput) },
  (ctx, { sessionId, profileJson, rules }) => {
    const s = ownedSession(ctx, sessionId);
    ctx.db.session.id.update({ ...s, profileJson });
    for (const r of rules) upsertRule(ctx, sessionId, r.kind, r.pattern, r.verdict, 'profile');
    // The window the user is on right now may have been waiting on the judge: re-check it.
    const latest = ctx.db.activityEvent.id.find(s.latestEventId);
    if (latest && latest.verdict === 'pending') {
      const hit = matchRule(ctx, sessionId, latest);
      if (hit) {
        const ev = { ...latest, verdict: hit.verdict, reason: `matched ${hit.kind} rule "${hit.pattern}"`, confidence: 1, source: 'rule' };
        ctx.db.activityEvent.id.update(ev);
        applyVerdict(ctx, { ...s, profileJson }, ev);
      }
    }
  }
);

export const updateJob = spacetimedb.reducer({ jobId: t.u64(), status: t.string() }, (ctx, { jobId, status }) => {
  const j = ctx.db.agentJob.id.find(jobId);
  if (!j) return;
  ownedSession(ctx, j.sessionId);
  ctx.db.agentJob.id.update({ ...j, status });
});

export const appendTrace = spacetimedb.reducer(
  { sessionId: t.u64(), jobId: t.u64(), step: t.u32(), tool: t.string(), args: t.string(), result: t.string() },
  (ctx, { sessionId, jobId, step, tool, args, result }) => {
    ownedSession(ctx, sessionId);
    ctx.db.agentTrace.insert({
      id: 0n,
      sessionId,
      jobId,
      step,
      tool,
      args: args.slice(0, 2000),
      result: result.slice(0, 2000),
      ts: ctx.timestamp,
    });
  }
);

export const saveSummary = spacetimedb.reducer(
  { sessionId: t.u64(), metricsJson: t.string(), text: t.string(), sent: t.bool() },
  (ctx, { sessionId, metricsJson, text, sent }) => {
    ownedSession(ctx, sessionId);
    const row = { sessionId, metricsJson, text, sent, createdAt: ctx.timestamp };
    if (ctx.db.sessionSummary.sessionId.find(sessionId)) ctx.db.sessionSummary.sessionId.update(row);
    else ctx.db.sessionSummary.insert(row);
  }
);

// ---------- Scheduled reducers ----------

export const runAlertCheck = spacetimedb.reducer(
  { onSchedule: alertCheck },
  { timer: alertCheck.rowType },
  (ctx, { timer }) => {
    const iv = ctx.db.intervention.id.find(timer.interventionId);
    if (!iv || iv.resolvedAt !== undefined || iv.alerted) return;
    const s = ctx.db.session.id.find(iv.sessionId);
    if (!s || s.status !== 'active') return;
    ctx.db.intervention.id.update({ ...iv, alerted: true });
    queueJob(ctx, iv.sessionId, 'alert', iv.eventId, iv.id);
  }
);

export const runSessionTimer = spacetimedb.reducer(
  { onSchedule: sessionTimer },
  { timer: sessionTimer.rowType },
  (ctx, { timer }) => {
    const s = ctx.db.session.id.find(timer.sessionId);
    if (s) endSessionInternal(ctx, s);
  }
);
