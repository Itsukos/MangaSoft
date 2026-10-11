# Installation

Pick one of the options below. All of them end at the same place: a web app on port 8484 that you open in a browser.

Your media files are only ever read. MangaSoft never writes to your library folders.

## Windows

1. Install [Node.js](https://nodejs.org), the LTS version, 22.13 or newer.
2. Get the code (`git clone https://github.com/Itsukos/MangaSoft.git`, or download the zip from GitHub) and put it
   in a folder you will keep.
3. In that folder run `npm install`. The first start also downloads ffmpeg for the anime section.
4. Double-click `MangaSoft.vbs`. A small blossom icon appears in the system tray (check the ^ overflow area).
   Right-click it for Open, Copy network address, Rescan, Start with Windows, Restart and Quit.
   If you prefer a visible console, use `start.bat` instead.
5. Open <http://localhost:8484>.
6. Go to **Settings, Library folders, Add folder** and enter the path, for example `D:\Manga`.

To read on a phone or tablet on the same Wi-Fi, right-click the tray icon and choose **Copy network address**, then
open that address on the device. If it does not load, allow Node.js through Windows Firewall for private networks.

Logs are in `data\server.log`.

## Docker Compose

```
git clone https://github.com/Itsukos/MangaSoft.git
cd MangaSoft
```

Edit `docker-compose.yml` so the volume paths point at your folders, then:

```
docker compose up -d --build
```

Open `http://<machine>:8484`.

The `/config` volume holds the database, cached covers and the app itself. Keep it somewhere persistent.

### Environment variables

| Variable | Meaning |
|---|---|
| `PUID`, `PGID` | User and group the app runs as. Unraid uses 99 and 100. |
| `TZ` | Timezone, for example `America/New_York`. |
| `MANGA_DIR` | Library to add on first start, inside the container. |
| `ANIME_DIR` | Same, for the anime section. |
| `NOVEL_DIR` | Same, for the light novel section. |
| `DOUJIN_DIR` | Same, for the doujin section. |
| `PORT` | Web port inside the container. Default 8484. |
| `MANGASOFT_UPDATE_URL` | Optional update server address. |

These only seed the first run. After that, manage folders in **Settings**.

## Docker run

```
docker run -d --name mangasoft --restart unless-stopped -p 8484:8484 \
  -e PUID=1000 -e PGID=1000 -e TZ=UTC \
  -e MANGA_DIR=/media/manga \
  -v ./config:/config \
  -v /path/to/manga:/media/manga:ro \
  ghcr.io/itsukos/mangasoft:latest
```

Add more `-v` and `-e` pairs for anime, novels and doujin the same way.

## Unraid

1. Copy `docker/unraid-mangasoft.xml` to `/boot/config/plugins/dockerMan/templates-user/` on the server.
2. In the Docker tab choose **Add Container**, then pick **MangaSoft** from the template list.
3. Set the app data path (for example `/mnt/user/appdata/mangasoft`) and map your media shares. Leave the ones you do
   not use empty.
4. Apply, then open the WebUI.

## From source

```
npm install
npm start
```

`npm start` runs `server/run.js`, which is what lets the server restart itself after an update. For development use
`npm run dev`, which runs the server directly.

## First steps in the app

1. **Settings, Library folders**: add your manga folders. Anime, light novel and doujin folders have their own
   panels in Settings.
2. Wait for the scan. Covers and details are fetched in the background.
3. A wrong match? Open the series and choose **Fix metadata**.
4. Optional: connect AniList in **Settings, AniList** to sync reading progress. See [anilist.md](anilist.md).
