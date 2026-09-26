/**
 * Caster token verification — the whole of this backend's involvement in who
 * may cast. ktpleague.gg decides and mints; this side only checks the
 * signature before letting a socket into the position-carrying room, so a
 * forged or expired token slipping through here is the entire failure mode,
 * and nothing about it is visible in normal operation.
 *
 * The round-trip tests double as the executable spec for the minting side:
 * keep-the-prac signs with this exact scheme and shared secret (see the
 * TOKEN FORMAT block in handler/casterAuth.ts). `mintLikeKeepThePrac` below
 * reimplements it from that spec rather than calling `issueToken`, so a
 * drift between the two implementations fails here instead of on air.
 */
import crypto from 'crypto';
import { issueToken, secretIsUsable, verifyToken } from '../handler/casterAuth';
import config from '../config';

const b64url = (buf: Buffer) =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An independent implementation of the documented format, as the website would do it. */
function mintLikeKeepThePrac(claims: { id: string; name: string; exp: number }, secret: string): string {
    const body = b64url(Buffer.from(JSON.stringify(claims)));
    const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
    return `${body}.${sig}`;
}

describe('issueToken / verifyToken', () => {
    it('round-trips the identity that issued it', () => {
        const token = issueToken({ id: 'user-abc', name: 'JaGGoN' });
        expect(verifyToken(token)).toEqual({ id: 'user-abc', name: 'JaGGoN' });
    });

    it('accepts a token minted independently from the documented format', () => {
        const token = mintLikeKeepThePrac(
            { id: 'user-abc', name: 'JaGGoN', exp: Date.now() + 60_000 },
            config.caster_auth.session_secret,
        );
        expect(verifyToken(token)).toEqual({ id: 'user-abc', name: 'JaGGoN' });
    });

    it('rejects a token minted with a DIFFERENT secret (the two sides drifted)', () => {
        const token = mintLikeKeepThePrac(
            { id: 'user-abc', name: 'JaGGoN', exp: Date.now() + 60_000 },
            'not-the-shared-secret',
        );
        expect(verifyToken(token)).toBeNull();
    });

    it('rejects a token with a tampered payload', () => {
        const token = issueToken({ id: 'user-abc', name: 'JaGGoN' });
        const [, sig] = token.split('.');
        const forgedBody = b64url(Buffer.from(JSON.stringify({
            id: 'someone-else', name: 'admin', exp: Date.now() + 1e9,
        })));
        expect(verifyToken(`${forgedBody}.${sig}`)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
        const token = issueToken({ id: 'user-abc', name: 'JaGGoN' });
        const original = config.caster_auth.session_secret;
        config.caster_auth.session_secret = 'a-different-secret-entirely';
        try {
            expect(verifyToken(token)).toBeNull();
        } finally {
            config.caster_auth.session_secret = original;
        }
    });

    it('rejects a claim set missing id or name rather than passing a partial identity', () => {
        const secret = config.caster_auth.session_secret;
        const noName = mintLikeKeepThePrac({ id: 'user-abc', exp: Date.now() + 60_000 } as any, secret);
        const noId = mintLikeKeepThePrac({ name: 'JaGGoN', exp: Date.now() + 60_000 } as any, secret);
        expect(verifyToken(noName)).toBeNull();
        expect(verifyToken(noId)).toBeNull();
    });

    it('rejects garbage input without throwing', () => {
        expect(verifyToken(null)).toBeNull();
        expect(verifyToken(undefined)).toBeNull();
        expect(verifyToken('')).toBeNull();
        expect(verifyToken('not-a-token')).toBeNull();
        expect(verifyToken('..')).toBeNull();
    });

    it('rejects an expired token', () => {
        const start = Date.parse('2026-01-01T00:00:00Z');
        const spy = jest.spyOn(Date, 'now').mockReturnValue(start);
        try {
            const token = issueToken({ id: 'user-abc', name: 'JaGGoN' });
            spy.mockReturnValue(start + 24 * 60 * 60 * 1000); // 24h later, past the 12h TTL
            expect(verifyToken(token)).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});

/**
 * The failure this guards is not an attack on a good secret, it is a deploy
 * that never set one. A valid signature IS the authorization here — there is
 * no user list to fall back on — so a publicly-known secret is an open room
 * that reads as a closed one. Verified in review of #28: with the old
 * 'changeme' default, a token anyone could sign joined caster:mocker and
 * received live positions.
 */
describe('an unusable secret fails closed', () => {
    const realSecret = config.caster_auth.session_secret;
    afterEach(() => { config.caster_auth.session_secret = realSecret; });

    const unusable = [
        ['empty', ''],
        ["the old 'changeme' default", 'changeme'],
        ['the online example placeholder', 'REPLACE_WITH_CASTER_TOKEN_SECRET_SHARED_WITH_KTPLEAGUE_GG'],
        ['the local dev placeholder', 'local-dev-only-not-a-real-secret'],
        ['under 32 characters', 'short-but-not-a-placeholder'],
    ] as const;

    it.each(unusable)('%s is not usable', (_label, secret) => {
        expect(secretIsUsable(secret)).toBe(false);
    });

    it('a real 32+ character secret is usable', () => {
        expect(secretIsUsable('x'.repeat(32))).toBe(true);
    });

    it.each(unusable)('refuses a token forged against %s', (_label, secret) => {
        // Exactly the attack: the secret is public, so anyone can sign a
        // well-formed token for a user who does not exist.
        const forged = mintLikeKeepThePrac(
            { id: 'not-a-caster', name: 'not-a-caster', exp: Date.now() + 60_000 },
            secret,
        );
        config.caster_auth.session_secret = secret;
        expect(verifyToken(forged)).toBeNull();
    });

    it('refuses even a token this process issued, once the secret is unusable', () => {
        const token = issueToken({ id: 'user-abc', name: 'JaGGoN' });
        expect(verifyToken(token)).toEqual({ id: 'user-abc', name: 'JaGGoN' });
        config.caster_auth.session_secret = 'changeme';
        expect(verifyToken(token)).toBeNull();
    });

    it('refuses to issue rather than minting something nobody should trust', () => {
        config.caster_auth.session_secret = '';
        expect(() => issueToken({ id: 'user-abc', name: 'JaGGoN' })).toThrow(/session_secret/);
    });
});
