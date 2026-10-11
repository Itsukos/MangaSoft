# Troubleshooting

| Problem | Try this |
|---|---|
| The phone cannot open the address | Same Wi-Fi? Allow Node.js through Windows Firewall for private networks. In Docker use the host's IP, not `localhost`. |
| "Folder not found" when adding a folder | On Windows enter the full path, such as `D:\Manga`. In Docker enter the path inside the container, such as `/media/manga`. |
| A series shows no match | Open it, choose Fix metadata, search AniList and pick the entry. |
| Covers and details never appear | The server needs internet for AniList and MangaDex. Reading works offline. |
| Port 8484 is already in use | Set `PORT` to another number. In Docker change the host port in the mapping instead. |
| A library vanished after a drive went offline | It did not. Series from an unreadable folder are left alone. Bring the drive back and rescan. |
| Anime stutters or will not start | Lower the quality in the player menu, or enable hardware encoding in Settings. Check `server.log`. |
| Subtitles look plain | Turn on Burn subtitles into the picture for styled signs and typesetting. |
| Chapter detection finds nothing | It only recognises English "Chapter N" title pages. Add chapter starts by hand. |
| An EPUB shows no cover or odd text | Open it with another reader to check the file. MangaSoft forces its own colours and fonts, so inline styles from the book are ignored on purpose. |
| Update failed | Check `data/updates/` and `server.log`. The previous version stays in place. |

## Logs

- Windows: `data\server.log`
- Docker: `docker logs mangasoft`, or the container's Logs view in Unraid

## Still stuck

Open an issue at <https://github.com/Itsukos/MangaSoft/issues> with the version number (Settings, Updates), what you
did, and the relevant lines from the log.
