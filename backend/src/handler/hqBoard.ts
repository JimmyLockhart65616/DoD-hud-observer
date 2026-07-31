/**
 * HQ / Operations Board — the projection behind GET /api/hq.
 *
 * One page shows every server that has reported, for a wall display: who's
 * playing where, the score of each game, and per-player kills/deaths.
 *
 * This is a READ-ONLY composition over three things the backend already
 * maintains — the per-server state cache in ingest.ts, MatchRecorder's
 * metadata, and MetricsCollector's last-seen/event-count registry. It adds no
 * state machine of its own and nothing in the ingest → delay-buffer → socket →
 * overlay path reads it.
 *
 * Why the composition happens here and not in the browser: joining
 * /api/servers + /api/matches/live + the state cache client-side at 1 Hz means
 * score, roster, and online-ness each come from a different instant, which on a
 * wall display reads as flicker. Reading all three in-process at one instant is
 * internally consistent by construction.
 *
 * IMPORTANT: the board reflects the state cache, which is updated *after* the
 * HLTV delay buffer (see makeFireToSockets in ingest.ts). So for any server
 * listed in hltv_sync.servers the board is broadcast-delayed, not live. That is
 * deliberate — it matches what the overlay shows — and is surfaced per server
 * as delayActive/delaySeconds so the UI can say so out loud.
 */

import type { MatchMetadata, MatchRecorder } from './matchRecorder';
import type { MetricsCollector } from './metrics';
import {
    getCachedServerView,
    listCachedServers,
    type CachedServerFlag,
    type CachedServerPlayer,
    type CachedServerView,
} from './ingest';

/**
 * Matches MetricsCollector.getServers()'s own online threshold. Duplicated as a
 * named constant rather than imported because ServerInfo.online is computed at
 * getServers() call time and we also want the raw age for the UI.
 */
const ONLINE_MS = 60_000;

export type HqStatus = 'LIVE' | 'WARMUP' | 'BETWEEN' | 'STALE' | 'NO_SIGNAL';

/** The slice of HltvSyncService this module needs. Narrow so tests can fake it. */
export interface HqHltvSource {
    isActive(server: string): boolean;
    getStatus(): { server: string; delaySeconds?: number; map?: string }[];
}

export interface HqServer {
    hostname: string;
    status: HqStatus;
    online: boolean;
    lastEventAgeMs: number | null;   // null = never seen by metrics
    totalEvents: number;

    map: string | null;
    half: number | null;             // 1, 2, or 101+ for OT
    roundPhase: 'freeze' | 'live' | 'end' | null;

    alliesScore: number | null;
    axisScore: number | null;

    /**
     * Half clock in seconds, age-adjusted to the instant this response was
     * serialized. The CLIENT stamps its own Date.now() on receipt to form the
     * countdown basis, so no server clock value crosses the wire as a timing
     * reference and clock skew cannot appear. Fractional — floor only at display.
     */
    timeleft: number | null;
    timerFrozen: boolean;

    /** True if this server's events pass through the HLTV delay buffer. */
    delayActive: boolean;
    /** Measured broadcast delay in seconds; null if unknown or not delayed. */
    delaySeconds: number | null;

    flags: CachedServerFlag[];       // ownership only — see getCachedServerView
    allies: CachedServerPlayer[];
    axis: CachedServerPlayer[];
    playerCount: number;

    matchId: string | null;
    matchType: number | null;
}

export interface HqOverview {
    /** Diagnostics only. NOT a timer basis — see HqServer.timeleft. */
    generatedAt: string;
    servers: HqServer[];
}

/**
 * Pure status classifier — no I/O, no clock reads — so the precedence rules can
 * be table-tested without express, a recorder, or a metrics collector.
 *
 * Precedence, first match wins:
 *
 *   NO_SIGNAL  No ingest event within ONLINE_MS. Box off, plugin unloaded,
 *              network down, or it hasn't POSTed since this backend booted.
 *   STALE      Signal present but no state cache — the backend-restart window.
 *              The cache is memory-only and cannot self-seed (player_state has
 *              no reducer arm, and the catch-all tail only refreshes players
 *              already cached), so it stays empty until the next spawn / score /
 *              round / team_score / half_start. Rendering LIVE 0–0 with an empty
 *              roster here would be a lie; say "rebuilding" instead.
 *   BETWEEN    Cache present, no match running. Keyed on matchActive, NOT on
 *              `half` — ktp_match_end deliberately leaves `half` set so
 *              getServerSnapshot can still seed a late joiner's HUD, so a
 *              `half == null` rule would fire once per box then never again.
 *   LIVE       Match running and a round has begun this half. roundPhase is the
 *              discriminator: half_start and ktp_match_start/end all null it,
 *              and only round_start_freeze/round_start/round_end set it — so
 *              non-null ⇔ a round has started.
 *   WARMUP     Match running, no round yet. That null roundPhase *is* the
 *              post-half_start warmup window.
 *
 * Note LIVE with playerCount 0 is possible (everyone aged out of
 * PLAYER_STALE_MS or disconnected). That needs no sixth state — an empty roster
 * beside a LIVE chip is self-explanatory, and another state would only add
 * precedence surface. BETWEEN likewise covers both an empty server and pub play;
 * the frontend distinguishes those by playerCount rather than the backend
 * inventing a status for it.
 *
 * `recorderSaysActive` ORs MatchRecorder's view of match-activeness onto the
 * cache's. It exists for the restart case: `matchActive` is set by the
 * ktp_match_start arm, so a backend that restarts MID-match never sees that
 * event and would report BETWEEN for the rest of the half — while the recorder
 * rehydrates active matches from disk and does know. OR is the correct
 * combinator in both directions: at match start the recorder (real-time) flips
 * first, which only advances the chip ahead of the delayed feed and leaks no
 * score; at match end the recorder flips first but the delayed cache holds the
 * OR true until its own ktp_match_end arrives, so the end is NOT revealed early.
 */
