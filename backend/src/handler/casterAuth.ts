import crypto from 'crypto';
import https from 'https';
import config from '../config';

/**
 * Caster login: Discord OAuth2 (Authorization Code flow) + signed session
 * tokens. Casters already have Discord accounts for everything else in this
 * league — a password this module generated and someone had to relay over
 * DM was worse UX for zero security benefit, once drew asked why we weren't
 * just using Discord (2026-09-25).
 *
 * No JWT library for the session token — Node's own `crypto` already has
 * everything a fixed-claim HMAC-signed token needs. Same "dependency-free
 * where the standard library already does it" call as flagswing.js.
 *
 * This is the ONLY auth any viewer-facing page in this app has ever had —
 * everything else (`/api/hq`, `/socket.io/`, `/caster`, `/screen`) is
 * documented in app.ts as PUBLIC AND UNAUTHENTICATED by design. Get this
 * module wrong and that stays true for the one surface it isn't supposed to.
 *
 * Authorization is a flat allowlist of Discord user ids
 * (`caster_auth.allowed_discord_ids`), not a Discord server role — the
 * caster roster is small and operator-managed by hand already (see
 * config/online/config.yaml.example), and a role-based check would need
 * this backend to hold a bot token with guild-member-read scope for no
 * present benefit.
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;   // 12h — a cast plus pre/post-show overrun
const STATE_TTL_MS = 10 * 60 * 1000;        // the OAuth round trip through Discord, generously

// Manual base64url, not the `'base64url'` Buffer encoding string — that
// encoding needs a newer Node than this repo's pinned @types/node (^14)
// guarantees is on the deploy target, and a version-dependent encoding is
// exactly the kind of thing that should not be guessed at in an auth module.
const toB64Url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): Buffer =>
    Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(body: string): string {
    return toB64Url(crypto.createHmac('sha256', config.caster_auth.session_secret).update(body).digest());
}

/** Self-contained signed claims: no server-side session store, so a session
 * token and an OAuth `state` value are the same mechanism with different
 * payloads. `exp` is required on everything signed here. */
function signClaims(claims: Record<string, unknown> & { exp: number }): string {
    const body = toB64Url(Buffer.from(JSON.stringify(claims)));
    return `${body}.${sign(body)}`;
}

function verifyClaims<T extends { exp: number }>(token: string | undefined | null): T | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expectedSig = sign(body);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
    }
    try {
        const claims = JSON.parse(fromB64Url(body).toString('utf-8'));
        if (typeof claims.exp !== 'number' || Date.now() > claims.exp) return null;
        return claims as T;
    } catch {
        return null;
    }
}

// ─── App session token ───────────────────────────────────────────────────

export interface CasterIdentity {
    id: string;    // Discord user id (snowflake)
    name: string;  // Discord username, display only
}

export function issueToken(identity: CasterIdentity): string {
    return signClaims({ id: identity.id, name: identity.name, exp: Date.now() + TOKEN_TTL_MS });
}

/** The identity a token was issued for, or null if missing/malformed/forged/expired. */
export function verifyToken(token: string | undefined | null): CasterIdentity | null {
    const claims = verifyClaims<{ id: string; name: string; exp: number }>(token);
    if (!claims || typeof claims.id !== 'string' || typeof claims.name !== 'string') return null;
    return { id: claims.id, name: claims.name };
}

export function isAllowedCaster(discordUserId: string): boolean {
    return config.caster_auth.allowed_discord_ids.includes(discordUserId);
}

// ─── OAuth state (CSRF) ──────────────────────────────────────────────────
// No server-side pending-login store: the state value carries what the
// callback needs (which server to send the caster back to) and is
// self-authenticating, the same signature scheme as the session token.

export function issueOAuthState(serverName: string): string {
    return signClaims({
        server: serverName,
        nonce: crypto.randomBytes(8).toString('hex'),
        exp: Date.now() + STATE_TTL_MS,
    });
}

export function verifyOAuthState(state: string | undefined | null): { server: string } | null {
    const claims = verifyClaims<{ server: string; nonce: string; exp: number }>(state);
    if (!claims || typeof claims.server !== 'string') return null;
    return { server: claims.server };
}

// ─── Discord API ─────────────────────────────────────────────────────────

const DISCORD_API = 'discord.com';
const REQUEST_TIMEOUT_MS = 8000;

function httpsRequest(options: https.RequestOptions, body?: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const req = https.request({ ...options, host: DISCORD_API, timeout: REQUEST_TIMEOUT_MS }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                try {
                    resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
                } catch (err) {
                    reject(new Error(`Discord API returned non-JSON (status ${res.statusCode}): ${raw.slice(0, 200)}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Discord API request timed out')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

export function discordAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
        client_id: config.caster_auth.discord_client_id,
        redirect_uri: config.caster_auth.discord_redirect_uri,
        response_type: 'code',
        scope: 'identify',
        state,
        prompt: 'none',
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/** Exchanges an OAuth `code` for the Discord identity of whoever authorized
 * it. Throws on any transport/shape failure — the caller (the callback
 * route) turns that into a login failure, never a silent "unauthorized". */
export async function fetchDiscordIdentity(code: string): Promise<CasterIdentity> {
    const body = new URLSearchParams({
        client_id: config.caster_auth.discord_client_id,
        client_secret: config.caster_auth.discord_client_secret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.caster_auth.discord_redirect_uri,
    }).toString();

    const tokenRes = await httpsRequest({
        path: '/api/oauth2/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);
    if (tokenRes.status !== 200 || typeof tokenRes.json?.access_token !== 'string') {
        throw new Error(`Discord token exchange failed (status ${tokenRes.status})`);
    }

    const userRes = await httpsRequest({
        path: '/api/users/@me',
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenRes.json.access_token}` },
    });
    if (userRes.status !== 200 || typeof userRes.json?.id !== 'string') {
        throw new Error(`Discord identity fetch failed (status ${userRes.status})`);
    }
    return { id: userRes.json.id, name: String(userRes.json.username ?? userRes.json.id) };
}
