# Security

## Threat model

MangaSoft is built for a trusted home network. There are no user accounts. Anyone who can reach the port can read
your library, change settings and trigger rescans. The doujin PIN hides that section from casual use but is not
strong protection.

## If you expose it beyond your LAN

Do not forward the port straight to the internet. Put it behind something that authenticates users first, such as a
reverse proxy with basic auth or SSO, or a VPN like WireGuard or Tailscale.

## Updates

Updates are off by default. When enabled, every release must match a SHA-256 checksum and carry an Ed25519
signature from the key whose public half ships with the app, or it is refused.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security tab, Report a vulnerability) rather than
a public issue. Include steps to reproduce. I will respond as soon as I can.
