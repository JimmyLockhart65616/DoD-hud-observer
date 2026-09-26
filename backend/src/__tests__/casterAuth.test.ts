/**
 * Signed tokens + the Discord identity/allowlist boundary for the one
 * authenticated surface this app has (`/caster`). A bug here either locks
 * every caster out mid-match or lets a forged/expired session or OAuth
 * state through — there is no manual QA step that would catch the second
 * one, so it's tested here instead. The actual Discord API round trip
 * (`fetchDiscordIdentity`) is NOT unit tested — it is a thin wrapper over a
 * live HTTPS call to discord.com that only an integration/manual check
 * against a real Discord app can exercise meaningfully.
 */
import {
    issueToken, verifyToken, isAllowedCaster,
    issueOAuthState, verifyOAuthState, discordAuthorizeUrl,
} from '../handler/casterAuth';
import config from '../config';

describe('issueToken / verifyToken', () => {
    it('round-trips the identity that issued it', () => {
        const token = issueToken({ id: '123456789', name: 'coreymarko' });
        expect(verifyToken(token)).toEqual({ id: '123456789', name: 'coreymarko' });
    });

    it('rejects a token with a tampered payload', () => {
        const token = issueToken({ id: '123456789', name: 'coreymarko' });
        const [, sig] = token.split('.');
        const forgedBody = Buffer.from(JSON.stringify({ id: '999999999', name: 'admin', exp: Date.now() + 1e9 }))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(verifyToken(`${forgedBody}.${sig}`)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
        const token = issueToken({ id: '123456789', name: 'coreymarko' });
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
        const start = Date.parse('2026-01-01T00:00:00Z');
        const spy = jest.spyOn(Date, 'now').mockReturnValue(start);
        try {
            const token = issueToken({ id: '123456789', name: 'coreymarko' });
            spy.mockReturnValue(start + 24 * 60 * 60 * 1000); // 24h later, past the 12h TTL
            expect(verifyToken(token)).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('isAllowedCaster', () => {
    const ORIGINAL = config.caster_auth.allowed_discord_ids;
    beforeEach(() => { config.caster_auth.allowed_discord_ids = ['123456789']; });
    afterAll(() => { config.caster_auth.allowed_discord_ids = ORIGINAL; });

    it('allows an id on the list', () => {
        expect(isAllowedCaster('123456789')).toBe(true);
    });

    it('refuses an id not on the list', () => {
        expect(isAllowedCaster('000000000')).toBe(false);
    });

    it('refuses everyone when the list is empty (safe default, not an open gate)', () => {
        config.caster_auth.allowed_discord_ids = [];
        expect(isAllowedCaster('123456789')).toBe(false);
    });
});

describe('issueOAuthState / verifyOAuthState', () => {
    it('round-trips the server name it was issued for', () => {
        const state = issueOAuthState('KTP - Atlanta 1');
        expect(verifyOAuthState(state)).toEqual({ server: 'KTP - Atlanta 1' });
    });

    it('two states for the same server are still distinct values (nonce)', () => {
        const a = issueOAuthState('KTP - Atlanta 1');
        const b = issueOAuthState('KTP - Atlanta 1');
        expect(a).not.toBe(b);
    });

    it('rejects a tampered state', () => {
        const state = issueOAuthState('KTP - Atlanta 1');
        const [, sig] = state.split('.');
        const forgedBody = Buffer.from(JSON.stringify({ server: 'KTP - Other', nonce: 'x', exp: Date.now() + 1e9 }))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(verifyOAuthState(`${forgedBody}.${sig}`)).toBeNull();
    });

    it('rejects an expired state (the OAuth round trip took too long, or it is being replayed)', () => {
        const start = Date.parse('2026-01-01T00:00:00Z');
        const spy = jest.spyOn(Date, 'now').mockReturnValue(start);
        try {
            const state = issueOAuthState('KTP - Atlanta 1');
            spy.mockReturnValue(start + 60 * 60 * 1000); // 1h later, past the 10min TTL
            expect(verifyOAuthState(state)).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });

    it('rejects garbage input without throwing', () => {
        expect(verifyOAuthState(null)).toBeNull();
        expect(verifyOAuthState('not-a-state')).toBeNull();
    });
});

describe('discordAuthorizeUrl', () => {
    it('carries the configured client id, redirect uri, and the given state', () => {
        const original = { ...config.caster_auth };
        config.caster_auth.discord_client_id = 'test-client-id';
        config.caster_auth.discord_redirect_uri = 'https://hud.ktpdod.com/api/caster-auth/discord/callback';
        try {
            const url = new URL(discordAuthorizeUrl('some-signed-state'));
            expect(url.origin + url.pathname).toBe('https://discord.com/api/oauth2/authorize');
            expect(url.searchParams.get('client_id')).toBe('test-client-id');
            expect(url.searchParams.get('redirect_uri')).toBe('https://hud.ktpdod.com/api/caster-auth/discord/callback');
            expect(url.searchParams.get('state')).toBe('some-signed-state');
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('scope')).toBe('identify');
        } finally {
            Object.assign(config.caster_auth, original);
        }
    });
});
