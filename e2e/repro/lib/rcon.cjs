// Minimal GoldSrc / HLDS / HLTV UDP rcon client, shared by the sync probes.
// Mirrors the two-stage protocol in backend/src/handler/hltvSync.ts:
//   1. send  ÿÿÿÿchallenge rcon\n\0          → recv ÿÿÿÿchallenge rcon <num>\n\0
//   2. send  ÿÿÿÿrcon <num> <pwd> <cmd>\n\0  → recv ÿÿÿÿl<body>
// dgram only — no external deps.
'use strict';
const dgram = require('dgram');
const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// Run one rcon command; resolves the response body text, or null on any failure
// (timeout / network / no challenge). Never rejects — callers stay simple.
function rconCommand(host, port, password, command, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch (_) {} resolve(v); } };
        const timer = setTimeout(() => finish(null), timeoutMs);
        sock.once('message', (ch) => {
            const m = ch.toString('binary').match(/challenge rcon (-?\d+)/);
            if (!m) { clearTimeout(timer); return finish(null); }
            sock.once('message', (reply) => {
                clearTimeout(timer);
                // Strip the 4-byte 0xff prefix + 'l' marker. A trailing length
                // byte on some builds is harmless — callers parse via regex.
                finish(reply.slice(5).toString('utf8'));
            });
            sock.send(Buffer.concat([PREFIX, Buffer.from(`rcon ${m[1]} ${password} ${command}\n\0`)]), port, host,
                (e) => { if (e) { clearTimeout(timer); finish(null); } });
        });
        sock.send(Buffer.concat([PREFIX, Buffer.from('challenge rcon\n\0')]), port, host,
            (e) => { if (e) { clearTimeout(timer); finish(null); } });
    });
}

// Parse an HLTV `status` reply into structured fields. Returns null if it
// doesn't look like an HLTV status (no Game Time line). The "Proxies" counts
// distinguish a master (Local Proxies = downstream relays) from a relay; see
// ReHLDS Proxy.cpp CMD_Status.
function parseHltvStatus(text) {
    if (!text) return null;
    if (/Bad rcon_password|bad rcon/i.test(text)) return { error: 'bad rcon password', raw: text };
    const gt = text.match(/Game Time (\d+):(\d+)/);
    if (!gt) return null;
    const dl = text.match(/Delay (\d+)/);
    const mp = text.match(/Map "([^"]+)"/);
    const sn = text.match(/Server Name "([^"]+)"/);
    const local = text.match(/Local Slots[^\n]*Proxies (\d+)/);
    const total = text.match(/Total Slots[^\n]*Proxies (\d+)/);
    const conn = text.match(/Connected to Game Server (\S+)/);
    return {
        gameTime: parseInt(gt[1], 10) * 60 + parseInt(gt[2], 10),
        delay: dl ? parseInt(dl[1], 10) : null,
        map: mp ? mp[1].replace(/\.bsp$/, '') : null,
        serverName: sn ? sn[1] : null,
        localProxies: local ? parseInt(local[1], 10) : null,
        totalProxies: total ? parseInt(total[1], 10) : null,
        gameServer: conn ? conn[1].replace(/,$/, '') : null,
        raw: text,
    };
}

// Convenience: rcon `status` + parse. Returns the parsed object, { error } on
// bad password, or null on transport failure.
async function rconHltvStatus(host, port, password, timeoutMs) {
    const text = await rconCommand(host, port, password, 'status', timeoutMs);
    return text == null ? null : parseHltvStatus(text);
}

// "host:port" → [host, port]. Bad input → [input, NaN].
function splitHostPort(hp) {
    const i = String(hp).lastIndexOf(':');
    return i < 0 ? [hp, NaN] : [hp.slice(0, i), parseInt(hp.slice(i + 1), 10)];
}

module.exports = { rconCommand, parseHltvStatus, rconHltvStatus, splitHostPort };
