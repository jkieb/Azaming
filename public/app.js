/*
 * Azaming - prayer times for Vienna with the adhan played at each prayer.
 *
 * Built for a tab that stays open on a wall display. Two consequences shape
 * the whole file:
 *
 *   - Audio needs a user gesture before it will ever play, so nothing starts
 *     until the gate is dismissed once.
 *   - All time arithmetic happens in Europe/Vienna wall-clock seconds rather
 *     than Date objects, so the machine's own timezone and clock offset cannot
 *     shift when the adhan fires.
 */

const PRAYERS = [
  { key: 'fajr', label: 'Fadjr', azan: true },
  { key: 'sunrise', label: 'Shuruk', azan: false },
  { key: 'dhuhr', label: 'Duhr', azan: true },
  { key: 'asr', label: 'Assr', azan: true },
  { key: 'maghrib', label: 'Maghrib', azan: true },
  { key: 'isha', label: 'Ishaa', azan: true },
];

const AZAN_KEYS = PRAYERS.filter((p) => p.azan).map((p) => p.key);

/** How long after a prayer time a slot still reads as the current prayer. */
const FIRE_WINDOW_S = 60;

/**
 * How late the adhan may still start. A tick is not guaranteed to land in the
 * prayer minute - a hidden tab is throttled to roughly one timer a minute, and
 * a display that sleeps stops ticking entirely - so a prayer is played as soon
 * as the app notices it was crossed, up to this much later. Past that the
 * moment has passed and it is skipped rather than played out of time.
 */
const CATCH_UP_S = 300;

const SETTINGS_KEY = 'azaming.settings.v1';

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- time

const viennaParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Vienna',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Current Vienna wall clock: ISO date plus seconds since local midnight. */
function viennaNow() {
  const p = Object.fromEntries(
    viennaParts.formatToParts(new Date()).map(({ type, value }) => [type, value]),
  );
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  const s = Number(p.second);
  return { date: `${p.year}-${p.month}-${p.day}`, h, m, s, sec: h * 3600 + m * 60 + s };
}

const toSeconds = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 3600 + m * 60;
};

const two = (n) => String(n).padStart(2, '0');

