import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerRegex,
  formatValue,
  interpolate,
  isInstant,
  lastValue,
  layoutPanels,
  legendLabel,
  panelHeightPx,
  panelVariables,
  promDuration,
  rateInterval,
  reduceSeries,
  seriesName,
  stepFor,
  thresholdColor,
  toChartData,
  toTable,
} from './model.js';

test('stepFor: one point per pixel, 15 s floor, nice steps, 11k point cap', () => {
  assert.equal(stepFor(900, 1200), 15); // 15m on a wide panel hits the floor
  assert.equal(stepFor(3600, 600), 15); // 6 s raw → floor
  assert.equal(stepFor(6 * 3600, 600), 60); // 36 s → 60 s
  assert.equal(stepFor(86400, 600), 300); // 144 s → 300 s
  assert.equal(stepFor(7 * 86400, 600), 1800); // 1008 s → 1800 s
  assert.equal(stepFor(7 * 86400, 1500), 600); // 403 s → 600 s
  assert.ok(7 * 86400 / stepFor(7 * 86400, 50000) <= 11000);
  assert.equal(stepFor(3600, undefined), 15);
});

test('rateInterval: max(step + scrape, 4 × scrape)', () => {
  assert.equal(rateInterval(15), 60);
  assert.equal(rateInterval(60), 75);
  assert.equal(rateInterval(300), 315);
  assert.equal(rateInterval(15, 30), 120);
});

test('promDuration picks the largest whole unit', () => {
  assert.equal(promDuration(60), '1m');
  assert.equal(promDuration(75), '75s');
  assert.equal(promDuration(3600), '1h');
  assert.equal(promDuration(7 * 86400), '7d');
  assert.equal(promDuration(0), '1s');
});

test('interpolate: $var, ${var}, ${var:fmt}, whole-name match, unknown left as is', () => {
  const vars = panelVariables({ node: 'agent-1', nodename: 'web-1', container: '', rangeSec: 3600, stepSec: 60 });
  assert.equal(
    interpolate('rate(node_cpu_seconds_total{instance="$node",job="$job"}[$__rate_interval])', vars),
    'rate(node_cpu_seconds_total{instance="agent-1",job="node"}[75s])',
  );
  assert.equal(interpolate('x{nodename="$nodename", i="${node}"}', vars), 'x{nodename="web-1", i="agent-1"}');
  assert.equal(interpolate('max_over_time(x[$__range:1m])', vars), 'max_over_time(x[1h:1m])');
  assert.equal(interpolate('x[$__interval] ${node:raw}', vars), 'x[1m] agent-1');
  assert.equal(interpolate('y{job="$cadvisor_job", name=~"$container"}', vars), 'y{job="cadvisor", name=~".*"}');
  assert.equal(interpolate('$unknown and ${ds_prometheus}', vars), '$unknown and ${ds_prometheus}');
  assert.equal(interpolate(undefined, vars), '');
});

test('containerRegex escapes names for a PromQL string and treats All as .*', () => {
  assert.equal(containerRegex(''), '.*');
  assert.equal(containerRegex('$__all'), '.*');
  assert.equal(containerRegex([]), '.*');
  assert.equal(containerRegex('web'), 'web');
  assert.equal(containerRegex(['api.v2', 'db']), 'api\\\\.v2|db');
});

test('legendLabel: {{label}} templating, spaces inside braces, __auto and empty fallback', () => {
  const m = { __name__: 'node_disk_read_bytes_total', device: 'sda', instance: 'a1' };
  assert.equal(legendLabel('{{device}} - Read', m), 'sda - Read');
  assert.equal(legendLabel('{{ device }} ARP Table', m), 'sda ARP Table');
  assert.equal(legendLabel('{{missing}}x', m), 'x');
  assert.equal(legendLabel('__auto', m), 'node_disk_read_bytes_total{device="sda", instance="a1"}');
  assert.equal(legendLabel('', {}), 'Value');
  assert.equal(seriesName({ __name__: 'up' }), 'up');
  assert.equal(seriesName({ mode: 'idle', yk_org: 'o1' }), '{mode="idle"}');
});

