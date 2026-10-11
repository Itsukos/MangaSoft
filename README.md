# MangaSoft

A self-hosted server for your manga, anime and light novels. Point it at your folders, then read and watch from a
browser on your PC, phone or tablet. Think Jellyfin, but for manga.

It reads the files you already have. It does not download anything, and it ships with no content.

## Features

- **Manga reader** for `.cbz`, `.zip` and image folders. Scroll, single page or two-page spread, left-to-right or
  right-to-left, tap zones and swipe on phones, keyboard on desktop.
- **Anime player** with direct play where the browser can handle it, and on-the-fly HLS through ffmpeg where it
  cannot. Audio and subtitle track selection, styled subtitles, skip intro, next episode.
- **Light novel reader** for `.epub` files, with themes, fonts, a table of contents and resume position.
- **Doujin section** kept apart from everything else, with an optional PIN.
- **Metadata** from AniList and MangaDex: covers, banners, descriptions, genres, scores. Fix any match by hand.
- **Progress** is remembered per chapter, and can be synced to your AniList account.
- **Chapter detection** for volumes that are not split into chapters, using OCR on title pages.
- **Rescans keep your data.** Renaming a file or folder does not lose progress, splits or edits.
- **Self-updating** if you give it an update server, with signature checks and automatic rollback.
- Works as a web app on any device. No account, no cloud.

## Quick start

### Windows

1. Install [Node.js](https://nodejs.org) 22 or newer.
2. Download or clone this repository and run `npm install`.
3. Double-click `MangaSoft.vbs` to run in the system tray, or `start.bat` for a console window.
4. Open <http://localhost:8484>, then **Settings, Library folders, Add folder**.

### Docker

```
git clone https://github.com/Itsukos/MangaSoft.git
cd MangaSoft
# edit the paths in docker-compose.yml
docker compose up -d --build
```

Or pull the prebuilt image:

```
docker run -d --name mangasoft -p 8484:8484 \
  -v ./config:/config \
  -v /path/to/manga:/media/manga:ro \
  -e MANGA_DIR=/media/manga \
  ghcr.io/itsukos/mangasoft:latest
```

Unraid users can use the template in `docker/unraid-mangasoft.xml`.

### From source

```
npm install
npm start
```

Node 22.13 or newer is required. ffmpeg is bundled on Windows and used from the system in Docker. On other
systems install ffmpeg yourself if you want the anime section.

## Folder layout

```
Manga/
  One Piece/
    Chapter 001/001.jpg, 002.jpg ...
    One Piece - c002.cbz
  Berserk/Vol 01/Ch 001/...
  Some Oneshot.cbz

Anime/
  Show Name/
    [Group] Show Name - 01 [1080p].mkv
    Season 2/Show Name S02E01.mkv

Light Novels/
  Series Name/
    Series Name - Volume 01.epub
    Series Name - Volume 02.epub
```

Details for each section are in [docs/libraries.md](docs/libraries.md).

## Documentation

| | |
|---|---|
| [Installation](docs/installation.md) | Windows, Docker, Unraid and running from source |
| [Libraries](docs/libraries.md) | Folder layout, naming and metadata for each section |
| [Configuration](docs/configuration.md) | Environment variables, ports, data folder |
| [Anime and playback](docs/anime.md) | Codecs, transcoding, subtitles, hardware encoding |
| [AniList](docs/anilist.md) | Connecting your account and syncing progress |
| [Updates](docs/updates.md) | In-app updates and hosting your own update channel |
| [Troubleshooting](docs/troubleshooting.md) | Common problems |
| [Contributing](CONTRIBUTING.md) | Building, code layout, pull requests |

## Security

There is no login. Anyone who can reach the server can read your library. Keep it on your home network, or put it
behind a reverse proxy or VPN that handles authentication. The doujin PIN is a privacy lock, not security. See
[SECURITY.md](SECURITY.md).

## Privacy

Everything is stored in the `data` folder next to the app (or `/config/data` in Docker). The server contacts
AniList and MangaDex for metadata, nhentai if you use the doujin section, and an update server only if you set one.
Your files and reading history are never sent anywhere.

## Content notice

MangaSoft is a reader and player for files you already own. It does not provide, host or link to any copyrighted
material. You are responsible for the content you put in your own library. The doujin metadata lookup uses
nhentai's public API and is off until you add a doujin folder.

## Contact

Come yell at me. Twitter: [@Itsukos](https://twitter.com/Itsukos), Discord: Itsuko.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
