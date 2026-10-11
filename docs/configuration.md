# Configuration

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8484` | Port the web server listens on. |
| `MANGASOFT_DATA` | `./data` | Where the database, covers and caches are stored. Docker uses `/config/data`. |
| `MANGA_DIR` | none | Manga library to add on first start. |
| `ANIME_DIR` | none | Anime library to add on first start. |
| `NOVEL_DIR` | none | Light novel library to add on first start. |
| `DOUJIN_DIR` | none | Doujin library to add on first start. |
| `MANGASOFT_UPDATE_URL` | none | Update server address. See [updates.md](updates.md). |
| `PUID`, `PGID` | none | Docker only. User and group to run as. |
| `TZ` | `UTC` | Docker only. Timezone. |

The `*_DIR` variables are only read when that library has never been configured. After that, folders are managed in
Settings.

## The data folder

Everything MangaSoft keeps lives in one folder:

| Path | Contents |
|---|---|
| `library.db` | Series, chapters, progress, settings |
| `covers/` | Cover images fetched or uploaded |
| `thumbs/` | Generated thumbnails |
| `transcode/` | Temporary HLS segments for anime |
| `updates/` | Staged updates and the rollback copy |
| `server.log` | Log output |

Back up `library.db` and `covers/` to keep your progress and manual edits. Everything else can be rebuilt.

## Settings

Most options live in the Settings page and are stored in the database.

- **Library folders** for each section, with a Scan button per folder.
- **Metadata source order** and provider switches.
- **Series page** style (gallery or chapter list).
- **Theme**, remembered per device.
- **AniList** connection and auto-update options.
- **Anime section**: hardware encoding, default subtitle behaviour.
- **Doujin section**: PIN and API key.
- **Updates**: server address and auto-install switch.

## Ports and networking

MangaSoft listens on all interfaces. For access outside your home network, put it behind a reverse proxy or VPN
that handles authentication. See [../SECURITY.md](../SECURITY.md).
