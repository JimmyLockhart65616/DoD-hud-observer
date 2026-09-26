import crypto from 'crypto';
import config from '../config';

/**
 * Caster tokens: verification only. This backend does NOT decide who may
 * cast, and has no login UI, no OAuth flow and no user list of its own.
 *
 * ktpleague.gg (keep-the-prac) already knows who is logged in — it runs
 * Supabase Auth with the Discord provider, and resolves the session
 * server-side on every request. Building a second login here meant a second
 * account system for the same people, which is what drew pushed back on
 * (2026-09-25). So the split is:
 *
 *   keep-the-prac   decides WHO. It authorizes one of its own logged-in
 *                   users and mints a short-lived token with the scheme
 *                   below, signed with the SHARED `caster_auth.session_secret`.
 *   this backend    verifies the signature, and nothing else. A valid
 *                   signature IS the authorization.
 *
 * The shared secret is the whole coupling: no cross-service call at join
 * time, no Supabase client here, no knowledge of who the casters are.
 * Rotating it invalidates every outstanding token on both sides at once,
 * which is the intended blast radius.
 *
 * What this gates: the `caster:<host>` socket room, the only place live
 * player positions go (see makeFireToSockets in ingest.ts). Everything else
 * this app serves — `/api/hq`, `/socket.io/`, `/caster`, `/screen` — is
 * PUBLIC AND UNAUTHENTICATED by design, as app.ts documents.
 *
 * No JWT library: the claim set is fixed and Node's own `crypto` has HMAC
 * and a timing-safe compare. Same "dependency-free where the standard
 * library already does it" call as flagswing.js. A minting implementation on
 * the other side must match this exactly — see TOKEN FORMAT below.
 *
 * TOKEN FORMAT
 *   `<body>.<sig>` where
 *     body = base64url(JSON.stringify({ id, name, exp }))   exp = epoch ms
 *     sig  = base64url(HMAC-SHA256(session_secret, body))
 *   base64url here is standard base64 with `+`->`-`, `/`->`_`, `=` stripped.
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a cast plus pre/post-show overrun

// Manual base64url, not the `'base64url'` Buffer encoding string — that
// encoding needs a newer Node than this repo's pinned @types/node (^14)
// guarantees is on the deploy target, and a version-dependent encoding is
// exactly the kind of thing that should not be guessed at in an auth module.
const toB64Url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): Buffer =>
    Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Shortest secret we will sign or verify with.
 *
 * Arbitrary, but well above anything a human types by hand, which is the
 * point: the failure this guards is not a brute-force attack on a good
 * secret, it is a deploy that never set one.
 */
const MIN_SECRET_LENGTH = 32;

/** Placeholders that ship in this repo. A live deploy must not run on one. */
const PLACEHOLDER_SECRETS = new Set([
    'changeme',
    'REPLACE_WITH_CASTER_TOKEN_SECRET_SHARED_WITH_KTPLEAGUE_GG',
    'local-dev-only-not-a-real-secret',
]);

/**
 * Whether the configured secret can be trusted to mean anything.
 *
 * FAIL CLOSED, and this matters more here than the usual reason. A valid
 * signature IS the authorization on this service — there is no user list to
 * fall back on — so a publicly-known secret is not a weak password, it is an
 * open door that looks shut. Verified in review: with the old `'changeme'`
 * default, a token anyone could sign for a user who does not exist joined
 * `caster:mocker` and received live positions (DoD-hud-observer#28).
 *
 * An unusable secret therefore refuses every token rather than accepting
 * every forged one. The caster room simply stays empty until an operator sets
 * the shared value, which is the safe direction to be wrong in.
 */
export function secretIsUsable(secret: string | undefined | null): boolean {
    if (!secret) return false;
    if (PLACEHOLDER_SECRETS.has(secret)) return false;
    return secret.length >= MIN_SECRET_LENGTH;
}

function sign(body: string): string {
    return toB64Url(crypto.createHmac('sha256', config.caster_auth.session_secret).update(body).digest());
}

export interface CasterIdentity {
    id: string;    // whoever the minting side calls this caster (keep-the-prac's user id)
    name: string;  // display only, for logs
}

/**
 * Mints a token with the format above.
 *
 * Production tokens come from keep-the-prac, not from here — this exists so
 * the tests can produce a valid token, and so an operator can hand-issue one
 * for a smoke test without standing the website up. Keep it in sync with the
 * TOKEN FORMAT block: it is the executable copy of that spec.
 */
export function issueToken(identity: CasterIdentity): string {
    if (!secretIsUsable(config.caster_auth.session_secret)) {
        throw new Error('caster_auth.session_secret is unset, a placeholder, or under 32 characters — refusing to issue a token');
    }
    const body = toB64Url(Buffer.from(JSON.stringify({
        id: identity.id, name: identity.name, exp: Date.now() + TOKEN_TTL_MS,
    })));
    return `${body}.${sign(body)}`;
}

/** The identity a token was issued for, or null if missing/malformed/forged/expired. */
export function verifyToken(token: string | undefined | null): CasterIdentity | null {
    // Before anything else: with no usable secret there is no signature worth
    // checking, and every token — forged or not — is refused.
    if (!secretIsUsable(config.caster_auth.session_secret)) return null;
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
        if (typeof claims.id !== 'string' || typeof claims.name !== 'string') return null;
        if (typeof claims.exp !== 'number' || Date.now() > claims.exp) return null;
        return { id: claims.id, name: claims.name };
    } catch {
        return null;
    }
}
