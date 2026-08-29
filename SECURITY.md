# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use
[private vulnerability reporting](https://github.com/JimmyLockhart65616/DoD-hud-observer/security/advisories/new),
which is visible only to the maintainers.

That includes anything involving: an ingest or rcon credential, an
unauthenticated endpoint that should not be reachable, a way to inject events
into a live broadcast, or a path that leaks player data.

Expect an acknowledgement within a few days. This is a volunteer project run
around a league schedule, not a product with an on-call rotation.

## Please never paste these into an issue, PR, or screenshot

This repository is **public**, and so is everything attached to it. The
following carry live credentials and are gitignored for that reason:

- `config/online/config.yaml` — ingest `auth_key` and **HLTV rcon passwords**
- `deploy/hud-observer.service` — `HUD_AUTH_KEY`
- `deploy/hud_observer.cfg` — the server-side ingest key

Use the committed `.example` counterparts instead. The same goes for rcon
transcripts, `amx_ktp_versions` output that includes a password argument, and
screenshots of a terminal with a config open in it.

If you have already posted one: rotate the credential first, then tell us. A
deleted comment is still in the GitHub event feed and in anything that mirrored
it, so deletion alone is not a fix.

## What this project's attack surface actually is

Useful context if you are looking:

- **Ingest** (`:8088` local, `:9000` production) authenticates with a static
  `X-Auth-Key` header and is deliberately **never** reverse-proxied — game
  servers POST to it directly and it is IP-restricted at the firewall. The
  committed local default is `changeme`; a production key that matches any
  committed value is a real finding.
- **The league stats read layer** (`/api/stats/*`) is public and
  unauthenticated by design, but is read-only: `assertReadOnly` re-checks every
  statement at call time and the configured MySQL user is expected to hold
  `SELECT` only. A write reaching that database is a real finding. So is any
  route exposing per-player position or heatmap data, which is intentionally
  omitted for league-policy reasons.
- **The overlay itself** is a browser source with no login. It is expected to be
  readable by anyone who can reach it; treat "I can view /screen" as intended
  behaviour, not a vulnerability.
