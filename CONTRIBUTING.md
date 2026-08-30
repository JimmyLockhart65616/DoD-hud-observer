# Contributing to DoD HUD Observer

This overlay runs live on KTP League broadcasts, and the AMXX half of it loads
on every DoD server in the fleet. Mistakes are visible to everyone watching, so
the bar for `KTPHudObserver.sma` is higher than for the web app.

Bug reports are welcome from anyone. Small fixes are welcome as pull requests.
If you're planning something large, **open an issue first** so we can agree on
the shape before you spend a weekend on it.

## The two hard rules

Neither of these is a preference. A change that breaks either one cannot be
merged, however good it is otherwise.

### 1. Nothing in the game-server pipeline may depend on Metamod

The KTP stack loads AMXX in *extension mode*. Only three modules are loaded:
`dodx_ktp`, `reapi_ktp`, `amxxcurl_ktp`. There is no Metamod, no fakemeta, no
hamsandwich, no engine module.

A plugin that `#include <fakemeta>` does not fail at runtime with a missing
native — `fakemeta.inc` carries `#pragma reqlib fakemeta`, so **the whole plugin
fails to load**. That is a total HUD outage on that server, not a lost stat.

When you need something new:

- Use the HL SDK directly (`edict->v.*`, `gpGlobals`, `g_engfuncs`).
- Use existing extension-mode dodx natives (`dodx_get_user_origin`,
  `dodx_get_user_movetype`, …) rather than `pev()` / `entity_get_*`.
- Never use `META_*` macros or `MDLL_*` wrappers.
- Bind new-ish natives *optionally*, via `plugin_natives` / `set_native_filter`,
  so a server running an older module falls through instead of failing to load.

### 2. Never commit operator secrets

These paths are gitignored because the real files carry live credentials:

| Gitignored | Carries | Committed counterpart |
| --- | --- | --- |
| `config/online/config.yaml` | ingest `auth_key`, HLTV **rcon passwords** | `config/online/config.yaml.example` |
| `deploy/hud-observer.service` | `HUD_AUTH_KEY` | `deploy/hud-observer.service.example` |
| `deploy/hud_observer.cfg` | server-side ingest key | — |

Edit the `.example` file, never the real one. The same applies to issues and
pull requests: see [SECURITY.md](SECURITY.md) before pasting a config, a log
tail, or an `rcon` transcript into a public thread.

## Local setup