function formatDuration(total) {
  const s = Math.max(0, Math.floor(total));
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** "2026-08-01" -> "2026-08-02", without touching the host timezone. */
function nextDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const longDate = new Intl.DateTimeFormat('de-AT', {
  timeZone: 'Europe/Vienna',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

let hijriDate = null;
try {
  hijriDate = new Intl.DateTimeFormat('de-AT-u-ca-islamic-umalqura', {
    timeZone: 'Europe/Vienna',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
} catch {
  // Older engines lack the Islamic calendar; the Hijri line just stays empty.
}

// ---------------------------------------------------------------- data

/** date string -> {fajr, sunrise, ...}. Filled from the monthly JSON files. */
const days = new Map();
let dataMeta = { place: 'Wien', months: [] };

async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

/**
 * Loads the month containing today plus the next one, so the countdown past
 * the last Isha of a month still has a Fajr to point at.
 */
async function loadData() {
  const index = await loadJson('data/index.json');
  dataMeta = index;

  const today = viennaNow().date;
  const slugFor = (iso) => {
    const base = index.place.toLowerCase().replace(/[^a-z]/g, '');
    return `${base}-${iso.slice(0, 7)}`;
  };

  const [year, month] = today.split('-').map(Number);
  const following = month === 12 ? `${year + 1}-01` : `${year}-${two(month + 1)}`;

  const wanted = [slugFor(today), `${index.place.toLowerCase().replace(/[^a-z]/g, '')}-${following}`];
  const available = wanted.filter((slug) => index.months.includes(slug));

  const loaded = await Promise.allSettled(available.map((slug) => loadJson(`data/${slug}.json`)));
  for (const result of loaded) {
    if (result.status !== 'fulfilled') continue;
    for (const day of result.value.days) days.set(day.date, day);
  }

  if (!days.has(today)) {
    throw new Error(`keine Gebetszeiten für ${today} vorhanden`);
  }
}

let loading = false;
let lastAttempt = 0;

/**
 * The display is meant to run for months, and startup only ever loads the
 * current month and the one after it - so the data has to be picked up again
 * as the clock moves on, or the app runs out of days and goes quiet while the
 * later months sit unread on the server.
 */
function ensureData(now, force = false) {
  if (loading) return;
  if (days.has(now.date) && !force) return;
  if (Date.now() - lastAttempt < 60_000) return;

  loading = true;
  lastAttempt = Date.now();
  loadData()
    .catch(() => {
      // Offline or a gap in the published data: the next attempt is a minute
      // away, and the status bar already says what is missing.
    })
    .finally(() => {
      loading = false;
      showStatus();
    });
}

// ---------------------------------------------------------------- audio

/**
 * Web Audio rather than <audio>: the buffer is decoded once up front, so
 * playback at the prayer time starts immediately instead of waiting on a
 * network fetch that may fail exactly when it matters.
 */
const audio = {
  ctx: null,
  buffers: { normal: null, fajr: null },
  hasOwnFajr: false,
  missing: [],
  playing: null,

  async unlock() {
    this.ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    this.ctx.addEventListener('statechange', () => showStatus());
    await this.ctx.resume();
    // A zero-length blip inside the gesture is what actually lifts the block.
    const silent = this.ctx.createBufferSource();
    silent.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    silent.connect(this.ctx.destination);
    silent.start();
  },

  async preload() {
    const files = { normal: 'audio/adhan.mp3', fajr: 'audio/adhan-fajr.mp3' };
    await Promise.all(
      Object.entries(files).map(async ([key, url]) => {
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) throw new Error(String(res.status));
          this.buffers[key] = await this.ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          this.missing.push(url);
        }
      }),
    );
    // One recording is enough; Fajr falls back to the regular adhan.
    this.hasOwnFajr = Boolean(this.buffers.fajr);
    if (!this.buffers.fajr) this.buffers.fajr = this.buffers.normal;
  },

  /**
   * Resolves to true only once sound is actually on its way out. A suspended
   * context accepts sources and plays nothing, so the state is checked rather
   * than assumed - that silence is otherwise invisible until someone notices
   * the adhan never came.
   */
  async play(kind, volume) {
    this.stop();
    if (!(await this.ready())) return false;

    const buffer = this.buffers[kind] ?? this.buffers.normal;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    gain.connect(this.ctx.destination);

    if (!buffer) {
      this.playing = this.chime(gain);
      return true;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start();
    this.playing = source;
    return true;
  },

  /**
   * The context is suspended again by screen sleep, an audio device change or
   * the OS pausing the tab. resume() is enough in most cases; where the browser
   * insists on a fresh gesture it stays suspended and the status bar says so.
   */
  async ready() {
    if (!this.ctx) return false;
    if (this.ctx.state === 'running') return true;
    try {
      await this.ctx.resume();
    } catch {
      // Needs a user gesture - handled by the click listener on the page.
    }
    return this.ctx.state === 'running';
  },

  /**
   * Audible stand-in while no recording is installed - so a display that is
   * set up before the audio file exists still announces the prayer instead of
   * failing silently.
   */
  chime(gain) {
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'sine';
    osc.connect(env);
    env.connect(gain);

    [0, 0.55, 1.1].forEach((offset, i) => {
      osc.frequency.setValueAtTime(i === 1 ? 587.33 : 440, now + offset);
      env.gain.setValueAtTime(0.0001, now + offset);
      env.gain.exponentialRampToValueAtTime(0.5, now + offset + 0.04);
      env.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.5);
    });

    osc.start(now);
    osc.stop(now + 1.8);
    return osc;
  },

  stop() {
    try {
      this.playing?.stop();
    } catch {
      // Already finished - nothing to stop.
    }
    this.playing = null;
  },
};

// ---------------------------------------------------------------- settings

const defaults = { enabled: [...AZAN_KEYS], volume: 0.8, wakeLock: true };

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

let settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota: settings just do not persist.
  }
}

// ---------------------------------------------------------------- wake lock

let wakeLockSentinel = null;

async function applyWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (settings.wakeLock && !wakeLockSentinel && document.visibilityState === 'visible') {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    } catch {
      // Denied or unsupported - the display just sleeps as configured by the OS.
    }
  } else if (!settings.wakeLock && wakeLockSentinel) {
    await wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

// The lock is dropped whenever the tab is hidden and has to be taken again.
document.addEventListener('visibilitychange', applyWakeLock);

// ---------------------------------------------------------------- rendering

const slots = new Map();

function buildSlots() {
  const container = el('times');
  container.replaceChildren();
  for (const prayer of PRAYERS) {
    const slot = document.createElement('div');
    slot.className = `slot${prayer.azan ? '' : ' is-marker'}`;
    slot.innerHTML =
      `<div class="slot-name">${prayer.label}</div>` +
      '<div class="slot-time">--:--</div>' +
      '<div class="slot-meta"></div>';
    container.append(slot);
    slots.set(prayer.key, slot);
  }
}

function buildSettingsUi() {
  const toggles = el('prayer-toggles');
  toggles.replaceChildren();
  for (const prayer of PRAYERS.filter((p) => p.azan)) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = settings.enabled.includes(prayer.key);
    box.addEventListener('change', () => {
      settings.enabled = box.checked
        ? [...new Set([...settings.enabled, prayer.key])]
        : settings.enabled.filter((k) => k !== prayer.key);
      saveSettings();
    });
    label.append(box, Object.assign(document.createElement('span'), { textContent: prayer.label }));
    toggles.append(label);
  }

  const volume = el('volume');
  const out = el('volume-out');
  volume.value = String(Math.round(settings.volume * 100));
  out.textContent = `${volume.value}%`;
  volume.addEventListener('input', () => {
    settings.volume = Number(volume.value) / 100;
    out.textContent = `${volume.value}%`;
    saveSettings();
  });

  const wake = el('wakelock');
  wake.checked = settings.wakeLock;
  wake.disabled = !('wakeLock' in navigator);
  wake.addEventListener('change', () => {
    settings.wakeLock = wake.checked;
    saveSettings();
    applyWakeLock();
  });
}

