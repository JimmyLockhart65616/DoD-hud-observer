import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

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
}

function loadConfig(): Config {
    const configPath = path.resolve(__dirname, '../../config.yaml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const file = yaml.load(raw) as Config;

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
    };
}

function int(envVal: string | undefined, fallback: number): number {
    if (envVal === undefined) return fallback;
    const n = parseInt(envVal, 10);
    return isNaN(n) ? fallback : n;
}

const config = loadConfig();
export default config;
