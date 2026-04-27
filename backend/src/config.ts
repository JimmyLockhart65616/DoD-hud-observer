import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { HltvServerConfig, HltvSyncConfig } from './handler/hltvSync';

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
        rcon_timeout_ms:        int(process.env.HUD_HLTV_SYNC_RCON_TIMEOUT_MS,     file?.rcon_timeout_ms    ?? 5000),
        servers,
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
