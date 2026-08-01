/**
 * One-off reconnaissance of the prayer-time source.
 *
 * We cannot reach derislam.at from a plain HTTP client (it answers 403 to
 * anything that is not a real browser), so this drives Chromium and records
 * everything that could serve as a stable monthly data source:
 *
 *   - network traffic, especially JSON/XHR - an internal endpoint is far more
 *     durable to scrape against than rendered markup
 *   - downloadable calendars (pdf/csv/ics/xlsx)
 *   - form controls (city / month pickers) and their option values
 *   - rendered tables and their headers
 *
 * Output goes to out/ and is uploaded as a workflow artifact.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET = process.env.TARGET_URL ?? 'https://www.derislam.at/gebetszeiten';
const OUT = 'out';

const DATA_EXT = /\.(pdf|csv|ics|xlsx?|json|txt)(\?|$)/i;
const DATA_CT = /(json|pdf|csv|calendar|spreadsheet|xml)/i;

const log = (...a) => console.log(...a);
const section = (t) => log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);

/** Filenames derived from URLs need to be flat and safe. */
const slug = (s) => s.replace(/[^a-z0-9._-]+/gi, '_').slice(-120);

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1440, height: 2200 },
  });

  const traffic = [];
  const saved = [];

  context.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] ?? '';
    const interesting = DATA_CT.test(ct) || DATA_EXT.test(url);
    traffic.push({ status: res.status(), ct, url, interesting });
    if (!interesting) return;

    // Capture the payload itself: if there is an API behind the page, its
    // response shape decides the whole ingest design.
    try {
      const body = await res.body();
      const name = `${res.status()}_${slug(new URL(url).pathname + new URL(url).search)}`;
      const file = path.join(OUT, name || 'response.bin');
      await writeFile(file, body);
      saved.push({ url, ct, bytes: body.length, file });
    } catch (err) {
      log(`  ! could not read body of ${url}: ${err.message}`);
    }
  });

  const page = await context.newPage();

  section(`GET ${TARGET}`);
  const resp = await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90_000 });
  log(`status : ${resp?.status()}`);
  log(`final  : ${page.url()}`);
  log(`title  : ${await page.title()}`);

  const html = await page.content();
  await writeFile(path.join(OUT, 'page.html'), html);
  await page.screenshot({ path: path.join(OUT, 'page.png'), fullPage: true });
  log(`html   : ${html.length} bytes -> out/page.html`);

  section('NETWORK (data-shaped responses)');
  const hits = traffic.filter((t) => t.interesting);
  if (hits.length === 0) log('(none - page is likely server-rendered HTML)');
  for (const t of hits) log(`  ${t.status} ${t.ct.padEnd(34)} ${t.url}`);

  section('SAVED PAYLOADS');
  for (const s of saved) log(`  ${String(s.bytes).padStart(9)} B  ${s.file}  <- ${s.url}`);

  section('DOWNLOAD LINKS');
  const links = await page.$$eval('a[href]', (as) =>
    as.map((a) => ({ href: a.href, text: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 90) })),
  );
  const dl = links.filter((l) => DATA_EXT.test(l.href));
  if (dl.length === 0) log('(no direct pdf/csv/ics links in the initial DOM)');
  for (const l of dl) log(`  ${l.href}\n      "${l.text}"`);

  section('FORM CONTROLS (city / month pickers)');
  const selects = await page.$$eval('select', (els) =>
    els.map((el) => ({
      name: el.name || el.id || '(unnamed)',
      count: el.options.length,
      options: [...el.options].slice(0, 40).map((o) => `${o.value} = ${o.textContent.trim()}`),
    })),
  );
  if (selects.length === 0) log('(no <select> elements)');
  for (const s of selects) {
    log(`  <select name="${s.name}"> (${s.count} options)`);
    for (const o of s.options) log(`      ${o}`);
    if (s.count > 40) log(`      ... ${s.count - 40} more`);
  }

  const inputs = await page.$$eval('input:not([type=hidden])', (els) =>
    els.map((el) => `${el.type} name="${el.name || el.id}" value="${el.value}"`),
  );
  log(`\n  inputs: ${inputs.length ? inputs.join('\n          ') : '(none)'}`);

  section('TABLES');
  const tables = await page.$$eval('table', (ts) =>
    ts.map((t) => ({
      headers: [...t.querySelectorAll('th')].map((th) => th.textContent.trim()).slice(0, 15),
      rows: t.querySelectorAll('tr').length,
      sample: [...t.querySelectorAll('tr')]
        .slice(0, 4)
        .map((tr) =>
          [...tr.querySelectorAll('td,th')].map((c) => c.textContent.trim()).join(' | '),
        ),
    })),
  );
  if (tables.length === 0) log('(no <table> - times may be rendered as divs, see page.html)');
  tables.forEach((t, i) => {
    log(`  table #${i}: ${t.rows} rows, headers: ${t.headers.join(' | ') || '(none)'}`);
    t.sample.forEach((r) => log(`      ${r}`));
  });

  section('IFRAMES');
  const frames = page.frames().map((f) => f.url()).filter((u) => u && u !== page.url());
  log(frames.length ? frames.join('\n') : '(none)');

  await writeFile(path.join(OUT, 'traffic.json'), JSON.stringify(traffic, null, 2));
  await browser.close();
  log('\ndone.');
}

main().catch((err) => {
  console.error('discovery failed:', err);
  process.exit(1);
});
