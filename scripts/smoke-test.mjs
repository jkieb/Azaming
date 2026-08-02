/**
 * Drives the real page in a browser against the committed data.
 *
 * The things worth proving cannot be checked by reading the code: that the
 * countdown is computed in Vienna time regardless of the machine's timezone,
 * and that the adhan actually fires when the clock reaches a prayer time. All
 * of it runs on a controlled clock, so the test does not wait for 13:06.
 *
 * The second half covers the ways a display goes quiet in the field rather than
 * on a desk - a tick that arrives late, a suspended audio context, and a month
 * that was not loaded at startup - each of which used to fail silently.
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
  // Served correctly on purpose: the <audio> fallback path will not touch a
  // recording handed over as application/octet-stream.
  '.mp3': 'audio/mpeg',
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
// Records what actually reaches the speakers: a source started into a
// suspended context makes no sound, which is not visible from the page. Both
// output paths are watched, since the app falls back from one to the other.
const spy = () => {
  window.__starts = [];
  window.__contexts = [];
  window.__elementPlays = 0;

  const Real = window.AudioContext;
  window.AudioContext = class extends Real {
    constructor(...args) {
      super(...args);
      window.__ctx = this;
      window.__contexts.push(this);
    }
    createBufferSource() {
      const node = super.createBufferSource();
      const start = node.start.bind(node);
      node.start = (...args) => {
        window.__starts.push({
          state: this.state,
          seconds: node.buffer?.duration ?? 0,
          loop: node.loop,
        });
        return start(...args);
      };
      return node;
    }
  };

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function patched(...args) {
    // Arming an element plays it silently; only an audible play is a prayer.
    if (this.volume > 0) window.__elementPlays += 1;
    return play.apply(this, args);
  };
};

// Only the adhan counts. The unlock blip is zero-length and the keep-alive tone
// is a one-second loop; the recording runs for minutes.
const audible = (page) =>
  page.evaluate(() => window.__starts.filter((s) => s.state === 'running' && s.seconds > 30).length);

/**
 * Advances the virtual clock a tick at a time, leaving real time in between for
 * the fetches and the audio resume the app awaits - neither of which is driven
 * by the virtual clock.
 */
