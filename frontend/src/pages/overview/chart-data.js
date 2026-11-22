// Pure helpers that merge several per-resource API answers into one chart series.

const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** checks answers ({points:[{time,avgLatencyMs,ok,failed}]}) to [{t, uptime, latency}]. */
export function buildHealthSeries(answers) {
  const buckets = new Map();
  for (const answer of answers) {
    for (const p of answer.points ?? []) {
      const b = buckets.get(p.time) ?? { ok: 0, failed: 0, lat: 0, latN: 0 };
      b.ok += p.ok || 0;
      b.failed += p.failed || 0;
      if (num(p.avgLatencyMs) !== null && p.ok) {
        b.lat += p.avgLatencyMs * p.ok;
        b.latN += p.ok;
      }
      buckets.set(p.time, b);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([t, b]) => ({
      t,
      uptime: b.ok + b.failed ? Math.round((b.ok / (b.ok + b.failed)) * 10000) / 100 : null,
      latency: b.latN ? Math.round(b.lat / b.latN) : null,
    }));
}

/** server metrics answers ({points:[{t,cpu,memory}]}) to [{t, cpu, memory}] averaged per 5 minutes. */
export function buildServerSeries(answers, bucketMs = 300000) {
  const buckets = new Map();
  for (const answer of answers) {
    for (const p of answer.points ?? []) {
      const ms = new Date(p.t).getTime();
      if (Number.isNaN(ms)) continue;
      const key = Math.floor(ms / bucketMs) * bucketMs;
      const b = buckets.get(key) ?? { cpu: 0, cpuN: 0, mem: 0, memN: 0 };
      if (num(p.cpu) !== null) (b.cpu += Number(p.cpu)), b.cpuN++;
      if (num(p.memory) !== null) (b.mem += Number(p.memory)), b.memN++;
      buckets.set(key, b);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ms, b]) => ({
      t: new Date(ms).toISOString(),
      cpu: b.cpuN ? Math.round((b.cpu / b.cpuN) * 10) / 10 : null,
      memory: b.memN ? Math.round((b.mem / b.memN) * 10) / 10 : null,
    }));
}

/** incidents to one point per day for the last `days` days: {t, opened, critical}. */
export function buildIncidentSeries(incidents, days = 7, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    rows.push({ day: d.getTime(), t: d.toISOString(), opened: 0, critical: 0 });
  }
  for (const inc of incidents) {
    const at = new Date(inc.startedAt).getTime();
    const row = [...rows].reverse().find((r) => at >= r.day);
    if (!row) continue;
    row.opened++;
    if (inc.severity === 'critical') row.critical++;
  }
  return rows.map(({ t, opened, critical }) => ({ t, opened, critical }));
}
