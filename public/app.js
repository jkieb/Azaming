/*
 * Azaming - prayer times for Vienna with the adhan played at each prayer.
 *
 * Built for a tab that stays open on a wall display. Two consequences shape
 * the whole file:
 *
 *   - Sound is a state that has to be held, not a switch that is flipped once.
 *     See the audio section: the gesture only opens the door, and everything
 *     that closes it again afterwards is what actually keeps a display quiet.
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

/** Set once the gate has been passed, so a reload never lands back on it. */
const ARMED_KEY = 'azaming.armed.v1';

/** Survives reloads, so the status bar can answer "did it play at all?". */
const LAST_PLAYED_KEY = 'azaming.lastPlayed.v1';

/**
 * The keep-alive tone: 60 Hz at roughly -60 dBFS. Browsers count a stream
 * quieter than about -72 dBFS as silence, so this is above the line that
 * decides whether the tab is "playing audio", and far below anything a person
 * in the room can hear - at 60 Hz most of all, where the ear is least
 * sensitive. One second holds exactly 60 cycles, so the buffer loops seamlessly.
 */
const KEEPALIVE_HZ = 60;
const KEEPALIVE_LEVEL = 0.001;

/**
 * Ticks of a frozen audio clock before the output is treated as dead. Several
 * ticks can share one timestamp when a tab is woken and fires them back to
 * back, so this is deliberately a good ten seconds rather than one reading.
 */
const STALL_TICKS = 10;

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
 * Switching the sound on is not a moment, it is a state that has to be held.
 *
 * A gesture only opens the door. What keeps a display quiet for months is
 * everything that happens afterwards, and none of it announces itself:
 *
 *   - A reload - a browser restart, a crash, a reboot, or a tab the OS reaped
 *     for memory - used to put the page back behind the gate, where it waited
 *     for someone to walk past. That is the difference between missing one
 *     prayer and missing every prayer until a human notices.
 *   - A tab producing no sound is throttled to about one timer a minute and may
 *     be frozen outright; a tab that is producing sound is left alone by both.
 *   - Screen sleep, an audio device change or the OS pausing the tab suspend
 *     the context. Worse, after a system sleep it can come back reporting
 *     "running" while its clock stands still and nothing reaches the speakers -
 *     sources started into it are accepted and silently dropped.
 *
 * So the permission is remembered and re-taken unprompted, the output is held
 * open by an inaudible keep-alive, and that keep-alive doubles as the health
 * probe: while the audio clock advances the device is demonstrably alive, and
 * when it stops the context is rebuilt rather than played into.
 *
 * Playback goes through an <audio> element first and Web Audio second, which
 * is the opposite of where this started. Three reasons, all learned from a
 * 2 GB iPad:
 *
 *   - decodeAudioData holds the recording as uncompressed PCM for as long as
 *     the page lives. Three minutes of stereo is some 67 MB, which on a small
 *     device is a good way to get the whole tab reaped - and a reaped tab is
 *     exactly the silence this file exists to prevent. The element streams
 *     from the same service-worker cache and holds a few megabytes.
 *   - On iOS a muted device silences Web Audio but not an <audio> element, so
 *     the element is the path that survives someone tapping the wrong button.
 *   - Web Audio is still the better instrument once it works, so it stays as
 *     the fallback - and only then is anything decoded.
 */

/**
 * iOS is its own case throughout: it suspends an AudioContext the moment the
 * screen locks or the browser backgrounds, and it grants no unattended
 * playback the way engagement-based policies elsewhere do. iPadOS reports
 * itself as a Mac, so touch points are what tell them apart.
 */
const isIOS =
  /iP(hone|ad|od)/.test(navigator.platform ?? '') ||
  (/Mac/.test(navigator.platform ?? '') && navigator.maxTouchPoints > 1);

const AUDIO_FILES = { normal: 'audio/adhan.mp3', fajr: 'audio/adhan-fajr.mp3' };

