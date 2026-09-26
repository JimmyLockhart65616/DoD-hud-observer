import React from 'react';

/** Shown instead of the live page until useCasterAuth reports loggedIn. */
const CasterLogin = ({ onLogin, error }) => (
    <div className="caster-page caster-login-page">
        <div className="caster-login">
            <h1>Caster Login</h1>
            <p className="caster-login-note">
                This page carries live player positions and is restricted to named casters.
            </p>
            {error && <p className="caster-login-error">{error}</p>}
            <button className="caster-login-discord" onClick={onLogin}>
                Log in with Discord
            </button>
        </div>
    </div>
);

export default CasterLogin;