You need Node 20+ and Docker. Clone
[KTPInfrastructure](https://github.com/afraznein/KTPInfrastructure) as a
**sibling directory** — the plugin compile and the pre-push hook both look for
`../KTPInfrastructure`:

```
parent/
  DoD-hud-observer/     <- this repo
  KTPInfrastructure/
```

Then:

```bash
npm install
cd web && npm install && cd ..
bash scripts/install-hooks.sh     # once per machine, see "Pre-push hook" below
```

### Running it without a game server

You do not need DoD, or a server, to work on the frontend. The mocker replays a
scripted ~75-second 6v6 scrim through the real ingest path:

```bash
npm run backend    # :8089 ingest, :3011 REST, :4010 socket
npm run web        # :3010
npm run mocker     # replays a match into the backend
```

Open `http://localhost:3010/screen?server=<hostname>`. The other surfaces are
`/hq` (operations board), `/caster` (caster reference), `/watch` (server picker)
and `/help` (viewer guide).

For the full stack *with* two real DoD servers, use KTPInfrastructure:

```bash
cd ../KTPInfrastructure && make local-up
```

## Tests

```bash
npm run test          # backend Jest — ingest -> recorder -> disk -> REST
npm run test:web      # frontend Jest — the Socket.jsx store machine
npm run test:all      # both
npm run e2e           # Playwright, headless Chromium, driven by the mocker
npm run plugin:smoke  # amxxpc compile of KTPHudObserver.sma (~10s warm)
```

`npm run e2e` runs React on **:3010** and the mocker on **:8000** so it never
collides with a running Docker stack. `reuseExistingServer` is off on purpose —
a stale process should fail the run, not silently test the wrong build.

A lot of this repo's hard-won knowledge lives in tests rather than in prose. If
you are changing the stats carry logic, the wave clock, the scoring tick, the
damage correction or the cap-break gates, read the test file next to it first —
it very likely pins the exact mistake you are about to re-make.

### Pre-push hook

`scripts/install-hooks.sh` installs a pre-push hook that runs four stages,
cheap-to-expensive:

1. amxxcurl async-lifetime lint (awk) — catches the use-after-free pattern that
   crashed a production server in April 2026.
2. Docker `amxxpc` compile of `KTPHudObserver.sma`.
3. `npm run test`.
4. `npm run test:web` — self-skips if `web/node_modules` is missing.

Bypass a single push with `git push --no-verify`; disable with
`KTP_SKIP_PREPUSH=1`. Please don't make a habit of either.

## Working on the plugin

`KTPHudObserver.sma` is Pawn, compiled with the AMXX 1.10 compiler. Three
syntax traps, in a language most contributors have not written before:

- The escape character is `^`, **not** `\`. A backslash is an ordinary
  character: `'\'` is a valid single char.
- A double quote inside a string is `^"`. The AMXX 1.10 compiler **rejects**
  the `""` form.
- The null terminator is `'^0'`.

Run `npm run plugin:smoke` after every `.sma` edit. It reproduces the exact
`compile_plugin` invocation CI runs and catches every CI compile failure locally
in about ten seconds. Exit codes: `0` clean, `1` compile failed, `2` unexpected
warning, `3` environment problem (missing artifacts — run
`cd ../KTPInfrastructure && make build-amxx` once).

Exactly one warning is expected and allowed: the `client_disconnect`
deprecation. DODX still fires it.

**Fixed-size buffers are load-bearing.** `formatex` truncates silently, so an
overflowing event serialises as malformed JSON with no error anywhere — the
symptom is a stale panel, not a crash. If you add a field to `player_state` or
`flags_init`, redo the byte arithmetic at the buffer guard; the comment there
carries the table. Do not estimate it.

## Pull requests

- Branch off `master`. One logical change per PR.
- Fill in the template — especially the extension-mode checkbox if you touched
  the plugin.
- Run `npm run test:all` and, for `.sma` changes, `npm run plugin:smoke`.
- Screenshots are worth a lot for anything that renders. `npm run e2e` drops
  them in `e2e/snapshots/`.

### What CI runs on your PR

| Workflow | What it proves | Runs on a fork PR? |
| --- | --- | --- |
| **Tests** | Backend Jest + the frontend store machine | **Yes** — needs no secrets |
| **Tier 1 Smoke** | The plugin compiles and actually loads on a booted server | **No** — skipped, see below |

Tier 1 Smoke calls a reusable workflow in KTPInfrastructure using a repository
secret, and GitHub does not give secrets to workflows triggered from a fork.
Rather than failing your PR with a checkout error you cannot fix, the job
skips itself and a `fork-notice` job explains why in the Actions tab. **That
skip is expected and is not a problem with your change** — a maintainer
verifies the plugin build before merging.

The Tests workflow is unaffected and gives you real signal either way, so a
green Tests run on a fork PR means what it says.

## Where a bug actually belongs

This repo is one piece of a stack. Filing in the right place saves a round trip:

| Symptom | Repo |
| --- | --- |
| Overlay renders wrong, wrong number, wrong layout | **here** |
| Backend ingest, recorder, REST, socket rooms | **here** |
| `KTPHudObserver.amxx` behaviour or events | **here** |
| A `dodx_*` / `reapi_*` native is missing or returns garbage | KTPAMXX |
| Deploy, Docker orchestration, server inventory, CI | KTPInfrastructure |
| `ktp_match_start` / `ktp_match_end` timing | KTPMatchHandler |
| Async HTTP module crashes or leaks | KTPAmxxCurl |
| League stats database contents or the HLStatsX daemon | KTPHLStatsX |

If you are not sure, file it here and we will move it.

## Further reading

- [README.md](README.md) — architecture, ports, quick start
- [CLAUDE.md](CLAUDE.md) — the deep reference: full event schema, class IDs,
  weapon names, and the reasoning behind most of the non-obvious decisions
- [docs/VIEWER_GUIDE.md](docs/VIEWER_GUIDE.md) — what each panel means on air
