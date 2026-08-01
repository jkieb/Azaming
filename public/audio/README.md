# Audio

Two files go here. Neither is in the repository, because most adhan recordings
circulating online are not licensed for redistribution and that is not a call
to make on someone else's behalf.

| File | Used for |
| --- | --- |
| `adhan.mp3` | Duhr, Assr, Maghrib, Ishaa |
| `adhan-fajr.mp3` | Fajr — the one containing *aṣ-ṣalātu khayrun min an-nawm* |

`adhan-fajr.mp3` is optional; without it Fajr uses `adhan.mp3`.

Until at least `adhan.mp3` exists the app still announces every prayer, using a
short synthesised chime, and says so in the status bar. Nothing breaks — the
sound is just a placeholder.

## Choosing a recording

Check the licence before committing anything. Workable sources:

- Ask the mosque whose times you are using (IGGÖ / Islamisches Zentrum Wien)
  whether you may use their recording.
- Archives that state an explicit licence, e.g. Creative Commons on
  Wikimedia Commons or the Internet Archive.

A YouTube rip is not a licence, whatever the video description says.

## Format

MP3, mono is fine, 128 kbps is plenty for speech. Trim leading silence — the
file starts playing the instant the prayer time is reached. Typical length is
two to four minutes, roughly 2–4 MB, which is well inside the 1 GB GitHub Pages
limit.

The file is decoded once at startup and held in memory, so playback does not
depend on the network at the moment it matters.
