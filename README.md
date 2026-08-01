# Azaming

An Azan app, with every new prayer time a small Muazin audio starting.

Prayer times for Vienna, shown on a screen that stays on, with the adhan
played at each prayer. `public/` is a static site with no build step — what is
in the repository is what ships.

## The app

Built for a browser tab left open on a wall display, which is what makes full
audio dependable: browsers only play sound in a foreground tab after a user
gesture, so the page opens on a one-time **Azan aktivieren** gate and runs from
there. On a phone with the screen locked no web app can play a full adhan; that
needs a native wrapper, which this is not.

- Clock, Gregorian and Hijri date, the day's six times, and a countdown to the
  next prayer
- Adhan at each prayer, per-prayer on/off, volume, and a test button
- Screen Wake Lock so the display does not sleep
- Works offline through a service worker once loaded

Times are handled in Europe/Vienna wall-clock seconds rather than `Date`
objects, so the adhan fires at the right moment regardless of how the display
machine's own timezone is set.

The adhan itself is `public/audio/adhan.mp3`. A separate Fajr recording is
optional — see [`public/audio/README.md`](public/audio/README.md). With no
recording at all the app still announces every prayer, using a synthesised
chime, and says so in the status bar.

### Deployment

`.github/workflows/deploy.yml` publishes `public/` to GitHub Pages on every
change, including the monthly data commit. Set *Settings → Pages → Source* to
**GitHub Actions** once; there is nothing else to configure.

## Prayer time data

Times come from the IGGÖ (Islamische Glaubensgemeinschaft in Österreich) via
[derislam.at/gebetszeiten](https://www.derislam.at/gebetszeiten). The site is a
Directus frontend, so the times are available as JSON rather than having to be
scraped out of markup:

```
https://directus.derislam.at/items/prayer_times
  ?sort[]=date&fields[]=*
  &filter={"month(date)":{"_eq":8},"year(date)":{"_eq":2026},"place":{"_eq":"Wien"}}
```

`place` accepts Wien, Graz, Linz, Salzburg, Innsbruck, Klagenfurt, Bregenz,
Eisenstadt and St.-Pölten. Times are local Vienna wall-clock and already
account for daylight saving.

### The monthly job

`.github/workflows/update-times.yml` runs on the 1st of each month and commits
to `public/data/`. It fetches **three months ahead**, not the current one — a
failed run then costs buffer instead of availability, and there is time to fix
the cause before the app notices.

Nothing is written unless it validates: a complete month, no duplicate dates,
and times in ascending order within each day. If validation fails the existing
files stay untouched and an issue is filed, because a broken source would
otherwise stay invisible until the buffer ran out.

API column names (`fadjr`, `shuruk`, `duhr`, `assr`, `maghrib`, `ishaa`) are
matched by alias rather than exact string, so a rename in the CMS fails loudly
instead of writing nulls.

### Cloudflare

The API sits behind Cloudflare, which challenges the first request on a cold
connection. That is why `getJson` retries before giving up — a single 403 means
nothing on its own. Two things that do **not** help, both verified with
`scripts/probe-api.mjs`: a spoofed browser user-agent (403 — the TLS
fingerprint contradicts it, so identifying honestly works better) and rewriting
the `month(date)` filter (the query shape is not what gets refused).

If plain HTTP ever stops working entirely, the job falls back to issuing the
same request from a real Chromium.

### Data format

`public/data/wien-YYYY-MM.json`:

```json
{
  "place": "Wien",
  "timezone": "Europe/Vienna",
  "month": "2026-08",
  "source": "https://www.derislam.at/gebetszeiten",
  "fetchedAt": "2026-08-01T15:58:52.000Z",
  "days": [
    { "date": "2026-08-01", "fajr": "03:25", "sunrise": "05:23",
      "dhuhr": "13:06", "asr": "17:11", "maghrib": "20:39", "isha": "22:17" }
  ]
}
```

`public/data/index.json` lists the months currently on disk.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | Validation rules for the fetched data |
| `npm run smoke` | Drives the page in a browser on a controlled clock |
| `npm run serve` | Serve `public/` locally |
| `npm run fetch` | Pull months into `public/data/` (`--browser` to force Chromium) |
| `node scripts/probe-api.mjs` | Which transports and query shapes the API accepts |
| `npm run discover` | Re-inspect derislam.at if the API ever moves |

`npm run smoke` fast-forwards a virtual clock to a prayer time and asserts the
adhan fires — set `CHROMIUM_PATH` to reuse a Chromium you already have.

`PLACE` and `MONTHS_AHEAD` configure the fetch; they default to `Wien` and `3`.
