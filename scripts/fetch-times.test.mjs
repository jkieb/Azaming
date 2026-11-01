import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveFields, toHm, toIsoDate, validate, normalizeMonth, parsePage, NotPublished } from './fetch-times.mjs';

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

/** A page shaped like derislam.at's "Aktuelle Gebetszeiten", for one month. */
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const pageOf = (year, month, { place = 'wien', weekdayYear = year } = {}) => {
  const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Array.from({ length: n }, (_, i) => {
    const wd = WD[new Date(Date.UTC(weekdayYear, month - 1, i + 1)).getUTCDay()];
    const dd = String(i + 1).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return `<tr class="x"><td class="a"> ${dd}.${mm}. <span class="b">${wd}</span> </td>` +
      ['05:31', '07:17', '11:48', '13:49', '16:10', '17:43'].map((t) => `<td class="c">${t}</td>`).join('') +
      '</tr>';
  }).join('\n');
  return `<select name="location"><option value="graz">Graz</option>` +
    `<option value="${place}" selected>${place}</option></select>` +
    `<table id="prayer-table"><thead><tr><th>Datum</th><th>Fajr</th></tr></thead><tbody>${rows}</tbody></table>`;
};

test('parses the page into records the normaliser accepts', () => {
  const records = parsePage(pageOf(2026, 12), 2026, 12);
  assert.equal(records.length, 31);
  assert.equal(records[0].date, '2026-12-01');
  assert.equal(records[0].Fajr, '05:31');
  assert.doesNotThrow(() => normalizeMonth(records, 2026, 12));
});

test("accepts today's row, which carries a 'heute' badge", () => {
  const html = pageOf(2026, 12).replace('<span class="b">Di</span>', '<span class="b">Di</span> <span>heute</span>');
  assert.equal(parsePage(html, 2026, 12)[0].date, '2026-12-01');
});

test('flags a month whose weekdays belong to another year as not published', () => {
  assert.throws(() => parsePage(pageOf(2027, 1, { weekdayYear: 2026 }), 2027, 1), NotPublished);
});

test('treats the page\'s "no times" message as not published', () => {
  const html = pageOf(2027, 1).replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody><tr><td colspan="7">Keine Gebetszeiten für diesen Zeitraum verfügbar.</td></tr></tbody>');
  assert.throws(() => parsePage(html, 2027, 1), NotPublished);
});

test('refuses a page that shows another place', () => {
  assert.throws(() => parsePage(pageOf(2026, 12, { place: 'graz' }), 2026, 12), /does not show Wien/);
});

test('fails loudly when the table is gone', () => {
  assert.throws(() => parsePage('<select><option value="wien" selected>Wien</option></select>', 2026, 12), /table not found/);
});
