// Drive synthetic POST traffic by re-using the existing mocker module.
//
// The mocker (backend/src/mocker/mocker.ts) already wraps events in the
// envelope KTPHudObserver.amxx emits, so its output is shape-compatible with
// real plugin POSTs. Soak scenarios spawn the mocker as a child process and
// configure its rate / duration / target via env vars.
//
// This is V1: scenarios drive the mocker against the local stack's backend
// to generate ingest traffic. A future version can spawn additional event
// generators (e.g. an explicit burst-injector .sma loaded into the test
// hlds) when scenarios need synthetic plugin-side load.

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface EventDriverConfig {
    /** Target ingest URL. Default: the local stack's data-server (http://localhost:8088/ingest). */
    ingestUrl?: string;
    /** Auth key to send as X-Auth-Key. Defaults to "changeme" (KTP local default). */
    authKey?: string;
    /** Match type override (0=COMPETITIVE, 1=SCRIM, etc.). */
    matchType?: number;
}

export class EventDriver {
    private proc?: ChildProcess;

    constructor(private readonly cfg: EventDriverConfig = {}) {}

    /** Spawn the mocker. Resolves when the child process has started. */
    async start(): Promise<void> {
        const env = {
            ...process.env,
            MOCKER_INGEST_URL: this.cfg.ingestUrl ?? 'http://localhost:8088/ingest',
            MOCKER_AUTH_KEY: this.cfg.authKey ?? 'changeme',
            ...(this.cfg.matchType !== undefined && { MOCKER_MATCH_TYPE: String(this.cfg.matchType) }),
        };

        this.proc = spawn('npx', ['ts-node', '--script-mode', 'backend/src/mocker/mocker.ts'], {
            cwd: REPO_ROOT,
            env,
            stdio: 'inherit',
            shell: true,
        });

        await new Promise((r) => setTimeout(r, 2000));

        if (this.proc.exitCode !== null) {
            throw new Error(`mocker exited immediately with code ${this.proc.exitCode}`);
        }
    }

    /** Send SIGTERM and wait for exit. */
    async stop(): Promise<void> {
        if (!this.proc || this.proc.killed) return;
        return new Promise((resolve) => {
            this.proc!.once('exit', () => resolve());
            this.proc!.kill('SIGTERM');
            setTimeout(() => {
                if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
                resolve();
            }, 5000);
        });
    }

    /** True if the mocker is still running. False after a normal exit. */
    isRunning(): boolean {
        return this.proc !== undefined && this.proc.exitCode === null && !this.proc.killed;
    }
}
