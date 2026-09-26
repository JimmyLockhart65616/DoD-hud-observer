import React, { useState } from 'react';

/** Shown instead of the live page until useCasterAuth reports loggedIn. */
const CasterLogin = ({ onSubmit, error, pending }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const submit = (e) => {
        e.preventDefault();
        if (!username || !password || pending) return;
        onSubmit(username, password);
    };

    return (
        <div className="caster-page caster-login-page">
            <form className="caster-login" onSubmit={submit}>
                <h1>Caster Login</h1>
                <p className="caster-login-note">
                    This page carries live player positions and is restricted to named casters.
                </p>
                <label className="caster-login-field">
                    <span>Username</span>
                    <input
                        type="text"
                        autoComplete="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoFocus
                    />
                </label>
                <label className="caster-login-field">
                    <span>Password</span>
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {error && <p className="caster-login-error">{error}</p>}
                <button type="submit" disabled={pending}>
                    {pending ? 'Logging in…' : 'Log in'}
                </button>
            </form>
        </div>
    );
};

export default CasterLogin;