async function settle(p, ticks = 4) {
  for (let i = 0; i < ticks; i += 1) {
    await p.clock.runFor(1100);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A fresh display, opened at `time`, past the audio gate. */
async function open(time) {
  const ctx = await browser.newContext({ timezoneId: 'America/New_York', locale: 'de-AT' });
  const p = await ctx.newPage();
  await p.addInitScript(spy);
  await p.clock.install({ time: new Date(time) });
  await p.goto(base);
  await p.getByRole('button', { name: 'Azan aktivieren' }).click();
  await p.waitForSelector('#times .slot');
  await p.clock.runFor(1000);
  // Startup awaits real network promises, so the first paint does not land at a
  // point virtual time can predict. Wait for it, or assertions race it.
  await p.waitForFunction(() => !document.getElementById('clock').textContent.startsWith('-'));
  return { page: p, context: ctx };
}

const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(err.message));

await page.addInitScript(spy);

// 2026-08-01 13:05:55 Vienna (UTC+2) - five seconds before Duhr at 13:06.
await page.clock.install({ time: new Date('2026-08-01T11:05:55Z') });
await page.goto(base);

await page.getByRole('button', { name: 'Azan aktivieren' }).click();
await page.waitForSelector('#times .slot');
await page.clock.runFor(1000);

await page.waitForFunction(() => !document.getElementById('clock').textContent.startsWith('-'));

const clock = await page.textContent('#clock');
check('clock shows Vienna time, not the host timezone', clock.startsWith('13:05'), clock.trim());

const dhuhr = page.locator('.slot').nth(2);
check('Duhr time rendered from the committed data', (await dhuhr.textContent()).includes('13:06'));

check('next prayer is Duhr', (await page.textContent('#next-name')) === 'Duhr');

const countdown = await page.textContent('#countdown');
check('countdown counts down to Duhr', /^00:00:0[0-9]$/.test(countdown), countdown);

check('Duhr is highlighted as next', await dhuhr.evaluate((n) => n.classList.contains('is-next')));

// Cross the prayer time. Playback resolves through a promise, so the highlight
// lands a tick after the virtual clock moves.
const fired = async (p, nth) => {
  try {
    await p.waitForFunction(
      (i) => document.querySelectorAll('.slot')[i].classList.contains('is-firing'),
      nth,
      { timeout: 2000 },
    );
    return true;
  } catch {
    return false;
  }
};

await page.clock.runFor(6000);
check('adhan fires at the prayer time', await fired(page, 2));
check('and is actually audible', (await audible(page)) === 1);

check(
  'an inaudible keep-alive tone holds the audio device open',
  await page.evaluate(() => window.__starts.some((s) => s.loop)),
);
check('no sound alarm while audio is healthy', await page.isHidden('#alarm'));

// Decoding is what actually has to work at the prayer time - a file that the
// browser cannot decode would otherwise only be noticed when it stays silent.
const adhan = await page.evaluate(async () => {
  try {
    const ctx = new AudioContext();
    const bytes = await (await fetch('audio/adhan.mp3')).arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    return { ok: true, seconds: buffer.duration, channels: buffer.numberOfChannels };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

check(
  'adhan recording decodes in the browser',
  adhan.ok && adhan.seconds > 30 && adhan.seconds < 900,
  adhan.ok ? `${Math.round(adhan.seconds)}s, ${adhan.channels}ch` : adhan.error,
);

check(
  'no stand-in chime warning once a recording is installed',
  !(await page.textContent('#status')).includes('Ersatzton'),
  await page.textContent('#status'),
);

// Roll past midnight into the next day's data.
await page.clock.setFixedTime(new Date('2026-08-01T22:30:00Z')); // 2026-08-02 00:30 Vienna
await page.clock.runFor(1100);
check('date rolls over to the next day', (await page.textContent('#date')).includes('2. August'));
check('next prayer after midnight is Fadjr', (await page.textContent('#next-name')) === 'Fadjr');

check('no uncaught page errors', errors.length === 0, errors.join('; '));
await context.close();

// ---------------------------------------------------------------- late tick
{
  // A hidden tab is throttled to about one timer a minute and a sleeping
  // display stops ticking, so no tick is guaranteed to land in the prayer
  // minute. The adhan has to follow the interval that passed, not the tick.
  const { page: p, context: c } = await open('2026-08-01T11:05:55Z');
  await p.clock.setFixedTime(new Date('2026-08-01T11:07:02Z')); // 62s after Duhr
  await p.clock.runFor(1100);
  check('a tick that arrives a minute late still plays the adhan', await fired(p, 2));
  check('late adhan is audible', (await audible(p)) === 1);
  await c.close();
}

{
  const { page: p, context: c } = await open('2026-08-01T11:05:55Z');
  await p.clock.setFixedTime(new Date('2026-08-01T11:20:00Z')); // 14 minutes after
  await p.clock.runFor(1100);
  check('a prayer missed by more than the catch-up window is not played late', !(await fired(p, 2)));
  await c.close();
}

// ---------------------------------------------------------------- suspended audio
{
  // Screen sleep, an audio device change or the OS pausing the tab suspends the
  // context; sources started into it are silent.
  const { page: p, context: c } = await open('2026-08-01T11:05:55Z');
  await p.evaluate(() => window.__ctx.suspend());
  await p.clock.runFor(6000);
  check('suspended context still highlights the prayer', await fired(p, 2));
  check('a suspended audio context is resumed rather than played into', (await audible(p)) === 1);
  check('and is running again afterwards', (await p.evaluate(() => window.__ctx.state)) === 'running');
  await c.close();
}

// ---------------------------------------------------------------- reload
{
  // The one that used to cost whole days: a browser restart, a crash or a
  // machine reboot put the page back behind the gate, where it waited for a
  // person. An armed display has to come back by itself.
  const { page: p, context: c } = await open('2026-08-01T11:05:55Z');
  await p.reload();
  await p.waitForSelector('#times .slot');
  await p.waitForFunction(() => !document.getElementById('clock').textContent.startsWith('-'));

  check('an armed display starts itself after a reload', await p.isHidden('#gate'));

  await p.clock.setFixedTime(new Date('2026-08-01T11:06:05Z'));
  await p.clock.runFor(1100);
  check('and plays the adhan with nobody there to click', await fired(p, 2));
  check('audible after an unattended restart', (await audible(p)) === 1);
  await c.close();
}

// ---------------------------------------------------------------- dead context
{
  // A context that came back from a system sleep reports "running" while its
  // clock stands still, and silently drops everything started into it. Opened
  // at 11:00 Vienna, well clear of any prayer, so only the repair is measured.
  const { page: p, context: c } = await open('2026-08-01T09:00:00Z');
  await p.evaluate(() => {
    Object.defineProperty(window.__ctx, 'currentTime', { get: () => 12.5 });
  });
  await p.clock.runFor(12000);

  check(
    'a context that died silently is torn down and rebuilt',
    (await p.evaluate(() => window.__contexts.length)) === 2,
  );

  await p.clock.setFixedTime(new Date('2026-08-01T11:06:05Z'));
  await p.clock.runFor(1100);
  check('and the adhan is audible again through the new one', (await audible(p)) === 1);
  await c.close();
}

// ---------------------------------------------------------------- element fallback
{
  // Web Audio can end up in a state no resume() recovers. The <audio> element
  // is a separate path to the same speakers, armed at startup for exactly this.
  const { page: p, context: c } = await open('2026-08-01T11:05:55Z');
  await p.evaluate(() => {
    window.__ctx.resume = () => Promise.resolve();
    return window.__ctx.suspend();
  });
  await p.clock.runFor(6000);

  check('a context that cannot be revived falls back to the audio element', await fired(p, 2));
  check(
    'and the fallback is a real, audible play',
    (await p.evaluate(() => window.__elementPlays)) >= 1,
  );
  check('the sound alarm is up while Web Audio is down', await p.isVisible('#alarm'));
  await c.close();
}

// ---------------------------------------------------------------- month horizon
{
  // Startup loads this month and the next one only. A display left running has
  // to pick up the later months by itself.
  const { page: p, context: c } = await open('2026-08-01T11:05:55Z');
  await p.clock.setFixedTime(new Date('2026-10-05T10:00:00Z')); // 12:00 Vienna, 5 Oct
  await settle(p);
  check(
    'a month that was not loaded at startup is fetched while running',
    (await p.textContent('#status')).includes('Quelle'),
    (await p.textContent('#status')).trim(),
  );
  check(
    'times are shown for the later month',
    (await p.locator('.slot').nth(2).textContent()).includes('12:48'),
  );

  // And the adhan still fires there: Duhr is 12:48 on 5 October (UTC+2).
  await p.clock.setFixedTime(new Date('2026-10-05T10:48:05Z'));
  await p.clock.runFor(1100);
  check('adhan fires in a month loaded after startup', await fired(p, 2));
  await c.close();
}

await browser.close();
server.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
