/**
 * One-shot: fix matches whose metadata.json is stuck at `endedAt: null` and
 * `eventCount: 0` because the backend never got a clean ktp_match_end (plugin
 * reload, changelevel, crash, rcon restart) and was then restarted before the
 * reaper could close them.
 *
 * Counts lines in events.jsonl, sets eventCount to that, and sets endedAt to
 * the events.jsonl mtime. The matches dir is whatever config.storage.matches_dir
 * resolves to — same path the running backend uses.
 *
 * Run on the data server, then refresh the UI:
 *   sudo -u cadaver npx ts-node --script-mode \
 *     /opt/hud-observer/backend/src/scripts/backfillOrphanMatches.ts
 *
 * Idempotent — already-ended matches are skipped.
 */
import fs from 'fs';
import path from 'path';
import config from '../config';

const matchesDir = path.resolve(config.storage.matches_dir);

if (!fs.existsSync(matchesDir)) {
    console.error(`[backfill] Matches dir not found: ${matchesDir}`);
    process.exit(1);
}

const dirs = fs.readdirSync(matchesDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

let fixed = 0;
let skipped = 0;
let errors = 0;

for (const dir of dirs) {
    const matchId = dir.name;
    const metaPath = path.join(matchesDir, matchId, 'metadata.json');
    const jsonlPath = path.join(matchesDir, matchId, 'events.jsonl');

    if (!fs.existsSync(metaPath)) {
        skipped++;
        continue;
    }

    let meta: any;
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (e) {
        console.error(`[backfill] ${matchId}: corrupt metadata.json (${e})`);
        errors++;
        continue;
    }

    if (meta.endedAt !== null) {
        skipped++;
        continue;
    }

    let eventCount = 0;
    let endedAt = new Date().toISOString();
    if (fs.existsSync(jsonlPath)) {
        const raw = fs.readFileSync(jsonlPath, 'utf-8');
        eventCount = raw.split('\n').filter(l => l.trim()).length;
        endedAt = fs.statSync(jsonlPath).mtime.toISOString();
    }

    meta.eventCount = eventCount;
    meta.endedAt = endedAt;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

    console.log(`[backfill] ${matchId}: eventCount=${eventCount} endedAt=${endedAt}`);
    fixed++;
}

console.log(`[backfill] done — fixed=${fixed} skipped=${skipped} errors=${errors}`);
