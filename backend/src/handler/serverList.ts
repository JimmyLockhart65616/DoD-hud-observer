/**
 * `/api/servers` projection — the row model behind the /watch picker.
 *
 * Read-only over MetricsCollector + the ingest player-count cache, plus the
 * static `hltv_connect` map from config. Shares nothing with the ingest or
 * socket paths; composing it here (rather than inline in app.ts, as it used to
 * be) is what lets the ordering and the HLTV pairing be tested directly.
 */
import { MetricsCollector } from './metrics';

/**
 * Where a DoD client dials to spectate. Distinct from `hltv_sync.servers`,
 * which is the RCON endpoint the backend polls for the broadcast clock:
 *
 *  - hltv_sync is 127.0.0.1 (backend and proxies share the data server) and is
 *    populated only for servers we actually clock-sync; it carries rcon
 *    passwords, so it is operator-owned.
 *  - hltv_connect is the PUBLIC address, and must exist for every server on the
 *    picker whether or not we sync its clock. No secrets.
 */
export interface HltvConnectConfig {
    /** Public host every proxy is reachable on. Empty string disables the links. */
    host: string;
    /** X-Server-Hostname → HLTV proxy port. */
    ports: Record<string, number>;
}

export interface ServerListEntry {
    hostname: string;
    total_events: number;
    online: boolean;
    players: number;
    /** null when the server has no proxy in `hltv_connect` (e.g. hand-run LAN boxes). */
    hltv: { host: string; port: number } | null;
}

/**
 * Fleet ordering: "KTP - New York 10" must sort after "KTP - New York 9", so the
 * compare is numeric-aware rather than lexicographic. The fleet is single-digit
 * today, which is exactly why this is easy to get wrong later and never notice.
 *
 * `localeCompare` returns 0 for strings that differ only in ways the collator
 * ignores, so a raw tiebreak keeps this a total order and the sort stable.
 */
export function compareServerHostnames(a: string, b: string): number {
    const collated = a.localeCompare(b, 'en', { numeric: true });
    if (collated !== 0) return collated;
    return a < b ? -1 : a > b ? 1 : 0;
}

export function buildServerList(
    metrics: MetricsCollector,
    hltvConnect: HltvConnectConfig,
    playerCount: (hostname: string) => number,
): ServerListEntry[] {
    const rows = metrics.getServers().map(({ last_seen: _last, ...rest }) => {
        const port = hltvConnect.host ? hltvConnect.ports[rest.hostname] : undefined;
        return {
            ...rest,
            players: playerCount(rest.hostname),
            hltv: port ? { host: hltvConnect.host, port } : null,
        };
    });
    rows.sort((a, b) => compareServerHostnames(a.hostname, b.hostname));
    return rows;
}
