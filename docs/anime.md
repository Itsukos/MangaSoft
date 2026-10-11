# Anime and playback

## How a file is played

The server picks a method per file.

- **Direct play:** mp4 and webm with codecs the browser supports are sent as they are.
- **Remux or copy:** H.264 video is copied into HLS without re-encoding, which costs almost no CPU.
- **Transcode:** HEVC, 10-bit video, or anything larger than the quality you picked is re-encoded.

Seeking works anywhere in the file, the same way Jellyfin does it. ffmpeg is bundled on Windows and used from the
system package in Docker.

A weak NAS CPU will struggle with 1080p HEVC. Lower the quality in the player menu, or enable hardware encoding.

## Hardware encoding

**Settings, Anime section** lets you choose NVENC (NVIDIA), Quick Sync (Intel) or AMF (AMD). If the encoder cannot
start, MangaSoft falls back to the CPU. In Docker you also need to pass the device through to the container, for
example `--gpus all` for NVIDIA or `--device /dev/dri` for Intel.

## Subtitles

- Pick a track in the player's settings menu. Text tracks are shown as plain subtitles by default.
- **Burn subtitles into the picture** keeps styled signs and typesetting. It can be set per device, or as the
  default in Settings. Image based subtitles (PGS, VobSub) are always burned in.
- External `.srt` and `.ass` files next to a video are found automatically.

## Player

| Key | Action |
|---|---|
| Space, K | Play or pause |
| Left, Right | Back or forward 10 seconds |
| F | Fullscreen |
| C | Subtitles |
| N, P | Next or previous episode |
| Esc | Back |

- Audio track and quality can be changed while watching. Language choices are remembered.
- A skip intro button appears when the file has an Opening chapter.
- The next episode can start by itself.
- AniList progress is marked at 90 percent of an episode, or with the button, or automatically if you enable it.

## Not supported yet

HDR tone mapping, DLNA or Chromecast, multiple users.
