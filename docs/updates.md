# Updates

In-app updates are off until you give MangaSoft an update server address. There is no default server.

## Using an update server

Enter the address in **Settings, Updates**, or set `MANGASOFT_UPDATE_URL`, or put it in
`server/update-config.json`:

```json
{ "url": "https://updates.example.com" }
```

With an address set, MangaSoft:

- checks `<address>/latest.json` every six hours,
- downloads the release zip when a newer version exists,
- verifies the SHA-256 checksum and an Ed25519 signature against the public key in `server/update-public.pem`,
- installs it when nobody is using the app (or waits for you to approve, if auto-update is off),
- restarts, and rolls back to the previous version if the new one fails to start.

Only program files are replaced. Your database, covers, settings and media are never touched.

The only data sent is the request itself, which includes your IP address and the installed version in the
User-Agent.

## Publishing your own releases

You need a signing key pair and somewhere to host files.

1. Generate keys once: `node release/keygen.js`. This creates `release/keys/private.pem` and writes the public key
   to `server/update-public.pem`.
2. Back up `release/keys/private.pem` somewhere safe and never commit or share it. Anyone with that key can ship code
   to every install that trusts it. If you lose it, existing installs can never be updated again.
3. Bump `version` in `package.json`.
4. Run `npm run release`. It builds a signed zip and a `latest.json` into `update-server/releases/`.
5. Upload the contents of `update-server/releases/` to your host.

The `update-server/` folder is a small dependency-free Node server that serves those files. Any static file host
works too, as long as `/latest.json` and `/releases/<file>.zip` are reachable.

## Forks

If you fork the project and want your own update channel, generate your own key pair and replace
`server/update-public.pem`. Installs only accept releases signed by the key they ship with.
