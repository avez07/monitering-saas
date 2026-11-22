import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atBottom, linesToText, logParams, mergeLines, normalizeLevel } from './logs-model.js';

const line = (time, message, extra = {}) => ({ time, stream: 'stdout', level: 'INFO', message, ...extra });

test('normalizeLevel maps common severities', () => {
  assert.equal(normalizeLevel('ERROR'), 'error');
  assert.equal(normalizeLevel('fatal'), 'error');
  assert.equal(normalizeLevel('Warning'), 'warn');
  assert.equal(normalizeLevel('INFO'), 'info');
  assert.equal(normalizeLevel('trace'), 'debug');
  assert.equal(normalizeLevel(''), '');
  assert.equal(normalizeLevel(undefined), '');
});

test('logParams: since from range, explicit since wins, limit capped at 1000', () => {
  const now = Date.parse('2026-01-01T01:00:00Z');
  assert.deepEqual(logParams({ range: '1h', q: ' boom ', level: 'error', stream: 'stderr' }, { now }), {
    since: '2026-01-01T00:00:00.000Z',
    q: 'boom',
    level: 'error',
    stream: 'stderr',
    limit: 500,
  });
  assert.equal(logParams({}, { since: 'X', now }).since, 'X');
  assert.equal(logParams({}, { now, limit: 5000 }).limit, 1000);
});

test('mergeLines dedupes the since boundary, sorts oldest first and caps', () => {
  const a = [line('2026-01-01T00:00:01Z', 'a'), line('2026-01-01T00:00:02Z', 'b')];
  const merged = mergeLines(a, [line('2026-01-01T00:00:02Z', 'b'), line('2026-01-01T00:00:03Z', 'c')]);
  assert.deepEqual(merged.map((l) => l.message), ['a', 'b', 'c']);
  assert.equal(mergeLines(a, []), a);
  const unordered = mergeLines([], [line('2026-01-01T00:00:05Z', 'late'), line('2026-01-01T00:00:04Z', 'early')]);
  assert.deepEqual(unordered.map((l) => l.message), ['early', 'late']);
  const capped = mergeLines(a, [line('2026-01-01T00:00:03Z', 'c')], 2);
  assert.deepEqual(capped.map((l) => l.message), ['b', 'c']);
});

test('linesToText and atBottom', () => {
  assert.equal(
    linesToText([line('T1', 'hello'), line('T2', 'bad', { stream: 'stderr', level: 'error' }), { time: 'T3', message: 'x' }]),
    'T1 stdout INFO hello\nT2 stderr ERROR bad\nT3 - - x',
  );
  assert.equal(atBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 }), true);
  assert.equal(atBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 }), false);
});