function setStatus(text, kind = '') {
  const node = el('status');
  node.textContent = text;
  node.className = `status${kind ? ` is-${kind}` : ''}`;
}

/**
 * The next prayer, which may be tomorrow's Fajr. Sunrise is skipped: it marks
 * the end of Fajr rather than a prayer of its own.
 */
function findNext(today, now) {
  for (const prayer of PRAYERS) {
    if (!prayer.azan) continue;
    const at = toSeconds(today[prayer.key]);
    if (at > now.sec) return { prayer, in: at - now.sec };
  }
  const tomorrow = days.get(nextDate(now.date));
  if (!tomorrow) return null;
  // Off by an hour on the two DST nights; only the display is affected, since
  // firing compares same-day wall clock at the moment it happens.
  return { prayer: PRAYERS[0], in: 86400 - now.sec + toSeconds(tomorrow.fajr) };
}

let renderedDate = null;
let dataProblem = null;

/** `date:key` of every prayer already dealt with, played or deliberately skipped. */
const fired = new Set();

/** Crossed but not yet audible, kept so a blocked context is retried. */
const pending = new Map();

/** Vienna wall clock at the previous tick, which may be far in the past. */
let lastTick = null;

function render() {
  const now = viennaNow();

  el('clock').firstChild.nodeValue = `${two(now.h)}:${two(now.m)}`;
  el('seconds').textContent = `:${two(now.s)}`;

  const rolledOver = now.date !== renderedDate;
  if (rolledOver) {
    renderedDate = now.date;
    const asDate = new Date(`${now.date}T12:00:00Z`);
    el('date').textContent = longDate.format(asDate);
    el('hijri').textContent = hijriDate ? hijriDate.format(asDate) : '';
  }

  // A new day may need a month this session has never loaded.
  ensureData(now, rolledOver);

  const today = days.get(now.date);
  if (!today) {
    dataProblem = `Keine Daten für ${now.date} — wird erneut geladen.`;
    showStatus();
    return;
  }
  if (dataProblem) {
    dataProblem = null;
    showStatus();
  }

  const next = findNext(today, now);
  el('next-name').textContent = next ? next.prayer.label : '—';
  el('countdown').textContent = next ? formatDuration(next.in) : '--:--:--';

  for (const prayer of PRAYERS) {
    const slot = slots.get(prayer.key);
    const at = toSeconds(today[prayer.key]);
    slot.querySelector('.slot-time').textContent = today[prayer.key];
    slot.classList.toggle('is-next', next?.prayer.key === prayer.key && next.in < 86400 - now.sec);
    slot.classList.toggle('is-past', at + FIRE_WINDOW_S < now.sec);

    const muted = prayer.azan && !settings.enabled.includes(prayer.key);
    slot.querySelector('.slot-meta').textContent = prayer.azan
      ? muted
        ? 'stumm'
        : ''
      : 'Ende Fadjr';
  }

  fireDue(today, now);
}

/**
 * Queues every prayer crossed since the previous tick. Firing on the interval
 * that has passed rather than on a tick landing inside the prayer minute is
 * what makes this survive a throttled background tab or a display that sleeps.
 */