const audio = {
  ctx: null,
  /** Which recordings exist on the server, decided without downloading them. */
  available: { normal: false, fajr: false },
  buffers: { normal: null, fajr: null },
  elements: { normal: null, fajr: null },
  elementsArmed: false,
  hasOwnFajr: false,
  keepAlive: null,
  keepAliveEl: null,
  playing: null,
  viaElement: false,
  /** Vienna time of the last playback that actually started, for the status bar. */
  lastPlayed: null,

  /** Last audio-clock reading and how many ticks it has failed to advance. */
  clock: -1,
  stalls: 0,

  /** Opens a context and starts holding it open. Also used to replace a dead one. */
  open() {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.ctx.addEventListener('statechange', () => showStatus());
    this.clock = -1;
    this.stalls = 0;
    this.startKeepAlive();
  },

  /**
   * A tone nobody can hear, running for as long as the app does. It keeps the
   * tab counted as playing audio - which keeps its timers at one a second
   * instead of one a minute, and keeps the browser from freezing it - and it
   * keeps the output device open instead of letting it be torn down and
   * re-acquired around every prayer.
   */
  startKeepAlive() {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sin((2 * Math.PI * KEEPALIVE_HZ * i) / rate) * KEEPALIVE_LEVEL;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.ctx.destination);
    source.start();
    this.keepAlive = source;
  },

  /**
   * The same idea for iOS, where the Web Audio tone above buys nothing: what
   * iOS keeps alive is a *media session*, so the keep-alive has to be a media
   * element. While one is playing the page keeps its audio session and its
   * claim on the output, instead of being torn down at the first lock screen.
   * The clip is generated rather than shipped, so there is no second asset to
   * keep in step with the recording.
   */
  startElementKeepAlive() {
    if (this.keepAliveEl) return;
    const el = new Audio(quietWavUrl());
    el.loop = true;
    el.volume = 1; // The clip itself is near-silence; see quietWavUrl().
    this.keepAliveEl = el;
    el.play().catch(() => {
      // Not unlocked yet. Every arm() tries again.
    });
  },

  /**
   * Brings sound up - from a gesture, or unprompted on a display that has been
   * through the gate before. The unprompted attempt is worth making where a
   * page that plays sound daily earns the right to do it unasked, or where the
   * display runs as an installed app. iOS grants neither, so there the banner
   * is the plan: it asks for one touch instead of failing silently.
   */
  async arm() {
    if (!this.ctx || this.ctx.state === 'closed') this.open();
    if (this.ctx) {
      try {
        await this.ctx.resume();
      } catch {
        // Refused without a gesture; the banner asks for one.
      }
      // A zero-length blip inside the gesture is what actually lifts the block.
      if (this.ctx.state === 'running') {
        const blip = this.ctx.createBufferSource();
        blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        blip.connect(this.ctx.destination);
        blip.start();
      }
    }
    if (isIOS) {
      this.startElementKeepAlive();
      this.keepAliveEl?.play().catch(() => {});
    }
    await this.armElements();
    return this.live();
  },

  /**
   * Unlocking the recordings costs one silent play() inside a gesture we are
   * already in. Done up front, because the first time an element is asked to
   * play must not be the moment a prayer is due.
   */
  async armElements() {
    for (const el of new Set(Object.values(this.elements))) {
      if (!el || el === this.playing) continue;
      try {
        el.volume = 0;
        await el.play();
        el.pause();
        el.currentTime = 0;
        this.elementsArmed = true;
      } catch {
        // Still locked. The banner asks for the touch that lifts it.
      }
    }
  },

  /**
   * Finds out which recordings exist without downloading them. Nothing is
   * decoded here: the element path needs no decode at all, and the Web Audio
   * fallback decodes only if it is ever actually reached.
   */
  async preload() {
    await Promise.all(
      Object.entries(AUDIO_FILES).map(async ([key, url]) => {
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (!res.ok) return;
          this.available[key] = true;
          const el = new Audio(url);
          el.preload = 'auto';
          this.elements[key] = el;
        } catch {
          // Offline, or no such recording. Covered by the fallbacks below and
          // reported in the status bar.
        }
      }),
    );
    // One recording is enough; Fajr falls back to the regular adhan.
    this.hasOwnFajr = this.available.fajr;
    if (!this.elements.fajr) this.elements.fajr = this.elements.normal;
    await this.armElements();
    describeMedia();
  },

  /**
   * Decodes on demand, for the Web Audio fallback only. The cost of holding
   * the result is the reason the element path goes first, so it is paid at the
   * point it buys something and not before.
   */
  async ensureBuffer(kind) {
    if (this.buffers[kind]) return this.buffers[kind];
    const key = this.available[kind] ? kind : 'normal';
    if (!this.available[key] || !this.ctx) return null;
    try {
      const res = await fetch(AUDIO_FILES[key], { cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      this.buffers[kind] = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      // Undecodable or gone: the chime below still announces the prayer.
    }
    return this.buffers[kind];
  },

  /**
   * Would a prayer starting right now be heard? Not "did we call start()" -
   * a suspended context accepts sources and plays nothing, and a context left
   * behind by a system sleep does the same while still calling itself running.
   */
  live() {
    if (!this.ctx) return this.elementsArmed;
    return this.ctx.state === 'running' && this.stalls < STALL_TICKS;
  },

  /**
   * Run on every tick, before anything can be due. The audio clock is the
   * honest signal: while the keep-alive tone renders it advances, and if it
   * stops while the context still claims to be running then the device is gone
   * and everything started from here on would be silent. That failure used to
   * stay invisible until a prayer passed without a sound, so it is repaired
   * here instead of being discovered there.
   */
  check() {
    if (!this.ctx || this.ctx.state === 'closed') this.open();
    if (isIOS && this.keepAliveEl?.paused) this.keepAliveEl.play().catch(() => {});
    if (!this.ctx) return;

    if (this.ctx.state !== 'running') {
      this.clock = -1;
      this.stalls = 0;
      this.resume();
      return;
    }

    const now = this.ctx.currentTime;
    this.stalls = now > this.clock ? 0 : this.stalls + 1;
    this.clock = now;
    if (this.stalls >= STALL_TICKS) this.recycle();
  },

  resume() {
    try {
      this.ctx.resume()?.catch?.(() => {});
    } catch {
      // Needs a gesture - the banner asks for one and any touch delivers it.
    }
  },

  /**
   * Replaces a context that is running on paper and dead in fact. Anything
   * already decoded outlives it - an AudioBuffer belongs to no context in
   * particular - so nothing has to be fetched again.
   */
  recycle() {
    const dead = this.ctx;
    this.open();
    try {
      dead.close()?.catch?.(() => {});
    } catch {
      // Already gone; nothing to release.
    }
    if (this.ctx !== dead) this.resume();
  },

  /**
   * Resolves to true only once sound is actually on its way out, through
   * whichever path still works. The element goes first; Web Audio is what
   * catches the case where the element is refused.
   */
  async play(kind, volume) {
    this.stop();
    const started = (await this.playElement(kind, volume)) || (await this.playBuffer(kind, volume));
    if (started) this.notePlayed();
    return started;
  },

  async playElement(kind, volume) {
    const el = this.elements[kind] ?? this.elements.normal;
    if (!el) return false;
    try {
      el.currentTime = 0;
      el.volume = volume;
      await el.play();
      this.playing = el;
      this.viaElement = true;
      return true;
    } catch {
      return false;
    }
  },

  async playBuffer(kind, volume) {
    if (!(await this.ready())) return false;

    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    gain.connect(this.ctx.destination);
    this.viaElement = false;

    const buffer = await this.ensureBuffer(kind);
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
   * insists on a fresh gesture it stays suspended and the banner says so.
   */
  async ready() {
    if (!this.ctx) return false;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // Needs a user gesture - handled by the listeners on the page.
      }
    }
    return this.ctx.state === 'running' && this.stalls < STALL_TICKS;
  },

  /**
   * Remembered across reloads, because the question the morning after a silent
   * prayer is always the same: did it play and nobody heard it, or did it never
   * play? Guessing at that is what cost the most time here.
   */
  notePlayed() {
    const now = viennaNow();
    this.lastPlayed = `${now.date} ${two(now.h)}:${two(now.m)}`;
    try {
      localStorage.setItem(LAST_PLAYED_KEY, this.lastPlayed);
    } catch {
      // Not persisted; the running session still shows it.
    }
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
      if (this.viaElement) this.playing?.pause();
      else this.playing?.stop();
    } catch {
      // Already finished - nothing to stop.
    }
    this.playing = null;
  },
};

