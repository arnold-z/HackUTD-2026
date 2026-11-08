// The Focus Agent. Jobs are queued by SpacetimeDB reducers (agent_job rows) and handled here:
//   profile -> one Nemotron call turns the goal into allow/block rules
//   judge   -> tool-calling loop that investigates an unknown window and records a verdict
//   alert   -> writes and sends the 10-second off-task iMessage
//   debrief -> computes metrics, writes the summary, sends it
// Every tool call is written to agent_trace so the UI can show the agent reasoning live.
import type { Conn } from './db.js';
import { micros, sessionEvents, sessionInterventions, sessionRules } from './db.js';
import { chat, extractJson, hasImages, withoutImages, type ChatMessage, type ToolSpec } from './llm.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { sendText } from './photon.js';

type Job = NonNullable<ReturnType<Conn['db']['agentJob']['id']['find']>>;
type Session = NonNullable<ReturnType<Conn['db']['session']['id']['find']>>;
type Event = NonNullable<ReturnType<Conn['db']['activityEvent']['id']['find']>>;

// Apps whose window title doesn't say what's open (one "Notes" title for every note): the Judge
// looks at a screenshot. Keep in sync with CONTENT_APPS in server/src/index.ts.
export const CONTENT_APPS = ['notes', 'pages', 'preview', 'textedit', 'microsoft word', 'obsidian', 'notion', 'bear', 'keynote', 'numbers', 'mail', 'messages', 'slack', 'discord', 'reminders'];
export const isContentApp = (app: string) => CONTENT_APPS.includes(app.trim().toLowerCase());

const CONFIDENCE_FLOOR = 0.6; // strict mode: below this, an off-task call becomes on-task
const KNOWN_DISTRACTIONS = [
  'reddit.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'x.com', 'twitter.com', 'netflix.com',
  'twitch.tv', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'pinterest.com', '9gag.com', 'espn.com',
];

function hostOf(url: string) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

export type AgentStatus = { llm: 'unknown' | 'ok' | 'error'; llmError: string; lastLatencyMs: number };

export class Agent {
  status: AgentStatus = { llm: 'unknown', llmError: '', lastLatencyMs: 0 };
  private fastLane: Promise<void> = Promise.resolve();
  private msgLane: Promise<void> = Promise.resolve();
  private seen = new Set<string>();

  constructor(private conn: Conn, private onChange: () => void, private capture?: () => Promise<string | null>) {}

  start() {
    this.conn.db.agentJob.onInsert((_ctx, job) => this.enqueue(job));
    // Pick up anything queued while the app was closed (latest session only).
    for (const job of this.conn.db.agentJob.iter()) if (job.status === 'queued') this.enqueue(job);
  }

  private enqueue(job: Job) {
    const key = job.id.toString();
    if (this.seen.has(key) || job.status !== 'queued') return;
    const s = this.conn.db.session.id.find(job.sessionId);
    if (!s || (this.conn.identity && !s.owner.isEqual(this.conn.identity))) return;
    this.seen.add(key);
    const run = () => this.run(job).catch((e) => console.error('[agent] job failed', job.kind, e));
    if (job.kind === 'alert' || job.kind === 'debrief') this.msgLane = this.msgLane.then(run);
    else this.fastLane = this.fastLane.then(run);
  }

  private async run(job: Job) {
    await this.setJob(job, 'running');
    try {
      if (job.kind === 'profile') await this.profile(job);
      else if (job.kind === 'judge') await this.judge(job);
      else if (job.kind === 'alert') await this.alert(job);
      else if (job.kind === 'debrief') await this.debrief(job);
      await this.setJob(job, 'done');
    } catch (err: any) {
      console.error(`[agent] ${job.kind} error:`, err?.message ?? err);
      await this.trace(job, 99, 'error', '', String(err?.message ?? err));
      await this.setJob(job, 'failed');
    } finally {
      this.onChange();
    }
  }

  private async setJob(job: Job, status: string) {
    try {
      await this.conn.reducers.updateJob({ jobId: job.id, status });
    } catch {
      /* non-fatal */
    }
  }

