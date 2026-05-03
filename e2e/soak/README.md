# Soak Harness

Reusable test harness for running KTPHudObserver (and amxxcurl by extension) under sustained load for extended periods. Catches regressions in plugin lifecycle, queue saturation, and crash signatures that a single test run can't surface.

## Why this exists

KTPHudObserver POSTs on every game event plus 250ms / 500ms / 30s polling tasks. Bugs in the plugin's curl path (or the underlying amxxcurl module) often only manifest under sustained traffic. This harness drives that traffic locally so we can catch regressions before deploying to canary.

**Local repro caveat.** Some prod bugs (the DODX forwards-stall, the amxxcurl segfault that prompted this harness) refuse to repro locally despite multi-hour stress. A clean soak run is necessary but not sufficient — the real validation is the DEN5 24h matchday observation. Treat soak as a smoke test for the obvious failure modes (immediate crash, queue logic broken, POSTs not happening), not as a fitness verdict.

## Layout

```
e2e/soak/
├── harness/
│   ├── mock-backend.ts    Configurable /ingest receiver (latency, errors, drops, auth)
│   ├── local-stack.ts     Start/stop the KTP local docker stack via make local-up/down
│   └── event-driver.ts    Spawn the mocker as a child process for synthetic event injection
├── scenarios/
│   └── hudobserver-stress.ts   First scenario — steady-state polling load for SOAK_DURATION_MIN min
└── README.md
```

## Running

```bash
npm run soak:smoke          # 60 seconds, pre-push variant
npm run soak:hud            # 30 minutes, full scenario
SOAK_DURATION_MIN=120 npx ts-node e2e/soak/scenarios/hudobserver-stress.ts   # custom
```

Prerequisites:
- KTPInfrastructure cloned alongside DoD-hud-observer (`d:/Git/KTPInfrastructure`)
- `make build && make extract-artifacts && make local-build` already run in KTPInfrastructure (the harness invokes `make local-up`, which needs an artifacts/<today> directory matching the build date — older snapshots don't pass the Dockerfile COPY)
- The plugin under test compiled to `../KTPInfrastructure/local/plugins/KTPHudObserver.amxx` (the docker compose mounts this dir read-only)

If `make local-up` fails with "artifacts/<date> not found", run `make build && make extract-artifacts && make local-build` in KTPInfrastructure first.

## Pass criteria for hudobserver-stress.ts

- Both ktp-game-1 and ktp-game-2 stay running for the full duration (containerExitCode returns null)
- No `/tmp/core.*` file appears inside either container
- Data-server `/metrics` shows non-zero EPS from both source servers throughout
- Zero `[HUD] POST failed` lines in container logs after the first 30 seconds (warmup)

## Adding a new scenario

Each scenario is a standalone ts-node script under `scenarios/`. Reuse the harness primitives — don't shell out to docker yourself.

Template:
```typescript
import { LocalStack } from '../harness/local-stack';
import { MockBackend } from '../harness/mock-backend';

async function main() {
    const stack = new LocalStack();
    const mock = new MockBackend({ port: 9099, latencyMs: 5000 });   // configure behavior
    await mock.start();
    await stack.up();
    // ... your scenario logic ...
    await stack.down();
    await mock.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Add an npm script in package.json so the scenario runs from a single command.

## Future scenarios worth adding

These are NOT shipped today but the layout makes them cheap to add:

- `hudobserver-backend-5xx.ts` — mock backend returns 503 on 10% of requests; assert plugin's error path drains queue correctly
- `hudobserver-slow-backend.ts` — mock injects 5s latency; assert queue saturation triggers drop-oldest, no crash, no leak
- `hudobserver-backend-down.ts` — mock refuses connections for 60s mid-run; assert plugin recovers cleanly when backend returns
- `amxxcurl-regression.ts` — same scenario against a candidate `amxxcurl_ktp_i386.so` build; validates upstream changes before they fleet-roll
