#!/bin/sh
# MangaSoft container entrypoint.
#   /seed        pristine app shipped in the image
#   /config/app  the app that actually runs (in-app updates change this copy)
#   /config/data database, covers, caches (MANGASOFT_DATA)
set -e
SEED=/seed
APP=/config/app
mkdir -p /config/data

ver() { node -p "try{require('$1/package.json').version}catch(e){'0.0.0'}"; }
# newer A B  -> exit 0 when version A is greater than B
newer() {
  node -e "const a=process.argv[1].split('.').map(Number),b=process.argv[2].split('.').map(Number);
    for(let i=0;i<3;i++){const x=a[i]||0,y=b[i]||0;if(x!==y)process.exit(x>y?0:1)}process.exit(1)" "$1" "$2"
}

SEED_VER="$(ver $SEED)"
APP_VER="$(ver $APP)"
if [ ! -f "$APP/server/run.js" ] || newer "$SEED_VER" "$APP_VER"; then
  echo "[docker] installing MangaSoft $SEED_VER into $APP"
  rm -rf "$APP/server" "$APP/public" "$APP/node_modules"
  mkdir -p "$APP"
  cp -a "$SEED/." "$APP/"
else
  echo "[docker] running MangaSoft $APP_VER from $APP (image carries $SEED_VER)"
fi

# optional: run as a specific user (Unraid convention: PUID=99 PGID=100)
if [ "$(id -u)" = "0" ] && [ -n "$PUID" ]; then
  GID="${PGID:-$PUID}"
  chown -R "$PUID:$GID" /config
  exec setpriv --reuid="$PUID" --regid="$GID" --clear-groups node --no-warnings "$APP/server/run.js"
fi
exec node --no-warnings "$APP/server/run.js"
