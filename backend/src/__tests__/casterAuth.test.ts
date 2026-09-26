/**
 * Password hashing + session tokens for the one authenticated surface this
 * app has (`/caster`). A bug here either locks every caster out mid-match or
 * lets a forged/expired token through — there is no manual QA step that would
 * catch the second one, so it's tested here instead.
 */
import { hashPassword, verifyPassword, checkPassword, issueToken, verifyToken } from '../handler/casterAuth';
import config from '../config';

describe('hashPassword / verifyPassword', () => {
    it('round-trips a real password', () => {
        const hash = hashPassword('correct horse battery staple');
        expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    });

    it('rejects the wrong password', () => {
        const hash = hashPassword('correct horse battery staple');
        expect(verifyPassword('wrong password', hash)).toBe(false);
    });

    it('salts each hash differently, even for the same password', () => {
        const a = hashPassword('same password');
        const b = hashPassword('same password');
        expect(a).not.toBe(b);
        expect(verifyPassword('same password', a)).toBe(true);
        expect(verifyPassword('same password', b)).toBe(true);
    });

    it('fails closed on a malformed stored hash rather than throwing', () => {
        expect(verifyPassword('anything', '')).toBe(false);
        expect(verifyPassword('anything', 'not-the-right-shape')).toBe(false);
        expect(verifyPassword('anything', 'zz:zz')).toBe(false); // not valid hex
    });
});

describe('checkPassword', () => {
    const ORIGINAL_USERS = config.caster_auth.users;
    beforeEach(() => {
        config.caster_auth.users = [
            { username: 'coreymarko', password_hash: hashPassword('let-me-cast') },
        ];
    });
    afterAll(() => { config.caster_auth.users = ORIGINAL_USERS; });

    it('accepts the right username and password', () => {
        expect(checkPassword('coreymarko', 'let-me-cast')).toBe(true);
    });

    it('rejects the right username with the wrong password', () => {
        expect(checkPassword('coreymarko', 'guess')).toBe(false);
    });

    it('rejects a username that was never configured', () => {
        expect(checkPassword('nobody', 'let-me-cast')).toBe(false);
    });

    it('takes roughly the same time for an unknown user as a known one with the wrong password', () => {
        // Not a strict timing assertion (too flaky in CI) — just proves the
        // unknown-user path actually calls into scrypt rather than short-circuiting,
        // which is the actual enumeration-oracle fix.
        const t0 = process.hrtime.bigint();
        checkPassword('nobody', 'whatever');
        const unknownNs = process.hrtime.bigint() - t0;

        const t1 = process.hrtime.bigint();
        checkPassword('coreymarko', 'whatever');
        const knownWrongNs = process.hrtime.bigint() - t1;

        // Both should be scrypt-dominated (tens of ms), not one near-zero.
        expect(Number(unknownNs) / 1e6).toBeGreaterThan(1);
        expect(Number(knownWrongNs) / 1e6).toBeGreaterThan(1);
    });
});

describe('issueToken / verifyToken', () => {
    it('round-trips the username that issued it', () => {
        const token = issueToken('coreymarko');
        expect(verifyToken(token)).toBe('coreymarko');
    });

    it('rejects a token with a tampered payload', () => {
        const token = issueToken('coreymarko');
        const [body, sig] = token.split('.');
        const forgedBody = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 1e9 }))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(verifyToken(`${forgedBody}.${sig}`)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
        const token = issueToken('coreymarko');
        const original = config.caster_auth.session_secret;
        config.caster_auth.session_secret = 'a-different-secret-entirely';
        try {
            expect(verifyToken(token)).toBeNull();
        } finally {
            config.caster_auth.session_secret = original;
        }
    });

    it('rejects garbage input without throwing', () => {
        expect(verifyToken(null)).toBeNull();
        expect(verifyToken(undefined)).toBeNull();
        expect(verifyToken('')).toBeNull();
        expect(verifyToken('not-a-token')).toBeNull();
        expect(verifyToken('..')).toBeNull();
    });

    it('rejects an expired token', () => {
        // Date.now() spy, not jest.useFakeTimers() — fake timers also patch
        // global.performance, which this environment's Node makes read-only.
        const start = Date.parse('2026-01-01T00:00:00Z');
        const spy = jest.spyOn(Date, 'now').mockReturnValue(start);
        try {
            const token = issueToken('coreymarko');
            spy.mockReturnValue(start + 24 * 60 * 60 * 1000); // 24h later, past the 12h TTL
            expect(verifyToken(token)).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});
