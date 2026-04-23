/**
 * Local variant of sniff-prod-events.ts — targets local Docker stack.
 * Used to check whether idle local game servers reproduce the prod
 * DODX-forward-silence bug.
 *
 * Run: npx ts-node scripts/sniff-local-events.ts
 */
import { io as ioClient } from 'socket.io-client';

const DATA_SERVER = 'http://localhost:4000';
const HOSTS = ['KTP Local Dev #1', 'KTP Local Dev #2'];

const KNOWN_EVENTS = [
    'ktp_match_start', 'ktp_match_end',
    'round_start_freeze', 'round_start', 'round_end', 'half_start',
    'team_score', 'time_sync',
    'player_connect', 'player_disconnect', 'player_team_change',
    'player_spawn', 'player_score',
    'kill', 'damage', 'prone_change',
    'weapon_pickup', 'weapon_drop', 'nade_throw',
    'caster_observed_player', 'user_say',
    'flags_init', 'flag_cap_started', 'flag_cap_stopped', 'flag_captured',
    'flag_cap_progress', 'flag_zone_players',
];

type Counts = Record<string, number>;
const counts: Record<string, Counts> = {};
const lastSeen: Record<string, Record<string, number>> = {};
for (const h of HOSTS) { counts[h] = {}; lastSeen[h] = {}; }

function connectHost(host: string) {
    const sock = ioClient(DATA_SERVER, { transports: ['websocket'], forceNew: true });
    sock.on('connect', () => {
        console.log(`[${host}] connected ${sock.id}`);
        sock.emit('join_server', host);
    });
    sock.on('disconnect', (reason) => console.log(`[${host}] disconnected: ${reason}`));
    for (const ev of KNOWN_EVENTS) {
        sock.on(ev, () => {
            counts[host][ev] = (counts[host][ev] ?? 0) + 1;
            lastSeen[host][ev] = Date.now();
        });
    }
    sock.onAny((evName: string) => {
        if (!KNOWN_EVENTS.includes(evName) && evName !== 'connect' && evName !== 'disconnect') {
            counts[host][`?${evName}`] = (counts[host][`?${evName}`] ?? 0) + 1;
        }
    });
}
for (const h of HOSTS) connectHost(h);

function printSummary(label: string) {
    console.log(`\n=== ${label} @ ${new Date().toISOString()} ===`);
    for (const h of HOSTS) {
        const entries = Object.entries(counts[h]).sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((s, [, v]) => s + v, 0);
        console.log(`  ${h}: total=${total}`);
        for (const [ev, n] of entries) {
            const last = lastSeen[h][ev] ? `${Math.round((Date.now() - lastSeen[h][ev]) / 1000)}s ago` : '-';
            console.log(`    ${ev.padEnd(24)} ${String(n).padStart(5)}  (last: ${last})`);
        }
    }
}

setInterval(() => printSummary('ROLLING'), 5000);
process.on('SIGINT', () => { printSummary('FINAL'); process.exit(0); });
