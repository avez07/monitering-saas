#!/usr/bin/env node
/**
 * Convert a Grafana dashboard export (v2beta1: spec.elements + spec.layout) into a YuktiOps dashboard preset
 * (docs/api/advanced-telemetry.md section 4).
 *
 *   node backend/scripts/import-grafana.mjs [input.json] [output.json]
 *
 * Defaults: the repository's refference.json -> backend/src/dashboards/node-exporter-full.json.
 *
 * - Panels keep their title, description, viz type, unit, decimals, min/max, thresholds, mappings, overrides,
 *   options, legendFormat and instant flag.
 * - `$job` becomes `node` and `$cadvisor_job` becomes `cadvisor` (the labels our agent sets); container
 *   selectors also get `instance="$node"` so hosts do not mix. `$node`,
 *   `$container`, `$__rate_interval`, `$__interval` and `$__range` are left for the frontend.
 *   `${ds_prometheus}` (the datasource) is dropped.
 * - Layout: when the export has grid items, they are used. When it has none (as in refference.json), panels
 *   are grouped into the usual Node Exporter Full sections and packed on Grafana's 24-column grid.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const input = resolve(process.argv[2] || `${repo}/refference.json`);
const output = resolve(process.argv[3] || `${repo}/backend/src/dashboards/node-exporter-full.json`);

const TYPES = new Set(['timeseries', 'stat', 'gauge', 'bargauge', 'table', 'piechart']);

/**
 * Sections of Node Exporter Full (grafana.com dashboard 1860) plus the cAdvisor additions, by panel id.
 * Used only when the export has no layout of its own. Panels not listed land in "Other".
 */
const SECTIONS = [
  { title: 'Quick CPU / Mem / Disk', collapsed: false, ids: [323, 20, 155, 16, 21, 154, 14, 75, 18, 23, 15, 922] },
  { title: 'Basic CPU / Mem / Net / Disk', collapsed: false, ids: [77, 78, 74, 152, 921, 923] },
  { title: 'CPU / Memory / Net / Disk', collapsed: false, ids: [3, 24, 84, 156, 229, 42, 127, 322, 305] },
  { title: 'Memory Meminfo', collapsed: true, ids: [136, 191, 130, 138, 131, 70, 129, 160, 140, 128, 135, 137] },
  { title: 'Storage Disk', collapsed: true, ids: [9, 33, 37, 133, 36, 301, 326, 34, 35] },
  { title: 'Storage Filesystem', collapsed: true, ids: [43, 41, 28, 219, 44] },
  {
    title: 'Network Traffic',
    collapsed: true,
    ids: [60, 142, 143, 141, 146, 144, 145, 231, 232, 327, 280, 288, 309, 338, 290, 310, 330, 230, 61],
  },
  { title: 'Network Sockstat / Netstat', collapsed: true, ids: [63, 124, 125, 220, 126, 336, 339] },
  { title: 'System', collapsed: true, ids: [62, 315, 148, 313, 314] },
  { title: 'Containers', collapsed: false, ids: [901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911, 912, 913] },
];

/** Default panel size (Grafana grid units) when the export has no layout. */
function sizeOf(type, sectionTitle) {
  const quick = sectionTitle.startsWith('Quick');
  const containers = sectionTitle === 'Containers';
  if (type === 'stat') return quick ? { w: 2, h: 2 } : containers ? { w: 6, h: 4 } : { w: 4, h: 4 };
  if (type === 'gauge') return containers ? { w: 6, h: 4 } : { w: 3, h: 4 };
  if (type === 'bargauge') return quick ? { w: 3, h: 4 } : containers ? { w: 8, h: 8 } : { w: 12, h: 8 };
  if (type === 'piechart') return { w: 8, h: 8 };
  if (type === 'table') return { w: 24, h: 8 };
  return { w: 12, h: 8 };
}