/**
 * A one-second WAV of near-silence, as a blob URL. Same level as the Web Audio
 * keep-alive and for the same reason: quiet enough that nobody in the room
 * hears it, loud enough that the platform does not write the stream off as
 * silence and hand the audio session back.
 */
function quietWavUrl() {
  const rate = 8000;
  const samples = rate;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  const peak = Math.round(32767 * KEEPALIVE_LEVEL);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * KEEPALIVE_HZ * i) / rate) * peak), true);
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/**
 * Tells the OS what is playing, so a lock screen or a media key acts on the
 * adhan rather than on whatever the device last played.
 */
function describeMedia() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Azan',
      artist: 'Azaming',
      album: dataMeta.place ?? 'Wien',
    });
  } catch {
    // Optional decoration; nothing depends on it.
  }
}

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

  // Before anything can be due: a context that has died is rebuilt here, so a
  // prayer in this same tick plays into an output that was just proved alive.
  audio.check();
  el('alarm').hidden = audio.live();

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

  // The morning after a silent prayer, this is the only question worth
  // answering, and it cannot be reconstructed from anything else on screen.
  const last = audio.lastPlayed ? ` · Azan zuletzt ${audio.lastPlayed}` : ' · Azan noch nie gespielt';

  const live = audio.live();
  el('alarm').hidden = live;

  if (!live) {
    setStatus(`Ton ist blockiert — bitte einmal auf die Seite tippen.${last}`, 'error');
    return;
  }
  if (dataProblem) {
    setStatus(dataProblem, 'error');
    return;
  }
  // Only the regular adhan decides whether we are on the stand-in chime; a
  // missing Fajr recording just means Fajr reuses the regular one.
  if (!audio.available.normal) {
    setStatus('Ersatzton aktiv — keine Azan-Aufnahme in public/audio/.', 'warn');
    return;
  }
  const fajr = audio.hasOwnFajr ? '' : ' · Fadjr nutzt die reguläre Aufnahme';
  setStatus(`${source}${fajr}${last}`);
}

