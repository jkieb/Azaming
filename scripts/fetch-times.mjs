/**
 * Pulls prayer times from the IGGOe website into public/data/.
 *
 * Runs monthly (see .github/workflows/update-times.yml) and always fetches a
 * few months ahead, so a failed run - or two - never leaves the app without
 * data. Nothing is written unless it validates.
 *
 * Source: the IGGOe's "Einheitliche Islamische Gebetszeiten" page, which is
 * server-rendered HTML - one table per place and month, picked with
 * ?location=wien&month=12. (The Directus API this script used to read,
 * directus.derislam.at, no longer resolves in DNS.) If the site ever starts
 * refusing plain HTTP clients, --browser loads the same page in Chromium.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PAGE = 'https://www.derislam.at/service/einheitliche-gebetszeiten/gebetszeiten/';
const PLACE = process.env.PLACE ?? 'Wien';
const MONTHS_AHEAD = Number(process.env.MONTHS_AHEAD ?? 3);
const OUT_DIR = 'public/data';
const TIMEZONE = 'Europe/Vienna';

const USE_BROWSER = process.argv.includes('--browser');

/**
 * The API's column names are transliterated German ("Fadjr", "Shuruk") and are
 * not guaranteed to stay that way. Match them loosely and log what we resolved,
 * so a rename shows up as a readable error instead of a column of nulls.
 */
const FIELD_ALIASES = {
  date: ['date', 'datum', 'day', 'tag'],
  fajr: ['fajr', 'fadjr', 'fadschr', 'fajir'],
  sunrise: ['shuruk', 'shuruq', 'shourouq', 'sunrise', 'sonnenaufgang'],
  dhuhr: ['duhr', 'dhuhr', 'dhur', 'zuhr', 'mittag'],
  asr: ['assr', 'asr', 'nachmittag'],
  maghrib: ['maghrib', 'maghreb', 'sonnenuntergang'],
  isha: ['ishaa', 'isha', 'ischa', 'nacht'],
};

const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

class FetchError extends Error {}

function pageUrl(month) {
  const qs = new URLSearchParams({ location: locationSlug(), month: String(month) });
  return `${PAGE}?${qs}`;
}

/** "Wien" -> "wien", the value of the page's <select name="location">. */
const locationSlug = () => PLACE.toLowerCase().replace(/[^a-z]/g, '');

/**
 * The site used to challenge clients that claim to be a browser, so identify
 * honestly rather than spoofing one.
 */
const REQUEST_HEADERS = {
  accept: 'text/html',
  'user-agent': 'Azaming/1.0 (+https://github.com/jkieb/Azaming)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain GET with a short retry; one failed request should not decide the run. */
async function getHtml(url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: REQUEST_HEADERS });
      if (res.ok) return await res.text();
      last = new FetchError(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      last = new FetchError(`${err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ''} for ${url}`);
    }
    if (attempt < attempts) {
      console.log(`  attempt ${attempt}/${attempts}: ${last.message}, retrying`);
      await sleep(1500 * attempt);
    }
  }
  throw last;
}

/** Fallback path: load the same page in a real browser. */
async function getHtmlViaBrowser(url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ locale: 'de-AT' });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!res?.ok()) throw new FetchError(`HTTP ${res?.status()} for ${url}`);
    return await page.content();
  } finally {
    await browser.close();
  }
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const stripTags = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reads the prayer table out of the page. The page only offers a month, not a
 * year - it shows the current one - so the year is not taken on trust: each row
 * carries a weekday ("Di"), and a month whose weekdays do not match the year we
 * asked for is reported as not published yet instead of being stored under the
 * wrong dates.
 *
 * Returns records shaped like the old API's, so normalizeMonth() is unchanged.
 */
function parsePage(html, year, month) {
  const options = html.match(/<option[^>]*>/gi) ?? [];
  const selected = options.find((o) => /\sselected\b/i.test(o));
  if (!selected || !selected.includes(`value="${locationSlug()}"`)) {
    throw new Error(`page does not show ${PLACE} as the selected place - markup changed?`);
  }

  const table = /<table[^>]*id="prayer-table"[\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!table) throw new Error('prayer table not found on the page - markup changed?');

  const records = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length === 0) continue; // header row
    // Today's row carries an extra badge: '01.11. So heute'.
    const head = /^(\d{2})\.(\d{2})\.\s*([A-Za-z]{2})(?:\s+\S+)*$/.exec(cells[0]);
    if (!head || cells.length !== 7) throw new Error(`unexpected table row: ${cells.join(' | ')}`);
    const [, dd, mm, wd] = head;

    const actual = WEEKDAYS[new Date(Date.UTC(year, +mm - 1, +dd)).getUTCDay()];
    if (actual !== wd) {
      throw new NotPublished(`${dd}.${mm}. is a ${wd} on the page but a ${actual} in ${year}`);
    }
    const [, fajr, shuruk, dhuhr, asr, maghrib, ishaa] = cells;
    records.push({
      date: `${year}-${mm}-${dd}`,
      Fajr: fajr,
      Shuruk: shuruk,
      Dhuhr: dhuhr,
      Asr: asr,
      Maghrib: maghrib,
      Ishaa: ishaa,
    });
  }
  return records;
}

/** The page is up but does not hold this year's month - expected for next January. */
class NotPublished extends Error {}

