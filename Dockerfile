# MangaSoft: self-hosted manga, anime and light novel server.
#   docker build -t mangasoft .
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="MangaSoft" \
      org.opencontainers.image.description="Self-hosted manga, anime and light novel server with a web reader" \
      org.opencontainers.image.source="https://github.com/Itsukos/MangaSoft" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ENV NODE_ENV=production \
    PORT=8484 \
    MANGASOFT_DATA=/config/data \
    npm_config_cache=/config/.npm

# ffmpeg converts anime for the browser (HLS, burned-in subtitles). The system build is used in preference to the npm one.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# The image carries a pristine copy in /seed. The entrypoint installs it into /config/app,
# which is where in-app updates are applied, so they survive container re-creation.
WORKDIR /seed
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && rm -rf node_modules/ffmpeg-static/ffmpeg node_modules/@ffprobe-installer/linux-*
COPY server ./server
COPY public ./public
COPY README.md LICENSE ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /config /media

VOLUME ["/config"]
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8484)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