function fireDue(today, now) {
  const previous = lastTick;
  lastTick = { date: now.date, sec: now.sec };

  // First tick after startup: only the current second, so opening the page
  // never replays a prayer that is already over. After a date change the whole
  // day is in scope - a machine that wakes at 03:26 has to notice a 03:25 Fajr
  // - and the catch-up limit below decides what is still worth playing.
  const since = previous === null ? now.sec - 1 : previous.date === now.date ? previous.sec : -1;

  for (const prayer of PRAYERS) {
    if (!prayer.azan || !settings.enabled.includes(prayer.key)) continue;

    const at = toSeconds(today[prayer.key]);
    const id = `${now.date}:${prayer.key}`;
    if (fired.has(id) || pending.has(id)) continue;
    if (at <= since || at > now.sec) continue;

    pending.set(id, { key: prayer.key, at });
  }

  playPending(now);
}

let playing = false;

function playPending(now) {
  for (const [id, due] of pending) {
    if (now.sec - due.at <= CATCH_UP_S) continue;
    // Too late to still be the call to this prayer.
    pending.delete(id);
    fired.add(id);
  }

  const [id, due] = pending.entries().next().value ?? [];
  if (!id || playing) return;

  playing = true;
  audio
    .play(due.key === 'fajr' ? 'fajr' : 'normal', settings.volume)
    .then((started) => {
      if (!started) return; // Left pending: retried on the next tick.
      pending.delete(id);
      fired.add(id);
      highlight(due.key);
    })
    .catch(() => {})
    .finally(() => {
      playing = false;
      showStatus();
    });
}

/** Highlight for exactly as long as the adhan is audible, whatever its length. */
function highlight(key) {
  const slot = slots.get(key);
  slot.classList.add('is-firing');
  const clear = () => slot.classList.remove('is-firing');
  if (audio.playing) audio.playing.onended = clear;
  else setTimeout(clear, 5_000);
}

// ---------------------------------------------------------------- startup

/**
 * Everything that can keep the adhan from being heard is reported here, most
 * pressing first. A wall display has nobody watching a console, so a fault that
 * only shows up as silence at the next prayer has to be visible before then.
 */
function showStatus() {
  const latest = dataMeta.months?.at(-1) ?? '';
  const source = `Quelle: IGGÖ (derislam.at) · Daten bis ${latest.slice(-7) || 'unbekannt'}`;

  if (dataProblem) {
    setStatus(dataProblem, 'error');
    return;
  }
  if (audio.ctx && audio.ctx.state !== 'running') {
    setStatus('Ton ist blockiert — bitte einmal auf die Seite klicken.', 'error');
    return;
  }
  // Only the regular adhan decides whether we are on the stand-in chime; a
  // missing Fajr recording just means Fajr reuses the regular one.
  if (!audio.buffers.normal) {
    setStatus('Ersatzton aktiv — keine Azan-Aufnahme in public/audio/.', 'warn');
    return;
  }
  if (!audio.hasOwnFajr) {
    setStatus(`${source} · Fadjr nutzt die reguläre Aufnahme`);
    return;
  }
  setStatus(source);
}

async function start() {
  el('gate').hidden = true;
  el('app').hidden = false;

  buildSlots();
  buildSettingsUi();

  try {
    await loadData();
  } catch (err) {
    // Not fatal any more: render keeps retrying, so a display that is switched
    // on before the month's data is published recovers on its own.
    dataProblem = `Gebetszeiten konnten nicht geladen werden: ${err.message}`;
  }

  await audio.preload();
  showStatus();
  applyWakeLock();

  render();
  setInterval(render, 1000);
}

// A context the browser suspended is resumed by any gesture on the page, so
// the recovery the status bar asks for works wherever someone clicks.
document.addEventListener('click', () => {
  audio.ready().then(showStatus);
});

// Coming back to the tab is the other moment worth re-checking: both the wake
// lock and the audio context are dropped while it is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') audio.ready().then(showStatus);
});

el('enable').addEventListener('click', async () => {
  try {
    await audio.unlock();
  } catch {
    // Continue anyway: the times are still worth showing without sound.
  }
  start();
});

el('test').addEventListener('click', () => {
  // The test button is also the check for a blocked context, so it reports.
  audio.play('normal', settings.volume).then(showStatus);
});

el('settings-toggle').addEventListener('click', (event) => {
  const panel = el('settings');
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a bonus; the app works without it.
    });
  });
}
