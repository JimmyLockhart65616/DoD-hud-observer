## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What was wrong, or what became possible. -->

## How it was verified

<!-- Delete rows that don't apply. Screenshots are worth a lot for anything
     that renders — `npm run e2e` drops them in e2e/snapshots/. -->

- [ ] `npm run test` (backend)
- [ ] `npm run test:web` (frontend store machine)
- [ ] `npm run e2e` (Playwright, mocker-driven)
- [ ] `npm run plugin:smoke` (amxxpc compile — **required** for any `.sma` change)
- [ ] Checked on a live or local server
- [ ] Screenshots attached

## If this touches `KTPHudObserver.sma`

<!-- Delete this whole section if it doesn't. -->

- [ ] No Metamod, fakemeta, hamsandwich, or engine-module dependency
- [ ] New natives are bound optionally (`plugin_natives` / `set_native_filter`)
      so older modules on the fleet fall through instead of failing to load
- [ ] Fixed-size buffer arithmetic redone if a field was added to an event
      (`formatex` truncates silently — no error, just malformed JSON)
- [ ] Compiles with no warnings other than the expected `client_disconnect` one

## Notes for the reviewer

<!-- Anything you're unsure about, or deliberately left out.

     Outside contributors: the Tests workflow runs normally on your PR and is
     real signal. Tier 1 Smoke will show as skipped — it needs a repository
     secret that GitHub withholds from forks, so it cannot run on your PR and
     that is expected, not a problem with your change. A maintainer verifies
     the plugin build before merging. -->
