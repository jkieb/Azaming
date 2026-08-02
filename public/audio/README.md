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

The file is decoded once at startup and held in memory, so playback does not
depend on the network at the moment it matters. It is also loaded a second time
into an `<audio>` element kept as a fallback path to the speakers, so a few
megabytes is the sensible ceiling.
