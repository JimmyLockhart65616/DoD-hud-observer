# DoD HUD Observer

Live broadcast overlay for **Day of Defeat 1.3** — built as an OBS browser source that displays real-time game state from a DoD server.

![DoD HUD Observer](e2e/snapshots/04-observed-player.png)

## Features

- **Live scoreboard** — per-player kills, deaths, score, and class/weapon info for both teams
- **Flag status bar** — real-time capture progress with capping/owned indicators
- **Match timer** — synced countdown from the game server with drift correction
- **Kill feed** — scrolling kill notifications with weapon icons
- **Observed player** — highlights the player the caster is spectating
- **Prone shame timer** — visible elapsed timer when a player goes prone

## How It Works

```text
DoD Game Server (HLDS + Metamod-P + AMXX)
  └─ AMXX plugin (TCP client)
       └─ streams JSON events to Node.js backend

Observer PC
  └─ Node.js backend (TCP server on port 9000)
       ├─ receives game events from plugin
       ├─ relays via Socket.IO to frontend
       └─ serves REST API (teams, players, matches)
  └─ React frontend (port 3000)
       └─ OBS browser source at http://localhost:3000/screen
```

## Quick Start

```bash
# 1. Copy and edit config
cp config.example.json config.json

# 2. Install dependencies
npm install

# 3. Start backend + frontend
npm run backend   # Node.js backend with hot reload
npm run web       # React dev server

# 4. Point OBS browser source at http://localhost:3000/screen
```

## Testing Without a Game Server

The mocker simulates a full 6v6 match with scripted events — no HLDS needed.

```bash
npm run mocker        # start event simulator
npm run web:mocker    # React pointed at mocker

# Or run automated E2E tests (starts mocker + React, takes screenshots)
npm run e2e
```

## Game Server Setup

Requires HLDS with Metamod-P and AMX Mod X. A Docker Compose setup is included:

```bash
docker compose up     # start DoD HLDS with Metamod-P + AMXX
```

See [CLAUDE.md](CLAUDE.md) for full architecture details, event schema, and plugin compilation instructions.

## Tech Stack

- **Backend**: Node.js, TypeScript, Express, Socket.IO, LowDB
- **Frontend**: React, Zustand, Socket.IO client
- **Plugin**: AMX Mod X (Pawn) on Metamod-P 1.21p38
- **Testing**: Playwright + mocker for E2E screenshots

## Match Format

- 6v6, Allies vs Axis
- Two halves on the same map — teams swap sides at halftime
- Stats reset each half

## License

[MIT](https://choosealicense.com/licenses/mit/)
