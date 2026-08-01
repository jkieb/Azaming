/**
 * Pulls prayer times from the IGGOe Directus API into public/data/.
 *
 * Runs monthly (see .github/workflows/update-times.yml) and always fetches a
 * few months ahead, so a failed run - or two - never leaves the app without
 * data. Nothing is written unless it validates.
 *
 * The API is the same one derislam.at's own frontend calls. If it ever starts
 * refusing plain HTTP clients the way the main site does, --browser routes the
 * identical request through Chromium instead.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const API = 'https://directus.derislam.at/items/prayer_times';
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

function apiUrl(year, month) {
  const filter = {
    'month(date)': { _eq: month },
    'year(date)': { _eq: year },
    place: { _eq: PLACE },
  };
  const qs = new URLSearchParams();
  qs.append('sort[]', 'date');
  qs.append('fields[]', '*');
  qs.append('filter', JSON.stringify(filter));
  return `${API}?${qs}`;
}

/**
 * The API sits behind Cloudflare, which challenges requests that *claim* to be
 * a browser - a spoofed Chrome user-agent gets a 403 because the TLS
 * fingerprint gives it away, and so does any set of browser-ish headers.
 * Identifying honestly is what gets through (verified by scripts/probe-api.mjs),
 * so do not add accept-language or a browser user-agent here.
 */
const API_HEADERS = {
  accept: 'application/json',
  'user-agent': 'Azaming/1.0 (+https://github.com/jkieb/Azaming)',
  referer: 'https://www.derislam.at/gebetszeiten',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cloudflare tends to challenge the first request on a cold connection and let
 * later ones through unchanged - the same URL and headers that fail here
 * return 200 once the client has been talking to the host for a moment. So a
 * single 403 says nothing; only a run of them means we are actually refused.
 */
async function getJson(url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, { headers: API_HEADERS });
    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');
    const challenged = /just a moment/i.test(body);
    last = new FetchError(
      `HTTP ${res.status} for ${url}` + (challenged ? ' - blocked by a Cloudflare challenge' : ''),
    );

    if (attempt < attempts) {
      console.log(`  attempt ${attempt}/${attempts}: HTTP ${res.status}${challenged ? ' (challenge)' : ''}, retrying`);
      await sleep(1500 * attempt);
    }
  }
  throw last;
}

/** Fallback path: issue the same request from inside a real browser context. */
async function getJsonViaBrowser(url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'de-AT',
    });
    const page = await ctx.newPage();
    // Same-origin request from the site itself, so cookies and referer match.
    await page.goto('https://www.derislam.at/gebetszeiten', { waitUntil: 'domcontentloaded' });
    const body = await page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }, url);
    return JSON.parse(body);
  } finally {
    await browser.close();
  }
}

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
        `  -> the API schema changed; update FIELD_ALIASES in scripts/fetch-times.mjs`,
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
  for (const { year, month } of targets) {
    const url = apiUrl(year, month);
    const payload = USE_BROWSER ? await getJsonViaBrowser(url) : await getJson(url);
    const records = payload.data ?? payload;

    if (targets[0].year === year && targets[0].month === month && records[0]) {
      console.log(`sample record: ${JSON.stringify(records[0])}\n`);
    }

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
          source: 'https://www.derislam.at/gebetszeiten',
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

export { resolveFields, toHm, toIsoDate, validate, normalizeMonth, PRAYERS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nfetch-times failed: ${err.message}`);
    if (err instanceof FetchError && !USE_BROWSER) {
      console.error('hint: the API refused a plain client - retry with --browser');
    }
    process.exit(1);
  });
}
