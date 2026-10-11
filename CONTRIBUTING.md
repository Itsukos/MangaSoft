# Contributing

Bug reports, ideas and pull requests are welcome.

## Running it locally

```
npm install
npm run dev        # server only, no self-restart
npm start          # same as production, with the restart wrapper
```

Node 22.13 or newer. Data goes to `./data` unless `MANGASOFT_DATA` is set, so use a separate folder if you do not
want to touch your real library:

```
MANGASOFT_DATA=/tmp/ms-test PORT=8585 npm run dev
```

## Code layout

| Path | What it is |
|---|---|
| `server/index.js` | Express app, API routes, library scan |
| `server/db.js` | SQLite schema and settings |
| `server/anilist.js`, `mangadex.js`, `nhentai.js` | Metadata providers |
| `server/anime.js`, `animefiles.js` | Video library, ffmpeg playback |
| `server/novels.js` | EPUB parsing and the light novel API |
| `server/detect.js` | OCR chapter detection |
| `server/updater.js`, `run.js` | In-app updates and the restart wrapper |
| `public/` | The web app. Plain JavaScript with a hash router, no build step |
| `release/` | Release signing and packaging |
| `docker/` | Entrypoint and the Unraid template |
| `tools/` | Standalone helpers such as the PDF to EPUB converter |

The front end is deliberately framework-free. Please keep it that way unless there is a strong reason.

## Pull requests

- Keep changes focused. One feature or fix per pull request.
- Match the style of the file you are editing.
- Test the part you touched in a real browser. There is no automated suite yet, so say what you tried.
- Do not commit anything from `data/`, and never commit `release/keys/`.
- By contributing you agree your work is licensed under GPL-3.0-or-later.

## Reporting bugs

Include the MangaSoft version, how you run it (Windows, Docker, Unraid), what you expected, what happened, and the
relevant lines from `server.log`.
