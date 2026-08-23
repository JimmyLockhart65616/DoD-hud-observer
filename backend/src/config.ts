import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { HltvServerConfig, HltvSyncConfig } from './handler/hltvSync';
import type { HltvConnectConfig } from './handler/serverList';

export interface Config {
    ingest: {
        port: number;
        auth_key: string;
    };
    api: {
        port: number;
    };
    socket: {
        port: number;
    };
    storage: {
        matches_dir: string;
    };
    frontend: {
        origin: string;
    };
    auth: {
        steam_api_key: string;
    };
    hltv_sync: HltvSyncConfig;
    hltv_connect: HltvConnectConfig;
}

// Resolved relative to the repo root from backend/src or backend/lib. The
// online counterpart lives at config/online/config.yaml (gitignored, operator-
// owned) — production sets HUD_CONFIG_PATH on the systemd unit to point at
// /opt/hud-observer/config/online/config.yaml directly.
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../config/local/config.yaml');

function loadConfig(): Config {
    const configPath = process.env.HUD_CONFIG_PATH
        ? path.resolve(process.env.HUD_CONFIG_PATH)
        : DEFAULT_CONFIG_PATH;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const file = yaml.load(raw) as any;

    // Env-var overrides
    return {
        ingest: {
            port:     int(process.env.HUD_INGEST_PORT, file.ingest.port),
            auth_key: process.env.HUD_AUTH_KEY ?? file.ingest.auth_key,
        },
        api: {
            port: int(process.env.HUD_API_PORT, file.api.port),
        },
        socket: {
            port: int(process.env.HUD_SOCKET_PORT, file.socket.port),
        },
        storage: {
            matches_dir: process.env.HUD_MATCHES_DIR ?? file.storage.matches_dir,
        },
        frontend: {
            origin: process.env.HUD_FRONTEND_ORIGIN ?? file.frontend.origin,
        },
        auth: {
            steam_api_key: file.auth?.steam_api_key ?? '',
        },
        hltv_sync: loadHltvSync(file.hltv_sync),
        hltv_connect: loadHltvConnect(file.hltv_connect),
    };
}

function loadHltvSync(file: any): HltvSyncConfig {
    const servers: Record<string, HltvServerConfig> = {};
    if (file?.servers && typeof file.servers === 'object') {
        for (const [name, raw] of Object.entries(file.servers as Record<string, any>)) {
            servers[name] = {
                hltv_addr: raw.hltv_addr ?? '127.0.0.1',
                hltv_port: int(undefined, raw.hltv_port),
                rcon_password: raw.rcon_password ?? '',
            };
        }
    }
    return {
        enabled:                bool(process.env.HUD_HLTV_SYNC_ENABLED,            file?.enabled            ?? false),
        heartbeat_seconds:      int(process.env.HUD_HLTV_SYNC_HEARTBEAT_SECONDS,   file?.heartbeat_seconds  ?? 60),
        fallback_delay_seconds: int(process.env.HUD_HLTV_SYNC_FALLBACK_SECONDS,    file?.fallback_delay_seconds ?? 60),
        board_release_lag_seconds: int(process.env.HUD_HLTV_SYNC_BOARD_LAG_SECONDS, file?.board_release_lag_seconds ?? 0),
        coast_grace_seconds:    int(process.env.HUD_HLTV_SYNC_COAST_GRACE_SECONDS, file?.coast_grace_seconds ?? 120),
        rcon_timeout_ms:        int(process.env.HUD_HLTV_SYNC_RCON_TIMEOUT_MS,     file?.rcon_timeout_ms    ?? 5000),
        api_url:                process.env.HUD_HLTV_API_URL                    ?? file?.api_url        ?? '',
        api_auth_key:           process.env.HUD_HLTV_API_AUTH_KEY               ?? file?.api_auth_key   ?? '',
        api_timeout_ms:         int(process.env.HUD_HLTV_API_TIMEOUT_MS,           file?.api_timeout_ms ?? 3000),
        servers,
    };
}

/**
 * Public HLTV proxy addresses for the /watch picker's connect links.
 *
 * Absent or host-less config is not an error — it just means no links are
 * offered, which is the right answer on a dev laptop with no public proxies.
 * Ports that don't parse as a number are dropped for the same reason: half a
 * connect string is worse than none, since it would send a viewer to a port
 * nothing is listening on.
 */
function loadHltvConnect(file: any): HltvConnectConfig {
    const ports: Record<string, number> = {};
    if (file?.ports && typeof file.ports === 'object') {
        for (const [name, raw] of Object.entries(file.ports as Record<string, any>)) {
            const port = int(undefined, Number(raw));
            if (Number.isInteger(port) && port > 0) ports[name] = port;
        }
    }
    return {
        host: process.env.HUD_HLTV_CONNECT_HOST ?? file?.host ?? '',
        ports,
    };
}

function int(envVal: string | undefined, fallback: number): number {
    if (envVal === undefined) return fallback;
    const n = parseInt(envVal, 10);
    return isNaN(n) ? fallback : n;
}

function bool(envVal: string | undefined, fallback: boolean): boolean {
    if (envVal === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(envVal);
}

const config = loadConfig();
export default config;
