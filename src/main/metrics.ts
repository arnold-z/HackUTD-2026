// Focus metrics computed from activity events and interventions (same numbers for the
// agent's get_metrics tool, the debrief text, and the dashboard).
export type MetricEvent = { tsMs: number; app: string; title: string; url: string; verdict: string };
export type MetricIntervention = { shownMs: number; resolvedMs: number | null; alerted: boolean };

export type Metrics = {
  sessionMinutes: number;
  onTaskRatio: number; // 0..1, over time with a known verdict
  onTaskMinutes: number;
  offTaskMinutes: number;
  drifts: number;
  meanReturnSeconds: number | null;
  alertsSent: number;
  longestStreakMinutes: number;
  topDistractors: { name: string; minutes: number }[];
  focusScore: number; // 0..100
};

function hostOf(url: string) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

export function computeMetrics(
  events: MetricEvent[],
  interventions: MetricIntervention[],
  startMs: number,
  endMs: number
): Metrics {
  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
  let on = 0;
  let off = 0;
  let streak = 0;
  let longest = 0;
  const distract = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const until = i + 1 < sorted.length ? sorted[i + 1].tsMs : endMs;
    const dur = Math.max(0, until - e.tsMs);
    if (e.verdict === 'on_task') {
      on += dur;
      streak += dur;
      longest = Math.max(longest, streak);
    } else if (e.verdict === 'off_task') {
      off += dur;
      streak = 0;
      const name = hostOf(e.url) || e.app;
      distract.set(name, (distract.get(name) ?? 0) + dur);
    }
  }
  const known = on + off;
  const ratio = known > 0 ? on / known : 1;
  const returns = interventions.filter((i) => i.resolvedMs !== null).map((i) => ((i.resolvedMs as number) - i.shownMs) / 1000);
  const drifts = interventions.length;
  const penalty = Math.min(0.3, 0.03 * Math.max(0, drifts - 2));
  const min = (ms: number) => Math.round((ms / 60000) * 10) / 10;
  return {
    sessionMinutes: min(Math.max(0, endMs - startMs)),
    onTaskRatio: Math.round(ratio * 100) / 100,
    onTaskMinutes: min(on),
    offTaskMinutes: min(off),
    drifts,
    meanReturnSeconds: returns.length ? Math.round(returns.reduce((a, b) => a + b, 0) / returns.length) : null,
    alertsSent: interventions.filter((i) => i.alerted).length,
    longestStreakMinutes: min(longest),
    topDistractors: [...distract.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, ms]) => ({ name, minutes: min(ms) })),
    focusScore: Math.round(100 * ratio * (1 - penalty)),
  };
}
