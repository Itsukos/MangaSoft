# Third-party software and services

MangaSoft is licensed under GPL-3.0-or-later. It builds on the projects below, each under its own license. Their
license files are in `node_modules/<package>/` after `npm install`, and in the Docker image.

## Bundled in this repository

| Project | Where | License |
|---|---|---|
| [JASSUB](https://github.com/ThaUnknown/jassub) | `public/vendor/jassub/` (built by `npm run build:vendor`) | See `public/vendor/jassub/LICENSE`. It bundles libass, FreeType, HarfBuzz, FriBidi and others under their own permissive and LGPL licenses. |

## npm dependencies

| Project | Used for | License |
|---|---|---|
| [Express](https://expressjs.com) | HTTP server | MIT |
| [hls.js](https://github.com/video-dev/hls.js) | HLS playback in the browser | Apache-2.0 |
| [node-stream-zip](https://github.com/antelle/node-stream-zip) | Reading CBZ and EPUB archives | MIT |
| [sharp](https://sharp.pixelplumbing.com) | Thumbnails and image handling (uses libvips) | Apache-2.0 |
| [tesseract.js](https://github.com/naptha/tesseract.js) | OCR for chapter detection | Apache-2.0 |
| [JASSUB](https://github.com/ThaUnknown/jassub) | Styled ASS subtitles | See above |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | ffmpeg binary on Windows | GPL-3.0 (ffmpeg build) |
| [@ffprobe-installer/ffprobe](https://github.com/SavageCore/node-ffprobe-installer) | ffprobe binary | LGPL-3.0 |
| [esbuild](https://esbuild.github.io), [adm-zip](https://github.com/cthackers/adm-zip) | Build tooling (dev only) | MIT |

## System software

- [FFmpeg](https://ffmpeg.org) is installed from the Debian package in the Docker image and is used to transcode
  video. It is licensed under LGPL-2.1+ or GPL-2.0+ depending on how it was built.

## Optional tools

- `tools/pdf2epub.py` uses [PyMuPDF](https://github.com/pymupdf/PyMuPDF) (AGPL-3.0) and
  [Pillow](https://python-pillow.org) (HPND). These are not bundled. You install them yourself if you use the tool.

## Data sources

MangaSoft fetches metadata at runtime from these services, which have their own terms. No data from them is
included in this repository.

- [AniList](https://anilist.co) GraphQL API
- [MangaDex](https://mangadex.org) API
- [Jikan](https://jikan.moe) (unofficial MyAnimeList API) for episode titles
- [nhentai](https://nhentai.net) API, only if you add a doujin folder

Cover art, titles and descriptions belong to their respective owners.