test('formatValue: Grafana units', () => {
  assert.equal(formatValue(42.123, 'percent', 1), '42.1%');
  assert.equal(formatValue(0.5, 'percentunit'), '50%');
  assert.equal(formatValue(0.4567, 'percentunit', 1), '45.7%');
  assert.equal(formatValue(1536, 'bytes'), '1.5 KiB');
  assert.equal(formatValue(8 * 1024 ** 3, 'bytes'), '8 GiB');
  assert.equal(formatValue(1500, 'decbytes'), '1.5 kB');
  assert.equal(formatValue(2500000, 'bps'), '2.5 Mb/s');
  assert.equal(formatValue(2500, 'Bps'), '2.5 kB/s');
  assert.equal(formatValue(90, 's'), '1.5 min');
  assert.equal(formatValue(0.25, 's'), '250 ms');
  assert.equal(formatValue(2 * 86400, 's'), '2 day');
  assert.equal(formatValue(1.5, 'd'), '1.5 day');
  assert.equal(formatValue(1234, 'short'), '1.23K');
  assert.equal(formatValue(12, 'short'), '12');
  assert.equal(formatValue(2500000, 'short'), '2.5M');
  assert.equal(formatValue(12, 'ops'), '12 ops/s');
  assert.equal(formatValue(1500, 'iops'), '1.5K io/s');
  assert.equal(formatValue(3, 'pps'), '3 p/s');
  assert.equal(formatValue(1, 'bool_yes_no'), 'Yes');
  assert.equal(formatValue(0, 'bool_yes_no'), 'No');
  assert.equal(formatValue(3.14159, 'none', 2), '3.14');
  assert.equal(formatValue(-2048, 'bytes'), '-2 KiB');
  assert.equal(formatValue(0, 'bytes'), '0 B');
  assert.equal(formatValue(null, 'bytes'), '-');
  assert.equal(formatValue('NaN', 'percent'), '-');
  assert.equal(formatValue(7, 'whatever'), '7');
});

test('thresholdColor: base step, ascending steps, theme tokens', () => {
  const t = [
    { value: null, color: 'green' },
    { value: 80, color: 'orange' },
    { value: 90, color: 'red' },
  ];
  assert.equal(thresholdColor(10, t), 'hsl(var(--success))');
  assert.equal(thresholdColor(80, t), 'hsl(var(--warning))');
  assert.equal(thresholdColor(95, t), 'hsl(var(--destructive))');
  assert.equal(thresholdColor(null, t), 'hsl(var(--success))');
  assert.equal(thresholdColor(5, [{ value: 0, color: 'rgba(50, 172, 45, 0.97)' }]), 'hsl(var(--success))');
  assert.equal(thresholdColor(5, [{ value: null, color: '#123456' }]), '#123456');
  assert.equal(thresholdColor(5, []), null);
});

test('toChartData merges series by timestamp and labels them from the legend', () => {
  const results = [
    [
      { metric: { device: 'sda' }, values: [[100, '1'], [115, '2']] },
      { metric: { device: 'sdb' }, values: [[115, 'NaN']] },
    ],
    [{ metric: {}, values: [[100, '5']] }],
  ];
  const { data, series } = toChartData(results, [{ legend: '{{device}}' }, { legend: 'Total' }]);
  assert.deepEqual(series, [
    { key: 's0', label: 'sda' },
    { key: 's1', label: 'sdb' },
    { key: 's2', label: 'Total' },
  ]);
  assert.deepEqual(data, [
    { t: 100000, s0: 1, s2: 5 },
    { t: 115000, s0: 2, s1: null },
  ]);
});

test('lastValue / reduceSeries / toTable', () => {
  assert.equal(lastValue({ values: [[1, '3'], [2, 'NaN']] }), 3);
  assert.equal(lastValue({ value: [1, '7.5'] }), 7.5);
  assert.equal(lastValue(null), null);
  const reduced = reduceSeries([[{ metric: { mode: 'user' }, value: [1, '12'] }]], [{ legend: '{{mode}}' }]);
  assert.deepEqual(reduced, [{ label: 'user', value: 12, metric: { mode: 'user' } }]);
  const table = toTable(
    [
      [{ metric: { mountpoint: '/', instance: 'a', yk_org: 'o' }, value: [1, '10'] }],
      [{ metric: { mountpoint: '/' }, value: [1, '20'] }],
    ],
    [{ legend: 'Size' }, { legend: '{{mountpoint}}' }],
  );
  assert.deepEqual(table.columns.map((c) => c.label), ['mountpoint', 'Size', 'Value B']);
  assert.deepEqual(table.rows, [{ key: '[["mountpoint","/"]]', mountpoint: '/', v0: 10, v1: 20 }]);
});

test('layoutPanels makes y relative, clamps width and sorts', () => {
  const out = layoutPanels([
    { id: 'b', grid: { x: 12, y: 21, w: 12, h: 4 } },
    { id: 'a', grid: { x: 0, y: 21, w: 30, h: 1 } },
    { id: 'c', grid: { x: 0, y: 25, w: 6, h: 6 } },
  ]);
  assert.deepEqual(out.map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(out[0].grid, { x: 0, y: 0, w: 24, h: 2 });
  assert.equal(out[2].grid.y, 4);
  assert.equal(panelHeightPx(4), 144);
});

test('isInstant: timeseries use range queries unless the target says instant', () => {
  assert.equal(isInstant({ type: 'timeseries' }, {}), false);
  assert.equal(isInstant({ type: 'timeseries' }, { instant: true }), true);
  assert.equal(isInstant({ type: 'gauge' }, {}), true);
  assert.equal(isInstant({ type: 'stat' }, { instant: false }), false);
});