/** Skyline packing on a 24-column grid: each panel goes to the highest free spot, leftmost first. */
function pack(panels) {
  const heights = new Array(24).fill(0);
  for (const panel of panels) {
    const { w, h } = panel.grid;
    let best = null;
    for (let x = 0; x + w <= 24; x++) {
      const y = Math.max(...heights.slice(x, x + w));
      if (!best || y < best.y) best = { x, y };
    }
    panel.grid = { x: best.x, y: best.y, w, h };
    for (let i = best.x; i < best.x + w; i++) heights[i] = best.y + h;
  }
  return panels;
}

const rewriteExpr = (expr = '') =>
  expr
    .replace(/\$\{job\}|\$job\b/g, 'node')
    .replace(/\$\{cadvisor_job\}|\$cadvisor_job\b/g, 'cadvisor')
    .replace(/\$\{ds_prometheus\}/g, '')
    // The reference filters container series by name only; our agents all write job="cadvisor", so scope
    // each container selector to the selected host as well.
    .replace(/\{([^{}]*\bjob="cadvisor"[^{}]*)\}/g, (all, inner) => (/\binstance\s*=/.test(inner) ? all : `{${inner}, instance="$node"}`));

/** Remove undefined keys (the preset stays small and diff-friendly). */
const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));

function convertTargets(panel) {
  return (panel.data?.spec?.queries ?? [])
    .filter((q) => !q.spec?.hidden)
    .map((q) => {
      const s = q.spec?.query?.spec ?? {};
      const legend = s.legendFormat === '__auto' ? '' : s.legendFormat;
      return clean({
        refId: q.spec?.refId,
        expr: rewriteExpr(s.expr),
        legend: legend || undefined,
        instant: s.instant === true || undefined,
        format: s.format && s.format !== 'time_series' ? s.format : undefined,
        interval: s.interval || undefined,
      });
    })
    .filter((t) => t.expr);
}

function convertPanel(element, key) {
  const p = element.spec;
  const viz = p.vizConfig?.spec ?? {};
  const type = TYPES.has(p.vizConfig?.group) ? p.vizConfig.group : 'timeseries';
  const d = viz.fieldConfig?.defaults ?? {};
  const custom = d.custom ?? {};
  const stackMode = custom.stacking?.mode;
  return clean({
    id: key || `panel-${p.id}`,
    title: p.title,
    description: p.description || undefined,
    type,
    grid: null, // filled in by the layout step
    unit: d.unit,
    decimals: d.decimals,
    min: d.min,
    max: d.max,
    thresholds: d.thresholds?.steps?.map((step) => ({ value: step.value ?? null, color: step.color })),
    thresholdsMode: d.thresholds?.mode && d.thresholds.mode !== 'absolute' ? d.thresholds.mode : undefined,
    colorMode: d.color?.mode,
    // false, or the Grafana stacking mode ("normal" / "percent").
    stacking: type === 'timeseries' ? (stackMode && stackMode !== 'none' ? stackMode : false) : undefined,
    fill: type === 'timeseries' ? custom.fillOpacity : undefined,
    lineWidth: type === 'timeseries' ? custom.lineWidth : undefined,
    drawStyle: type === 'timeseries' && custom.drawStyle !== 'line' ? custom.drawStyle : undefined,
    axisLabel: custom.axisLabel || undefined,
    mappings: d.mappings?.length ? d.mappings : undefined,
    overrides: viz.fieldConfig?.overrides?.length ? viz.fieldConfig.overrides : undefined,
    options: viz.options && Object.keys(viz.options).length ? viz.options : undefined,
    transformations: p.data?.spec?.transformations?.length ? p.data.spec.transformations : undefined,
    targets: convertTargets(p),
  });
}

