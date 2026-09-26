// Runs before config.ts is first imported, so the caster secret is in place
// by the time it reads the environment.
//
// The checked-in config/local/config.yaml deliberately leaves
// caster_auth.session_secret EMPTY, because an unset or placeholder secret
// now refuses every token (secretIsUsable in handler/casterAuth.ts). Tests
// about verification logic should not inherit a deployment's config, so they
// supply their own value here rather than the repo shipping a working one.
process.env.HUD_CASTER_SESSION_SECRET =
    process.env.HUD_CASTER_SESSION_SECRET || 'jest-only-value-not-a-real-secret-at-least-32-chars';
