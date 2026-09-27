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
 *   `exp` must be in the future and at most MAX_TOKEN_LIFETIME_MS (13h) ahead;
 *   a token claiming longer is refused, however it was signed.
 *
 * LINK FORMAT (how the website hands a token to /caster)
 *   https://hud.ktpdod.com/caster?server=<X-Server-Hostname>#caster_token=<token>
 *   The token goes in the FRAGMENT, which the browser never sends to a server;
 *   see the intake comment in web/src/components/core/Socket/Socket.jsx.
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a cast plus pre/post-show overrun

// The longest lifetime a token may CLAIM, however it was minted. There is no
// revocation short of rotating the shared secret, so without this ceiling a
// minting bug or a hand-issued smoke-test token with a far-future `exp` stays
// valid until the next rotation. The hour of slack over TOKEN_TTL_MS absorbs
// clock skew between this host and keep-the-prac's.
const MAX_TOKEN_LIFETIME_MS = TOKEN_TTL_MS + 60 * 60 * 1000;

const MIN_SECRET_LENGTH = 32;

/**
 * A secret this backend must not trust: the built-in `changeme` default, the
 * example config's `REPLACE_WITH_…` placeholder, or anything short enough to
 * guess. Every one of those is a string an attacker can read or try, so a
 * token "signed" with it proves nothing.
 *
 * verifyToken FAILS CLOSED on a weak secret: it refuses every token, so the
 * caster room stays empty rather than open. With positions gated, that blanks
 * the minimap for casters, which is visible and fixable; the alternative is a
 * position stream that looks private and is not.
 */
export function isWeakSecret(secret: string): boolean {
    return secret === 'changeme'
        || secret.startsWith('REPLACE_WITH_')
        || secret.length < MIN_SECRET_LENGTH;
}

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
    const body = toB64Url(Buffer.from(JSON.stringify({
        id: identity.id, name: identity.name, exp: Date.now() + TOKEN_TTL_MS,
    })));
    return `${body}.${sign(body)}`;
}

/** The identity a token was issued for, or null if missing/malformed/forged/expired,
 * if it claims a lifetime past MAX_TOKEN_LIFETIME_MS, or if the secret is weak. */
export function verifyToken(token: string | undefined | null): CasterIdentity | null {
    if (!token) return null;
    if (isWeakSecret(config.caster_auth.session_secret)) return null;
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
        if (claims.exp - Date.now() > MAX_TOKEN_LIFETIME_MS) return null;
        return { id: claims.id, name: claims.name };
    } catch {
        return null;
    }
}
