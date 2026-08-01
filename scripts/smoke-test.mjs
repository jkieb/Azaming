/**
 * Drives the real page in a browser against the committed data.
 *
 * The two things worth proving cannot be checked by reading the code: that the
 * countdown is computed in Vienna time regardless of the machine's timezone,
 * and that the adhan actually fires when the clock reaches a prayer time.
 * Both are done with a controlled clock, so the test does not wait for 13:06.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve('public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  // Use a preinstalled Chromium when one is present, so the test does not
  // depend on the exact browser build this Playwright release expects.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  // Deliberately not Vienna: the app must not depend on the host timezone.
  timezoneId: 'America/New_York',
  locale: 'de-AT',
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(err.message));

// 2026-08-01 13:05:55 Vienna (UTC+2) - five seconds before Duhr at 13:06.
await page.clock.install({ time: new Date('2026-08-01T11:05:55Z') });
await page.goto(base);

await page.getByRole('button', { name: 'Azan aktivieren' }).click();
await page.waitForSelector('#times .slot');
await page.clock.runFor(1000);

// Startup awaits real network promises, so the first paint does not land at a
// point virtual time can predict. Wait for it, or the first assertion races it.
await page.waitForFunction(() => !document.getElementById('clock').textContent.startsWith('-'));

const clock = await page.textContent('#clock');
check('clock shows Vienna time, not the host timezone', clock.startsWith('13:05'), clock.trim());

const dhuhr = page.locator('.slot').nth(2);
check('Duhr time rendered from the committed data', (await dhuhr.textContent()).includes('13:06'));

check('next prayer is Duhr', (await page.textContent('#next-name')) === 'Duhr');

const countdown = await page.textContent('#countdown');
check('countdown counts down to Duhr', /^00:00:0[0-9]$/.test(countdown), countdown);

check('Duhr is highlighted as next', await dhuhr.evaluate((n) => n.classList.contains('is-next')));

// Cross the prayer time.
await page.clock.runFor(6000);
check('adhan fires at the prayer time', await dhuhr.evaluate((n) => n.classList.contains('is-firing')));

check(
  'missing audio file is reported rather than failing silently',
  (await page.textContent('#status')).includes('Ersatzton'),
);

// Roll past midnight into the next day's data.
await page.clock.setFixedTime(new Date('2026-08-01T22:30:00Z')); // 2026-08-02 00:30 Vienna
await page.clock.runFor(1100);
check('date rolls over to the next day', (await page.textContent('#date')).includes('2. August'));
check('next prayer after midnight is Fadjr', (await page.textContent('#next-name')) === 'Fadjr');

check('no uncaught page errors', errors.length === 0, errors.join('; '));

await browser.close();
server.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
