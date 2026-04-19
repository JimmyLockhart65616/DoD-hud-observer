# Pushing to KTP Dependency Repos

This repo is the top of the chain for the DoD HUD Observer project, but the
plugin (`KTPHudObserver.sma`) depends on the KTP stack — breaking a change in
`KTPAMXX` or `KTPInfrastructure` silently corrupts every plugin that uses the
runtime or is compiled by `amxxpc`.

This doc is how we avoid pushing a break.

## The blast radius

| Push to | What can break |
|---|---|
| `KTPAMXX` | `amxxpc` output for every plugin; runtime for every server in every cluster |
| `KTPInfrastructure` | Docker build pipeline, deploy tooling, provisioning, local dev stack |
| `KTP-ReHLDS` / `KTP-ReAPI` / `KTPAMXXCurl` | Engine-level — servers won't start |
| Our plugin (`KTPHudObserver.sma`) | Just the HUD feed for one match |

Order of blast radius: infra + engine/amxx repos are the scary ones.
Our own plugin is recoverable.

## Two layers of safety

### 1. Local pre-push hook (fast feedback, before push)

Runs a full Docker build in the pre-push hook. Takes ~10–15 min but catches
most regressions locally before the commit hits the remote. This is our
primary safety net — no GH Actions CI, so the local build is the gate.

**Install once per repo:**

```bash
cd d:/Git/KTPInfrastructure && bash scripts/install-hooks.sh
cd d:/Git/KTPAMXX          && bash scripts/install-hooks.sh
```

**Bypass when you need to** (e.g. pushing a WIP branch, docs-only change):

```bash
git push --no-verify
# or
KTP_SKIP_PREPUSH=1 git push
```

What each hook actually runs:

- `KTPInfrastructure/scripts/pre-push.sh` → `make build` (all components + plugins)
- `KTPAMXX/scripts/pre-push.sh` → `make build-amxx` then `make build-plugins`
  from sibling `KTPInfrastructure/` — the second step verifies the rebuilt
  `amxxpc` can still compile every downstream plugin

Because hooks live in `.git/hooks/` (not tracked in git), every machine you
push from needs `install-hooks.sh` run once. If you ever push from a new
laptop, remember this.

### 2. Denver test cluster (the authoritative check)

The pre-push hook only proves things **compile**. It does not prove the
plugin loads, natives resolve at runtime, or Discord webhooks fire. That
requires a live server.

Nein's documented workflow ([KTPInfrastructure/docs/DEPLOYING.md:160-214](../../KTPInfrastructure/docs/DEPLOYING.md)):

1. Build: `make build VERSION=<date>`
2. Deploy to Denver only: `make deploy-denver VERSION=<date>`
3. Watch logs: `ssh dodserver@denver "tail -f ~/dod-27015/log/console/*.log"`
4. Play a real match (or at least join the server)
5. Only then: `make deploy-plugins VERSION=<date>` to push to Atlanta/Dallas/Chicago

Artifacts are version-stamped by date, so a bad deploy is a one-command
rollback: `make deploy-plugins-atlanta VERSION=<previous-good-date>`.

## Recommended push sequence

When a change touches multiple repos:

1. **Our plugin** (`DoD-hud-observer`) first — lowest blast radius, easy rollback
2. **KTPAMXX** before **KTPInfrastructure** — infra pins KTPAMXX at build time,
   so the reverse order creates a window where infra's build is broken
3. **Unique VERSION tag** — never overwrite a known-good artifact:
   `make build VERSION=20260418-dod-hud-v2`
4. **Denver before production** — always, even for "obvious" changes

## Related files

- [KTPInfrastructure/Makefile](../../KTPInfrastructure/Makefile) — build + deploy targets
- [KTPInfrastructure/docs/DEPLOYING.md](../../KTPInfrastructure/docs/DEPLOYING.md) — full deploy playbook
- [KTPInfrastructure/scripts/pre-push.sh](../../KTPInfrastructure/scripts/pre-push.sh) — local hook
- [KTPAMXX/scripts/pre-push.sh](../../KTPAMXX/scripts/pre-push.sh) — local hook