/** Grid items of a v2beta1 layout, flattened: GridLayout, RowsLayout (rows of grids) or nothing. */
function layoutRows(layout) {
  const gridItems = (grid) =>
    (grid?.spec?.items ?? [])
      .filter((i) => i.kind === 'GridLayoutItem' && i.spec?.element?.name)
      .map((i) => ({ key: i.spec.element.name, x: i.spec.x, y: i.spec.y, w: i.spec.width, h: i.spec.height }));
  if (layout?.kind === 'RowsLayout')
    return (layout.spec?.rows ?? []).map((row) => ({
      title: row.spec?.title || 'Row',
      collapsed: Boolean(row.spec?.collapse),
      items: gridItems(row.spec?.layout),
    }));
  if (layout?.kind === 'GridLayout') {
    // v2 GridLayout can also hold GridLayoutRow entries (each with its own items).
    const rows = [];
    let current = { title: 'General', collapsed: false, items: [] };
    for (const item of layout.spec?.items ?? []) {
      if (item.kind === 'GridLayoutRow') {
        if (current.items.length) rows.push(current);
        current = { title: item.spec?.title || 'Row', collapsed: Boolean(item.spec?.collapsed), items: gridItems({ spec: { items: item.spec?.elements ?? [] } }) };
        rows.push(current);
        current = { title: 'General', collapsed: false, items: [] };
      } else current.items.push(...gridItems({ spec: { items: [item] } }));
    }
    if (current.items.length) rows.push(current);
    return rows.filter((r) => r.items.length);
  }
  return [];
}

function build(dashboard) {
  const spec = dashboard.spec ?? dashboard;
  const elements = spec.elements ?? {};
  const panels = new Map(
    Object.entries(elements)
      .filter(([, e]) => e.kind === 'Panel')
      .map(([key, e]) => [key, convertPanel(e, key)]),
  );
  let rows = layoutRows(spec.layout).map((row) => {
    const items = row.items.filter((i) => panels.has(i.key));
    const minY = Math.min(...items.map((i) => i.y ?? 0));
    return {
      title: row.title,
      collapsed: row.collapsed,
      panels: items.map((i) => ({ ...panels.get(i.key), grid: { x: i.x ?? 0, y: (i.y ?? 0) - minY, w: i.w ?? 12, h: i.h ?? 8 } })),
    };
  });
  const placed = new Set(rows.flatMap((r) => r.panels.map((p) => p.id)));
  const rest = [...panels.values()].filter((p) => !placed.has(p.id));
  if (rest.length) {
    // No (or partial) layout: group by the known sections, in section order, then pack.
    const byNumber = new Map(rest.map((p) => [Number(String(p.id).replace(/^panel-/, '')), p]));
    const derived = [];
    for (const section of SECTIONS) {
      const list = section.ids.map((n) => byNumber.get(n)).filter(Boolean);
      for (const n of section.ids) byNumber.delete(n);
      if (list.length) derived.push({ title: section.title, collapsed: section.collapsed, panels: list });
    }
    const other = [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
    if (other.length) derived.push({ title: 'Other', collapsed: true, panels: other });
    for (const row of derived) {
      for (const p of row.panels) p.grid = sizeOf(p.type, row.title);
      pack(row.panels);
    }
    rows = [...rows, ...derived];
  }
  return {
    id: 'node-exporter-full',
    title: 'Node Exporter Full',
    description:
      'Every node_exporter and container panel of the classic Node Exporter Full dashboard: CPU, memory, disk, filesystem, network, sockets, processes and containers.',
    source: { title: spec.title, grafanaVersion: Object.values(elements)[0]?.spec?.vizConfig?.version },
    variables: ['node', 'container'],
    rows,
  };
}

const dashboard = JSON.parse(readFileSync(input, 'utf8'));
const preset = build(dashboard);
const count = preset.rows.reduce((n, r) => n + r.panels.length, 0);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(preset, null, 2)}\n`);
console.log(`Wrote ${output}: ${preset.rows.length} rows, ${count} panels.`);
for (const row of preset.rows) console.log(`  ${row.title}: ${row.panels.length}`);