export function deriveStatus(
    online: boolean,
    view: CachedServerView,
    recorderSaysActive = false,
): HqStatus {
    if (!online) return 'NO_SIGNAL';
    if (!view.hasCache) return 'STALE';
    if (!view.matchActive && !recorderSaysActive) return 'BETWEEN';
    return view.roundPhase != null ? 'LIVE' : 'WARMUP';
}

/** Newest match per source server, by startedAt. */
function newestByServer(metas: MatchMetadata[]): Map<string, MatchMetadata> {
    const out = new Map<string, MatchMetadata>();
    for (const m of metas) {
        const prev = out.get(m.sourceServer);
        if (!prev || new Date(m.startedAt) > new Date(prev.startedAt)) {
            out.set(m.sourceServer, m);
        }
    }
    return out;
}

export function buildHqOverview(
    recorder: MatchRecorder,
    metrics: MetricsCollector,
    hltv?: HqHltvSource,
): HqOverview {
    const now = Date.now();

    // Newest *active* match per server — the same reduction MatchPicker.jsx does
    // client-side today, done once here instead. Plus the newest match overall,
    // used only as a map fallback for a cold cache.
    const allMeta = recorder.getAllMetadata();
    const activeIds = new Set(recorder.getActiveMatchIds());
    const activeByServer = newestByServer(
        allMeta.filter(m => activeIds.has(m.matchId) && !m.endedAt),
    );
    const anyByServer = newestByServer(allMeta);

    const info = new Map(metrics.getServers().map(s => [s.hostname, s]));
    const hltvStatus = hltv?.getStatus() ?? [];
    const delayByServer = new Map<string, number | undefined>(
        hltvStatus.map(s => [s.server, s.delaySeconds]),
    );
    // RCON-sourced current map, independent of match state — the one map source
    // that's populated even when no match has run since the last backend
    // restart. Only covers servers listed in hltv_sync.servers.
    const hltvMapByServer = new Map<string, string | undefined>(
        hltvStatus.map(s => [s.server, s.map]),
    );

    // Union of the two discovery registries. Both are in-memory and populated by
    // traffic, so a server that hasn't POSTed since boot appears in neither and
    // simply isn't on the board.
    const hostnames = new Set<string>([...info.keys(), ...listCachedServers()]);

    const servers = [...hostnames].map((hostname): HqServer => {
        const view = getCachedServerView(hostname);
        const meta = info.get(hostname);
        const lastEventAgeMs = meta ? now - meta.last_seen : null;
        const online = lastEventAgeMs != null && lastEventAgeMs < ONLINE_MS;
        const active = activeByServer.get(hostname) ?? null;
        const delayActive = hltv?.isActive(hostname) ?? false;

        return {
            hostname,
            status: deriveStatus(online, view, active != null),
            online,
            lastEventAgeMs,
            totalEvents: meta?.total_events ?? 0,

            // Cache first (delay-correct, and survives a restart once one event
            // lands). The plugin only stamps `map` on events while a match is
            // active (CLAUDE.md: idle traffic carries no match_id/map/half), so
            // a freshly restarted backend with no match yet has no cache value —
            // exactly the LAN-kickoff case this board exists for. RCON status
            // fills that gap for HLTV-paired servers (live, not delay-scoped, so
            // it's ahead of the cache — acceptable, it's just a map name).
            // Last-resort: the most recent match ever recorded, which can be
            // stale if the map changed outside a match.
            map: view.map ?? active?.map ?? hltvMapByServer.get(hostname)
                ?? anyByServer.get(hostname)?.map ?? null,
            half: view.half,
            roundPhase: view.roundPhase,

            alliesScore: view.alliesScore,
            axisScore: view.axisScore,

            timeleft: view.timeleft,
            timerFrozen: view.roundPhase === 'freeze' || view.roundPhase === 'end',

            delayActive,
            delaySeconds: delayActive ? (delayByServer.get(hostname) ?? null) : null,

            flags: view.flags,
            allies: view.allies,
            axis: view.axis,
            playerCount: view.allies.length + view.axis.length,

            matchId: active?.matchId ?? null,
            matchType: active?.matchType ?? null,
        };
    });

    // Deterministic order. getServers() iterates a Map in insertion order —
    // whichever server POSTed first after boot — so without this the board
    // reshuffles on every backend restart and nobody can learn its layout.
    servers.sort((a, b) => a.hostname.localeCompare(b.hostname));

    return { generatedAt: new Date(now).toISOString(), servers };
}
