// Manage the KTPInfrastructure docker-compose local stack for soak scenarios.
//
// Wraps `make local-up` / `make local-down` with health-check + log-collection
// helpers. Uses the existing infrastructure rather than building a soak-only
// compose file so we exercise the same image build as production.
//
// The KTP local stack is documented at:
//   ../KTPInfrastructure/docker-compose.local.yml

import { spawn, execSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const KTP_INFRA = path.resolve(__dirname, '..', '..', '..', '..', 'KTPInfrastructure');

export interface LocalStackOptions {
    /** Override for KTPInfrastructure path. Defaults to ../KTPInfrastructure. */
    infraPath?: string;
    /** If true, leave the stack running after stop() — caller cleans up manually. Useful for debugging. */
    leaveRunning?: boolean;
}

export class LocalStack {
    private logTailer?: ChildProcess;
    public readonly infraPath: string;

    constructor(opts: LocalStackOptions = {}) {
        this.infraPath = opts.infraPath ?? KTP_INFRA;
        if (!fs.existsSync(path.join(this.infraPath, 'docker-compose.local.yml'))) {
            throw new Error(
                `KTPInfrastructure not found at ${this.infraPath}. ` +
                `Set opts.infraPath or clone KTPInfrastructure alongside DoD-hud-observer.`,
            );
        }
    }

    /**
     * Start the full stack (game servers + data backend) via `make local-up-full`.
     * The plain `make local-up` brings up only game servers and would cause the
     * plugin's POSTs to fail against a missing backend, masking real validation.
     */
    async up(): Promise<void> {
        execSync('make local-up-full', { cwd: this.infraPath, stdio: 'inherit' });
        await this.waitHealthy();
    }

    /** Stop and remove containers via `make local-down`. */
    async down(): Promise<void> {
        if (this.logTailer && !this.logTailer.killed) {
            this.logTailer.kill('SIGTERM');
        }
        execSync('make local-down', { cwd: this.infraPath, stdio: 'inherit' });
    }

    /**
     * Resolve the docker container name for a compose service. Compose prefixes
     * service names with the project name (defaults to the parent directory of
     * the compose file), so `ktp-game-1` becomes `ktpinfrastructure-ktp-game-1-1`.
     */
    containerName(service: string): string {
        try {
            return execSync(
                `docker compose -f docker-compose.local.yml ps --format "{{.Name}}" ${service}`,
                { cwd: this.infraPath, encoding: 'utf-8' },
            ).trim().split('\n')[0] ?? '';
        } catch {
            return '';
        }
    }

    /** Poll docker until ktp-game-1 is healthy. Throws after timeoutMs. */
    private async waitHealthy(timeoutMs = 60_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let resolvedName = '';
        while (Date.now() < deadline) {
            try {
                if (!resolvedName) resolvedName = this.containerName('ktp-game-1');
                if (resolvedName) {
                    const status = execSync(
                        `docker inspect --format="{{.State.Health.Status}}" ${resolvedName}`,
                        { encoding: 'utf-8' },
                    ).trim();
                    if (status === 'healthy') return;
                }
            } catch {
                // Container may not exist yet, or healthcheck still pending
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error(`ktp-game-1 did not reach healthy state within ${timeoutMs}ms (resolvedName="${resolvedName}")`);
    }

    /**
     * Return the exit code of a container if it has exited (typically because of
     * a crash). Returns null if the container is still running. Used to detect
     * segfaults — a healthy soak run keeps every container at running for the
     * full duration.
     */
    containerExitCode(containerName: string): number | null {
        try {
            const json = execSync(
                `docker inspect --format="{{json .State}}" ${containerName}`,
                { encoding: 'utf-8' },
            );
            const state = JSON.parse(json);
            if (state.Status === 'running') return null;
            return state.ExitCode ?? null;
        } catch {
            return null;
        }
    }

    /** Snapshot tail of a container's logs. Useful for assertions and post-mortem. */
    containerLogs(containerName: string, lines = 200): string {
        try {
            return execSync(
                `docker logs --tail ${lines} ${containerName} 2>&1`,
                { encoding: 'utf-8' },
            );
        } catch {
            return '';
        }
    }

    /** True if any /tmp/core.* file exists inside the named container. */
    hasCoreDump(containerName: string): boolean {
        try {
            const out = execSync(
                `docker exec ${containerName} sh -c "ls /tmp/core.* 2>/dev/null | head -1"`,
                { encoding: 'utf-8' },
            ).trim();
            return out.length > 0;
        } catch {
            return false;
        }
    }
}
