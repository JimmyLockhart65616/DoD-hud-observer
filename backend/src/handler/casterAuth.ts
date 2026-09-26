import crypto from 'crypto';
import config from '../config';

/**
 * Caster login: password hashing + signed session tokens.
 *
 * No bcrypt, no jsonwebtoken — Node's own `crypto` already has an
 * OWASP-recommended password KDF (scrypt) and everything a hand-rolled signed
 * token needs (HMAC + timing-safe compare), and the claim set here is fixed
 * (one username, one expiry), so a general JWT library buys nothing but a
 * dependency and a native-addon build step (bcrypt) this repo's deploy
 * doesn't otherwise need. Same "dependency-free where the standard library
 * already does it" call as flagswing.js.
 *
 * This is the ONLY auth any viewer-facing page in this app has ever had —
 * everything else (`/api/hq`, `/socket.io/`, `/caster`, `/screen`) is
 * documented in app.ts as PUBLIC AND UNAUTHENTICATED by design. Get this
 * module wrong and that stays true for the one surface it isn't supposed to.
 */

const SCRYPT_KEYLEN = 64;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a cast plus pre/post-show overrun

// Manual base64url, not the `'base64url'` Buffer encoding string — that
// encoding needs a newer Node than this repo's pinned @types/node (^14)
// guarantees is on the deploy target, and a version-dependent encoding is
// exactly the kind of thing that should not be guessed at in an auth module.
const toB64Url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): Buffer =>
    Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** `<saltHex>:<hashHex>`. Put this string in config.yaml's `caster_auth.users`. */
export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Constant-time-ish by construction: scrypt runs unconditionally (the caller
 * is expected to pass a real hash even for an unknown username — see
 * DUMMY_HASH below), and the final compare is `timingSafeEqual`. Malformed
 * `stored` (wrong shape, not a fixture of this module) fails closed.
 */
export function verifyPassword(password: string, stored: string): boolean {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    let salt: Buffer, expected: Buffer;
    try {
        salt = Buffer.from(saltHex, 'hex');
        expected = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

// A real hash (of a password nobody will ever type) so a login attempt
// against a NONEXISTENT username still pays scrypt's cost before failing —
// otherwise "unknown user" returns near-instantly while "known user, wrong
// password" takes scrypt's ~50ms, and that gap is an enumeration oracle.
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));

export interface CasterUser {
    username: string;
    password_hash: string;
}

export function findUser(username: string): CasterUser | undefined {
    return config.caster_auth.users.find(u => u.username === username);
}

/** Always call this, even for a username `findUser` didn't return — see DUMMY_HASH. */
export function checkPassword(username: string, password: string): boolean {
    const user = findUser(username);
    return verifyPassword(password, user?.password_hash ?? DUMMY_HASH) && user !== undefined;
}

function sign(body: string): string {
    return toB64Url(crypto.createHmac('sha256', config.caster_auth.session_secret).update(body).digest());
}

export function issueToken(username: string): string {
    const body = toB64Url(Buffer.from(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS })));
    return `${body}.${sign(body)}`;
}

/** The username the token was issued for, or null if missing/malformed/forged/expired. */
export function verifyToken(token: string | undefined | null): string | null {
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
        if (typeof claims.u !== 'string' || typeof claims.exp !== 'number') return null;
        if (Date.now() > claims.exp) return null;
        return claims.u;
    } catch {
        return null;
    }
}
