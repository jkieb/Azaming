/**
 * Finds the cheapest transport that the Directus API accepts.
 *
 * The monthly job currently falls back to Chromium because a plain fetch is
 * refused. If a header set is enough to get through, the browser download is
 * pure waste; if nothing is, this says so definitively.
 */

const url = (filter, extra = []) =>
  `https://directus.derislam.at/items/prayer_times?${new URLSearchParams([
    ['sort[]', 'date'],
    ['fields[]', '*'],
    ...extra,
    ['filter', JSON.stringify(filter)],
  ])}`;

const URL_ = url({ place: { _eq: 'Wien' } }, [['limit', '1']]);

/**
 * Same headers, different filters. `month(date)` reads like a SQL function
 * call, which is exactly what a WAF's injection rules look for - so the query
 * shape, not the client, may be what gets refused.
 */
const FILTERS = {
  'month()/year() functions': url({
    'month(date)': { _eq: 8 },
    'year(date)': { _eq: 2026 },
    place: { _eq: 'Wien' },
  }),
  'date range _gte/_lte': url({
    date: { _gte: '2026-08-01', _lte: '2026-08-31' },
    place: { _eq: 'Wien' },
  }),
  'date range _between': url({
    date: { _between: ['2026-08-01', '2026-08-31'] },
    place: { _eq: 'Wien' },
  }),
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VARIANTS = {
  'bare fetch': {},
  'accept json only': { accept: 'application/json' },
  'project user-agent': {
    accept: 'application/json',
    'user-agent': 'Azaming/1.0 (+https://github.com/jkieb/Azaming)',
    referer: 'https://www.derislam.at/gebetszeiten',
  },
  'browser user-agent': {
    accept: 'application/json',
    'user-agent': BROWSER_UA,
  },
  'browser user-agent + origin': {
    accept: 'application/json',
    'user-agent': BROWSER_UA,
    origin: 'https://www.derislam.at',
    referer: 'https://www.derislam.at/',
    'accept-language': 'de-AT,de;q=0.9',
  },
};

console.log(`GET ${URL_}\n`);

let anyOk = false;
for (const [name, headers] of Object.entries(VARIANTS)) {
  const started = Date.now();
  try {
    const res = await fetch(URL_, { headers });
    const body = await res.text();
    const ok = res.ok && body.trimStart().startsWith('{');
    anyOk ||= ok;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${res.status} ` +
        `${String(res.headers.get('content-type')).slice(0, 30).padEnd(32)} ${Date.now() - started}ms`,
    );
    console.log(`      server=${res.headers.get('server') ?? '-'} cf-ray=${res.headers.get('cf-ray') ?? '-'}`);
    console.log(`      body: ${body.replace(/\s+/g, ' ').slice(0, 160)}\n`);
  } catch (err) {
    console.log(`FAIL  ${name.padEnd(28)} threw after ${Date.now() - started}ms`);
    console.log(`      ${err.name}: ${err.message}${err.cause ? ` (cause: ${err.cause.message ?? err.cause})` : ''}\n`);
  }
}

console.log(anyOk ? 'at least one plain-HTTP variant works' : 'no plain-HTTP variant works - browser transport required');

// Second question: with a header set that is known to pass, which query shapes
// survive? This is what decides whether the monthly job needs a browser.
console.log('\n--- filter shapes, using the header set that passed above ---\n');

const WORKING_HEADERS = VARIANTS['project user-agent'];

for (const [name, target] of Object.entries(FILTERS)) {
  const started = Date.now();
  try {
    const res = await fetch(target, { headers: WORKING_HEADERS });
    const body = await res.text();
    const ok = res.ok && body.trimStart().startsWith('{');
    const rows = ok ? (JSON.parse(body).data ?? []).length : 0;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${res.status}  ${String(rows).padStart(3)} rows  ${Date.now() - started}ms`,
    );
    if (!ok) console.log(`      body: ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
  } catch (err) {
    console.log(`FAIL  ${name.padEnd(26)} threw: ${err.message}`);
  }
}