  private step = new Map<string, number>();
  private async trace(job: Job, step: number | null, tool: string, args: string, result: string) {
    const k = job.id.toString();
    const n = step ?? (this.step.get(k) ?? 0) + 1;
    this.step.set(k, n);
    try {
      await this.conn.reducers.appendTrace({ sessionId: job.sessionId, jobId: job.id, step: n, tool, args, result });
    } catch {
      /* non-fatal */
    }
  }

  private async llm(messages: ChatMessage[], opts: Parameters<typeof chat>[1] = {}) {
    try {
      const r = await chat(messages, opts);
      this.status = { llm: 'ok', llmError: '', lastLatencyMs: r.ms };
      return r;
    } catch (err: any) {
      this.status = { ...this.status, llm: 'error', llmError: String(err?.message ?? err) };
      this.onChange();
      throw err;
    }
  }

  private session(job: Job): Session {
    const s = this.conn.db.session.id.find(job.sessionId);
    if (!s) throw new Error('session missing');
    return s;
  }

  private profileSummary(s: Session): string {
    try {
      const p = JSON.parse(s.profileJson || '{}');
      return typeof p.summary === 'string' ? p.summary : '';
    } catch {
      return '';
    }
  }

  // ---------------- Profile ----------------
  private async profile(job: Job) {
    const s = this.session(job);
    const prompt = `A student/worker on macOS starts a focus session.
Goal: "${s.goal}" (${s.minutes} minutes).

Return ONLY a JSON object:
{
 "summary": "<one sentence: what on-task work looks like>",
 "on_task": { "apps": [..], "domains": [..], "keywords": [..] },
 "off_task": { "apps": [..], "domains": [..] }
}
Rules:
- apps = macOS process names as shown in the menu bar, e.g. "Code" (VS Code), "Terminal", "iTerm2", "Xcode", "Notion", "Preview", "Microsoft Word", "Slack", "Discord", "Spotify", "Steam". Never list a web browser.
- domains = bare hostnames like "docs.python.org". Put a domain in off_task only if nearly every page on it is a distraction for this goal (instagram.com, tiktok.com, netflix.com). Do NOT block mixed platforms like youtube.com, google.com, reddit.com, github.com, stackoverflow.com — those are judged page by page.
- keywords = 4-10 lowercase topic words that, if present in a page title, mean the page is about the goal (e.g. "dijkstra", "graph algorithm", "heapq"). Avoid generic words.`;
    let profile: any;
    await this.trace(job, 1, 'nemotron.profile', JSON.stringify({ goal: s.goal }), '…');
    try {
      const r = await this.llm([{ role: 'user', content: prompt }], { maxTokens: 800 });
      profile = extractJson(r.content);
      await this.trace(job, 2, 'nemotron.profile.result', '', r.content.slice(0, 1500));
    } catch (err: any) {
      await this.trace(job, 2, 'nemotron.profile.error', '', String(err?.message ?? err));
    }
    if (!profile || typeof profile !== 'object') profile = fallbackProfile(s.goal);

    const rules: { kind: string; pattern: string; verdict: string }[] = [];
    const add = (kind: string, list: unknown, verdict: string) => {
      if (!Array.isArray(list)) return;
      for (const raw of list.slice(0, 15)) {
        const p = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, kind === 'domain' ? '' : '$&');
        if (p.length < 2) continue;
        if (kind === 'keyword' && p.length < 4) continue;
        rules.push({ kind, pattern: p, verdict });
      }
    };
    add('app', profile.on_task?.apps, 'on_task');
    add('domain', profile.on_task?.domains, 'on_task');
    add('keyword', profile.on_task?.keywords, 'on_task');
    add('app', profile.off_task?.apps, 'off_task');
    add('domain', profile.off_task?.domains, 'off_task');
    const onDomains = new Set(rules.filter((r) => r.kind === 'domain' && r.verdict === 'on_task').map((r) => r.pattern));
    for (const d of KNOWN_DISTRACTIONS) {
      if (d === 'reddit.com') continue; // left to the Judge (page by page)
      if (!onDomains.has(d) && !rules.some((r) => r.pattern === d)) rules.push({ kind: 'domain', pattern: d, verdict: 'off_task' });
    }
    await this.conn.reducers.saveProfile({ sessionId: s.id, profileJson: JSON.stringify(profile), rules });
    await this.trace(job, 3, 'save_profile', '', `${rules.length} rules saved`);
  }

  // ---------------- Judge ----------------
  private judgeTools: ToolSpec[] = [
    {
      type: 'function',
      function: {
        name: 'get_session_context',
        description: 'Goal, what on-task work looks like, minutes elapsed, and the last few windows with their verdicts.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_page_summary',
        description: 'Fetch a web page and return its title, description and first text. Use when the window title alone is ambiguous (e.g. a YouTube video, a forum thread, an unfamiliar site).',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'capture_window',
        description: "Take a screenshot of the user's screen to see what is actually open (which note, document, chat or page). Use when the window title doesn't reveal the content.",
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lookup_rules',
        description: 'List the learned allow/block rules for this session.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_rule',
        description:
          'Remember a decision so similar windows are decided instantly next time. kind=domain for a whole site (only when every page on it would get the same verdict), kind=app for a non-browser macOS app, kind=keyword for an ON-TASK topic word found in page titles.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'app', 'keyword'] },
            pattern: { type: 'string' },
            verdict: { type: 'string', enum: ['on_task', 'off_task'] },
          },
          required: ['kind', 'pattern', 'verdict'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'record_verdict',
        description: 'Final decision for the current window. Call exactly once, last. An off_task verdict immediately blocks the screen until the user returns.',
        parameters: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['on_task', 'off_task'] },
            reason: { type: 'string', description: 'One short sentence shown to the user.' },
            confidence: { type: 'number', description: '0 to 1' },
          },
          required: ['verdict', 'reason', 'confidence'],
        },
      },
    },
  ];

  private async judge(job: Job) {
    let ev = this.conn.db.activityEvent.id.find(job.eventId);
    if (!ev || ev.verdict !== 'pending') {
      await this.trace(job, 1, 'skip', '', 'already decided by a rule');
      return;
    }
    const s = this.session(job);
    if (s.status !== 'active') return;
    if (s.latestEventId !== ev.id) {
      // The user already moved on; judge it anyway only if nothing newer is waiting.
      const newer = sessionEvents(this.conn, s.id).some((e) => e.id > ev!.id && e.verdict === 'pending');
      if (newer) {
        await this.trace(job, 1, 'skip', '', 'user already switched away');
        return;
      }
    }

    const system = `You are FocusGuard's Judge, an autonomous agent on the user's Mac. The user committed to a goal. They just switched to a window. Decide if this window helps that goal.
Work in steps: call tools when the title is ambiguous (fetch the page, check context or rules), optionally save_rule when the decision generalizes, then call record_verdict exactly once.
Guidelines:
- Tutorials, docs, references, search results, course sites, code, notes, AI assistants, and messages about the goal topic are on_task.
- Social feeds, entertainment, gaming, shopping, unrelated videos/news are off_task.
- System windows (Finder, System Settings, a file dialog) and anything needed to do the work are on_task.
- Strict blocking hurts when wrong: if genuinely unsure, choose on_task with low confidence.
- When a screenshot is provided, judge by the content that is visible (the open note, document, chat or page), not by the app. A note about an unrelated topic is off_task even inside a notes app. A screenshot showing only a desktop wallpaper means screen access is off: ignore it.`;
    const user = JSON.stringify({
      goal: s.goal,
      what_on_task_looks_like: this.profileSummary(s),
      window: { app: ev.app, title: ev.title, url: ev.url || null },
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `New window to judge:\n${user}` },
    ];
    // For apps whose title hides the content, look at the screen up front.
    if (isContentApp(ev.app) && this.capture) {
      const shot = await this.capture();
      await this.trace(job, null, 'capture_window', JSON.stringify({ app: ev.app, auto: true }), shot ? `screenshot attached (${Math.round((shot.length * 3) / 4 / 1024)} KB)` : 'no screenshot (grant Screen Recording permission)');
      if (!shot) {
        messages[1] = {
          role: 'user',
          content: `New window to judge:\n${user}\nNo screenshot is available (screen access is off), so you cannot see which note or document is open. An app title alone is not evidence of being off task: record on_task with confidence 0.3 unless the title itself names something unrelated to the goal.`,
        };
      } else {
        messages[1] = {
          role: 'user',
          content: [
            { type: 'text', text: `New window to judge:\n${user}\nThe title doesn't show what's open, so here is a screenshot of the screen. Judge by its content.` },
            { type: 'image_url', image_url: { url: shot } },
          ],
        };
      }
    }

    let decided = false;
    for (let turn = 0; turn < 5 && !decided; turn++) {
      let r;
      try {
        r = await this.llm(messages, { tools: this.judgeTools, maxTokens: 600, timeoutMs: hasImages(messages) ? 45_000 : 25_000 });
      } catch (err: any) {
        await this.trace(job, null, 'nemotron.error', '', String(err?.message ?? err));
        if (!hasImages(messages)) break;
        // Endpoint rejected or timed out on the image: retry once with text only.
        const textOnly = withoutImages(messages);
        messages.splice(0, messages.length, ...textOnly);
        await this.trace(job, null, 'retry_without_screenshot', '', 'continuing from the title only');
        continue;
      }
      if (r.toolCalls.length) {
        messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
        for (const call of r.toolCalls) {
          let args: any = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            /* keep {} */
          }
          const result = await this.execJudgeTool(job, s, ev, call.function.name, args);
          await this.trace(job, null, call.function.name, JSON.stringify(args), result.text);
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
          if (result.image) {
            messages.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot of the current screen:' }, { type: 'image_url', image_url: { url: result.image } }] });
          }
          if (result.final) decided = true;
        }
      } else {
        // JSON fallback when the endpoint doesn't return native tool calls.
        const j = extractJson(r.content);
        if (j && (j.verdict === 'on_task' || j.verdict === 'off_task')) {
          const res = await this.execJudgeTool(job, s, ev, 'record_verdict', j);
          await this.trace(job, null, 'record_verdict (json)', JSON.stringify(j), res.text);
          decided = true;
        } else {
          messages.push({ role: 'assistant', content: r.content });
          messages.push({ role: 'user', content: 'Call record_verdict now (or reply with JSON {"verdict","reason","confidence"}).' });
        }
      }
    }
    ev = this.conn.db.activityEvent.id.find(job.eventId) ?? ev;
    if (!decided && ev.verdict === 'pending') {
      const host = hostOf(ev.url);
      const off = KNOWN_DISTRACTIONS.some((d) => host === d || host.endsWith('.' + d));
      const verdict = off ? 'off_task' : 'on_task';
      const reason = off ? `${host} is a common distraction (agent fallback)` : 'Agent unavailable; allowed by default';
      await this.conn.reducers.recordVerdict({ eventId: ev.id, verdict, reason, confidence: off ? 0.7 : 0.3 });
      await this.trace(job, null, 'fallback_verdict', '', `${verdict}: ${reason}`);
    }
  }

  private async execJudgeTool(job: Job, s: Session, ev: Event, name: string, args: any): Promise<{ text: string; final?: boolean; image?: string }> {
    switch (name) {
      case 'get_session_context': {
        const recent = sessionEvents(this.conn, s.id)
          .slice(-8)
          .map((e) => ({ app: e.app, title: e.title.slice(0, 80), host: hostOf(e.url), verdict: e.verdict }));
        const elapsed = Math.round((Date.now() - micros(s.startedAt)) / 60000);
        return { text: JSON.stringify({ goal: s.goal, on_task_looks_like: this.profileSummary(s), minutes_elapsed: elapsed, minutes_planned: s.minutes, recent }) };
      }
      case 'fetch_page_summary': {
        const url = String(args.url || ev.url || '');
        return { text: url ? await fetchPageSummary(url) : 'no url for this window' };
      }
      case 'capture_window': {
        if (!this.capture) return { text: 'screen capture is not available' };
        const shot = await this.capture();
        return shot ? { text: 'Screenshot captured; it follows as an image.', image: shot } : { text: 'Screenshot unavailable (Screen Recording permission not granted). Judge from the title.' };
      }
      case 'lookup_rules': {
        const rules = sessionRules(this.conn, s.id).map((r) => `${r.verdict} ${r.kind}:${r.pattern}`);
        return { text: rules.length ? rules.join('\n') : 'no rules yet' };
      }
      case 'save_rule': {
        const kind = String(args.kind || '');
        let pattern = String(args.pattern || '').trim().toLowerCase();
        const verdict = String(args.verdict || '');
        if (kind === 'domain') pattern = pattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        if (kind === 'keyword' && verdict === 'off_task') return { text: 'rejected: keyword rules are for on-task topics only' };
        if (pattern.length < 3) return { text: 'rejected: pattern too short' };
        await this.conn.reducers.saveRule({ sessionId: s.id, kind, pattern, verdict });
        return { text: `saved ${verdict} ${kind}:${pattern}` };
      }
      case 'record_verdict': {
        let verdict = args.verdict === 'off_task' ? 'off_task' : 'on_task';
        let confidence = Math.max(0, Math.min(1, Number(args.confidence ?? 0.5)));
        let reason = String(args.reason || '').slice(0, 300) || (verdict === 'off_task' ? 'Not related to your goal' : 'Related to your goal');
        if (verdict === 'off_task' && confidence < CONFIDENCE_FLOOR) {
          reason = `Allowed (unsure, ${Math.round(confidence * 100)}%): ${reason}`;
          verdict = 'on_task';
        }
        const fresh = this.conn.db.activityEvent.id.find(ev.id);
        if (fresh && fresh.verdict !== 'pending') return { text: `already decided: ${fresh.verdict}`, final: true };
        await this.conn.reducers.recordVerdict({ eventId: ev.id, verdict, reason, confidence });
        return { text: `recorded ${verdict} (${Math.round(confidence * 100)}%)`, final: true };
      }
      default:
        return { text: `unknown tool ${name}` };
    }
  }

  // ---------------- Alert (10 s off-task) ----------------
  private async alert(job: Job) {
    const s = this.session(job);
    const iv = this.conn.db.intervention.id.find(job.interventionId);
    if (!iv) return;
    const mins = Math.max(1, Math.round((Date.now() - micros(s.startedAt)) / 60000));
    const secs = Math.max(10, Math.round((Date.now() - micros(iv.shownAt)) / 1000));
    let text = '';
    try {
      const r = await this.llm(
        [
          {
            role: 'user',
            content: `Write ONE short iMessage (max 160 characters, no hashtags, no quotes) nudging a user back to work. Facts: they have been off-task for ${secs} seconds on "${iv.distraction}". Their goal: "${s.goal}". They are ${mins} min into a ${s.minutes}-min session. Be direct and a little witty, not mean. Output only the message.`,
          },
        ],
        { maxTokens: 120, temperature: 0.7 }
      );
      text = r.content.replace(/^["']|["']$/g, '').trim();
    } catch {
      /* template below */
    }
    if (!text || text.length > 240) text = `FocusGuard: ${secs}s on ${iv.distraction.split(' — ')[0]}. You're ${mins} min into "${s.goal}". Back to it.`;
    const res = await sendText(s.phone, text);
    await this.trace(job, null, 'send_imessage', JSON.stringify({ to: s.phone }), `${res.ok ? 'sent' : 'FAILED'}: ${text}${res.ok ? '' : ` (${res.detail})`}`);
  }

  // ---------------- Debrief ----------------
  metricsFor(sessionId: bigint, endMs?: number): Metrics {
    const s = this.conn.db.session.id.find(sessionId)!;
    const end = endMs ?? (s.endedAt ? micros(s.endedAt) : Date.now());
    const events = sessionEvents(this.conn, sessionId).map((e) => ({ tsMs: micros(e.ts), app: e.app, title: e.title, url: e.url, verdict: e.verdict }));
    const ivs = sessionInterventions(this.conn, sessionId).map((i) => ({
      shownMs: micros(i.shownAt),
      resolvedMs: i.resolvedAt ? micros(i.resolvedAt) : null,
      alerted: i.alerted,
    }));
    return computeMetrics(events, ivs, micros(s.startedAt), end);
  }

  private async debrief(job: Job) {
    const s = this.session(job);
    const m = this.metricsFor(s.id);
    await this.trace(job, 1, 'get_metrics', '', JSON.stringify(m));
    const facts = JSON.stringify({ goal: s.goal, planned_minutes: s.minutes, ...m });
    const ask = `Write a session debrief iMessage for a focus app. Under 400 characters, plain text, no markdown, 3-5 short lines. First line: "FocusGuard · <short goal> · <minutes> min". Include focus score, on-task %, drifts and average return time, top distractor if any, and one specific suggestion for next time. Use only these facts: ${facts}`;
    let text = '';
    for (const thinking of [true, false]) {
      try {
        const r = await this.llm([{ role: 'user', content: ask }], { thinking, maxTokens: thinking ? 6000 : 400 });
        text = r.content.trim();
        if (text) break;
      } catch {
        /* try next mode */
      }
    }
    if (!text) {
      const top = m.topDistractors[0];
      text = [
        `FocusGuard · ${s.goal.slice(0, 40)} · ${Math.round(m.sessionMinutes)} min`,
        `Focus ${m.focusScore}/100 (on-task ${Math.round(m.onTaskRatio * 100)}%)`,
        `${m.drifts} drifts${m.meanReturnSeconds !== null ? `, avg return ${m.meanReturnSeconds}s` : ''}, ${m.alertsSent} alerts`,
        top ? `Top distractor: ${top.name} (${top.minutes} min)` : 'No distractions logged',
        `Longest streak: ${m.longestStreakMinutes} min`,
      ].join('\n');
    }
    const res = await sendText(s.phone, text);
    await this.trace(job, 2, 'send_imessage', JSON.stringify({ to: s.phone }), `${res.ok ? 'sent' : 'FAILED'}: ${text}`);
    await this.conn.reducers.saveSummary({ sessionId: s.id, metricsJson: JSON.stringify(m), text, sent: res.ok });
  }
}

function fallbackProfile(goal: string) {
  const stop = new Set(['finish', 'complete', 'assignment', 'homework', 'about', 'which', 'their', 'there', 'these', 'study', 'write', 'working']);
  const words = goal
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 5 && !stop.has(w));
  return {
    summary: `Work related to: ${goal}`,
    on_task: { apps: ['Code', 'Terminal', 'iTerm2', 'Xcode', 'Notion', 'Preview'], domains: [], keywords: [...new Set(words)].slice(0, 6) },
    off_task: { apps: ['Steam', 'Spotify'], domains: [] },
  };
}

export async function fetchPageSummary(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const host = hostOf(url);
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host) && /watch|youtu\.be|shorts/.test(url)) {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
      if (r.ok) {
        const j: any = await r.json();
        return `YouTube video: "${j.title}" by ${j.author_name}`;
      }
    }
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) FocusGuard/1.0', accept: 'text/html,*/*' },
    });
    const html = (await r.text()).slice(0, 400_000);
    const pick = (re: RegExp) => (re.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc =
      pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ||
      pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i);
    const body = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&amp;|&#39;|&quot;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    return `HTTP ${r.status}. Title: ${title || '(none)'}. Description: ${desc || '(none)'}. Text: ${body}`;
  } catch (err: any) {
    return `could not fetch (${err?.name === 'AbortError' ? 'timeout' : err?.message ?? err})`;
  } finally {
    clearTimeout(timer);
  }
}
