// Configurable mock /ingest endpoint for soak scenarios.
//
// Stands in for the real data-server backend so soak runs don't pollute
// real match storage or depend on the full data container. Counts received
// POSTs, optionally injects latency / 5xx errors / connection failures so
// scenarios can exercise the plugin's error and queue-saturation paths.
//
// Reused by every scenario under e2e/soak/scenarios/. Don't fork — extend
// MockBackendConfig with new behavior knobs as scenarios need them.

import express, { Express, Request, Response } from 'express';
import { Server } from 'http';

export interface MockBackendConfig {
    port: number;
    /** Per-request latency in ms before responding. 0 = no delay. */
    latencyMs?: number;
    /** Probability (0-1) of returning HTTP 503 instead of 200. */
    errorRate?: number;
    /** If true, drop the connection mid-request (no response) at errorRate probability. */
    connectionDrop?: boolean;
    /** If true, retain every received body in stats.events for assertions. Disabled by default to avoid OOM on long runs. */
    retainBodies?: boolean;
    /** Optional auth key check — if set, requests without matching X-Auth-Key get 401. */
    requireAuthKey?: string;
}

export interface MockBackendStats {
    requestsReceived: number;
    errorsReturned: number;
    authFailures: number;
    connectionsDropped: number;
    firstRequestAt?: number;
    lastRequestAt?: number;
    events: unknown[];
}

export class MockBackend {
    private readonly app: Express;
    private server?: Server;
    public readonly stats: MockBackendStats = {
        requestsReceived: 0,
        errorsReturned: 0,
        authFailures: 0,
        connectionsDropped: 0,
        events: [],
    };

    constructor(private readonly cfg: MockBackendConfig) {
        this.app = express();
        this.app.use(express.json({ limit: '1mb' }));
        this.app.post('/ingest', this.handleIngest.bind(this));
        this.app.get('/__stats', (_req, res) => res.json(this.stats));
    }

    private async handleIngest(req: Request, res: Response): Promise<void> {
        const now = Date.now();
        if (!this.stats.firstRequestAt) this.stats.firstRequestAt = now;
        this.stats.lastRequestAt = now;
        this.stats.requestsReceived++;

        if (this.cfg.requireAuthKey && req.header('X-Auth-Key') !== this.cfg.requireAuthKey) {
            this.stats.authFailures++;
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        if (this.cfg.retainBodies) {
            this.stats.events.push(req.body);
        }

        if (this.cfg.latencyMs) {
            await new Promise((r) => setTimeout(r, this.cfg.latencyMs));
        }

        if (this.cfg.errorRate && Math.random() < this.cfg.errorRate) {
            if (this.cfg.connectionDrop) {
                this.stats.connectionsDropped++;
                req.socket.destroy();
                return;
            }
            this.stats.errorsReturned++;
            res.status(503).json({ error: 'mock injected error' });
            return;
        }

        res.status(200).json({ ok: true });
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.cfg.port, () => resolve());
            this.server.on('error', reject);
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = undefined;
    }
}