async function start() {
  buildSlots();
  buildSettingsUi();

  try {
    audio.lastPlayed = localStorage.getItem(LAST_PLAYED_KEY);
  } catch {
    // Private mode: the line just reads "noch nie gespielt" until one plays.
  }

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

/**
 * Whether this display has ever been through the gate. Remembering it is what
 * turns the gate from a thing that blocks every reload into a thing that is
 * seen once, on the day the display is set up.
 */
function wasArmed() {
  try {
    return localStorage.getItem(ARMED_KEY) === '1';
  } catch {
    return false;
  }
}

async function boot() {
  // Ahead of the await, so an armed display never flashes the gate on reload.
  el('gate').hidden = true;
  el('app').hidden = false;
  try {
    await audio.arm();
  } catch {
    // Continue anyway: the times are still worth showing without sound.
  }
  start();
}

// A blocked context is lifted by any gesture on the page, so the recovery the
// banner asks for works wherever someone touches the screen - and it re-arms
// the whole path, not just the context, since the element may be locked too.
const rearm = () => {
  if (!el('app').hidden) audio.arm().then(showStatus, () => {});
};
document.addEventListener('pointerdown', rearm);
document.addEventListener('keydown', rearm);

// Coming back to the tab is the other moment worth re-checking: both the wake
// lock and the audio context are dropped while it is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') audio.ready().then(showStatus);
});

el('enable').addEventListener('click', () => {
  try {
    localStorage.setItem(ARMED_KEY, '1');
  } catch {
    // Private mode: the gate comes back on the next load, nothing else breaks.
  }
  boot();
});

// The display was armed on some earlier visit, so it starts itself. If the
// browser refuses to play unprompted the banner says so - which is still far
// better than a page sitting behind a button nobody is there to press.
if (wasArmed()) boot();

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
