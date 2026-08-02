# Audio

| File | Used for | Status |
| --- | --- | --- |
| `adhan.mp3` | Duhr, Assr, Maghrib, Ishaa — and Fajr while no Fajr file exists | present, 3:09, supplied as an Islamisches Zentrum Wien recording |
| `adhan-fajr.mp3` | Fajr — the one containing *aṣ-ṣalātu khayrun min an-nawm* | not present |

`adhan-fajr.mp3` is optional. Without it Fajr uses `adhan.mp3` and the status
bar says so.

If `adhan.mp3` is ever removed the app still announces every prayer with a
short synthesised chime and flags it in the status bar — nothing breaks, the
sound is just a placeholder.

## Replacing a recording

Check the licence before committing anything. A YouTube rip is not a licence,
whatever the video description says. Workable sources are the mosque itself, or
an archive that states an explicit licence such as Creative Commons on
Wikimedia Commons.

## Format

MP3, mono is fine, 128 kbps is plenty for speech. Trim leading silence — the
file starts playing the instant the prayer time is reached. Typical length is
two to four minutes, roughly 2–4 MB, which is well inside the 1 GB GitHub Pages
limit.

Playback streams the file from an `<audio>` element fed by the service worker
cache, so it does not depend on the network at the moment it matters and it does
not hold the recording in memory uncompressed. Length is therefore cheap — but
keep it inside a few megabytes anyway, since the file is cached in full and the
Web Audio fallback, if it is ever reached, does decode the whole thing (roughly
10 MB of RAM per minute of stereo).
