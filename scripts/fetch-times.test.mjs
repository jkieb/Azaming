import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveFields, toHm, toIsoDate, validate, normalizeMonth } from './fetch-times.mjs';

/** A record shaped like the one the IGGOe Directus API returns. */
const record = (date, times = {}) => ({
  id: 1,
  place: 'Wien',
  date,
  Fadjr: '03:25',
  Shuruk: '05:23',
  Duhr: '13:06',
  Assr: '17:11',
  Maghrib: '20:39',
  Ishaa: '22:17',
  ...times,
});

const monthOf = (year, month) =>
  Array.from({ length: new Date(Date.UTC(year, month, 0)).getUTCDate() }, (_, i) =>
    record(`${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`),
  );

test('maps the API column names', () => {
  const f = resolveFields(record('2026-08-01'));
  assert.equal(f.fajr, 'Fadjr');
  assert.equal(f.sunrise, 'Shuruk');
  assert.equal(f.isha, 'Ishaa');
});

test('reports what is missing when the schema changes', () => {
  assert.throws(
    () => resolveFields({ date: '2026-08-01', Fadjr: '03:25' }),
    /missing:[\s\S]*sunrise[\s\S]*available: date, Fadjr/,
  );
});

test('normalises times and dates', () => {
  assert.equal(toHm('03:25:00', 'x'), '03:25');
  assert.equal(toHm('3:25', 'x'), '03:25');
  assert.equal(toIsoDate('2026-08-01T00:00:00', 'x'), '2026-08-01');
  assert.equal(toIsoDate('01.08.26', 'x'), '2026-08-01');
  assert.throws(() => toHm('25:00', 'x'), /out-of-range/);
  assert.throws(() => toHm('', 'x'), /unparseable/);
});

test('accepts a well-formed month', () => {
  assert.doesNotThrow(() => validate(normalizeMonth(monthOf(2026, 8), 2026, 8), 2026, 8));
});

test('rejects a short month', () => {
  const days = monthOf(2026, 8).slice(0, 30);
  assert.throws(() => normalizeMonth(days, 2026, 8), /expected 31 days, got 30/);
});

test('rejects duplicate days', () => {
  const days = monthOf(2026, 8);
  days[5] = record('2026-08-05');
  assert.throws(() => normalizeMonth(days, 2026, 8), /duplicate date 2026-08-05/);
});

test('rejects out-of-order prayer times', () => {
  const days = monthOf(2026, 8);
  days[0] = record('2026-08-01', { Maghrib: '12:00' });
  assert.throws(() => normalizeMonth(days, 2026, 8), /maghrib 12:00 not after asr 17:11/);
});

test('rejects days from the wrong month', () => {
  const days = monthOf(2026, 8);
  days[0] = record('2026-09-01');
  assert.throws(() => normalizeMonth(days, 2026, 8), /2026-09-01 is outside/);
});

test('rejects an empty response instead of writing an empty month', () => {
  assert.throws(() => normalizeMonth([], 2026, 8), /no records returned/);
});