/** Build {canonical -> apiKey} from a sample record, or explain what is missing. */
function resolveFields(sample) {
  const keys = Object.keys(sample);
  const byNorm = new Map(keys.map((k) => [norm(k), k]));
  const map = {};
  const missing = [];

  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const hit = aliases.map(norm).find((a) => byNorm.has(a));
    if (hit) map[canonical] = byNorm.get(hit);
    else missing.push(`${canonical} (tried: ${aliases.join(', ')})`);
  }

  if (missing.length) {
    throw new Error(
      `Could not map API fields.\n  missing: ${missing.join('\n           ')}\n` +
        `  available: ${keys.join(', ')}\n` +
        `  -> the table columns changed; update FIELD_ALIASES in scripts/fetch-times.mjs`,
    );
  }
  return map;
}

/** "03:25:00" | "3:25" -> "03:25" */
function toHm(value, ctx) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  if (!m) throw new Error(`unparseable time "${value}" (${ctx})`);
  const [, h, min] = m;
  if (+h > 23 || +min > 59) throw new Error(`out-of-range time "${value}" (${ctx})`);
  return `${h.padStart(2, '0')}:${min}`;
}

/** "2026-08-01" from either an ISO string or a date-only field. */
function toIsoDate(value, ctx) {
  const s = String(value ?? '');
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  const de = /^(\d{2})\.(\d{2})\.(\d{2,4})$/.exec(s.trim());
  if (de) {
    const [, d, mo, y] = de;
    return `${y.length === 2 ? `20${y}` : y}-${mo}-${d}`;
  }
  throw new Error(`unparseable date "${value}" (${ctx})`);
}

const minutes = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

function normalizeMonth(records, year, month) {
  if (!records.length) throw new Error(`no records returned for ${year}-${month}`);
  const f = resolveFields(records[0]);

  const days = records.map((r, i) => {
    const ctx = `${PLACE} ${year}-${month} record ${i}`;
    const day = { date: toIsoDate(r[f.date], ctx) };
    for (const p of PRAYERS) day[p] = toHm(r[f[p]], `${ctx} ${p}`);
    return day;
  });

  validate(days, year, month);
  return days;
}

/**
 * Guards against the silent failure modes: a short month, a duplicated day, or
 * times that came back shuffled. Any of these would have the app fire the adhan
 * at the wrong moment, which is worse than showing nothing.
 */
function validate(days, year, month) {
  const problems = [];
  const expected = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (days.length !== expected) {
    problems.push(`expected ${expected} days, got ${days.length}`);
  }

  const seen = new Set();
  for (const d of days) {
    if (seen.has(d.date)) problems.push(`duplicate date ${d.date}`);
    seen.add(d.date);

    if (!d.date.startsWith(`${year}-${String(month).padStart(2, '0')}`)) {
      problems.push(`${d.date} is outside ${year}-${month}`);
    }

    for (let i = 1; i < PRAYERS.length; i++) {
      const [prev, cur] = [PRAYERS[i - 1], PRAYERS[i]];
      if (minutes(d[cur]) <= minutes(d[prev])) {
        problems.push(`${d.date}: ${cur} ${d[cur]} not after ${prev} ${d[prev]}`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`validation failed for ${year}-${month}:\n  - ${problems.join('\n  - ')}`);
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const now = new Date();
  const targets = Array.from({ length: MONTHS_AHEAD }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });

  console.log(`place=${PLACE} months=${targets.map((t) => `${t.year}-${t.month}`).join(', ')}`);
  console.log(`transport=${USE_BROWSER ? 'chromium' : 'fetch'}\n`);

  const written = [];
  for (const [i, { year, month }] of targets.entries()) {
    const url = pageUrl(month);
    const html = USE_BROWSER ? await getHtmlViaBrowser(url) : await getHtml(url);

    let records;
    try {
      records = parsePage(html, year, month);
    } catch (err) {
      // Later months may simply not be published yet; the first one must be.
      if (err instanceof NotPublished && i > 0) {
        console.log(`skip ${year}-${month}: not published yet (${err.message})`);
        continue;
      }
      throw err;
    }

    if (i === 0 && records[0]) console.log(`sample record: ${JSON.stringify(records[0])}\n`);

    const days = normalizeMonth(records, year, month);
    const slug = `${PLACE.toLowerCase().replace(/[^a-z]/g, '')}-${year}-${String(month).padStart(2, '0')}`;
    const file = path.join(OUT_DIR, `${slug}.json`);

    await writeFile(
      file,
      `${JSON.stringify(
        {
          place: PLACE,
          timezone: TIMEZONE,
          month: `${year}-${String(month).padStart(2, '0')}`,
          source: PAGE,
          fetchedAt: new Date().toISOString(),
          days,
        },
        null,
        1,
      )}\n`,
    );

    written.push(slug);
    console.log(`ok  ${file}  ${days.length} days  (${days[0].date} .. ${days.at(-1).date})`);
  }

  // Index of everything on disk, so the app knows what it may ask for offline.
  const months = (await readdir(OUT_DIR))
    .filter((n) => n.endsWith('.json') && n !== 'index.json')
    .map((n) => n.replace(/\.json$/, ''))
    .sort();

  await writeFile(
    path.join(OUT_DIR, 'index.json'),
    `${JSON.stringify({ place: PLACE, timezone: TIMEZONE, updatedAt: new Date().toISOString(), months }, null, 1)}\n`,
  );

  console.log(`\nindex: ${months.length} month(s) available`);
}

export { resolveFields, toHm, toIsoDate, validate, normalizeMonth, parsePage, NotPublished, PRAYERS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nfetch-times failed: ${err.message}`);
    if (err instanceof FetchError && !USE_BROWSER) {
      console.error('hint: the site refused a plain client - retry with --browser');
    }
    process.exit(1);
  });
}
