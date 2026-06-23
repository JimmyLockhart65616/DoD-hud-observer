// Minimal GoldSrc/HLDS UDP rcon client for the local full-stack repro.
// Protocol mirrors backend/src/handler/hltvSync.ts:
//   1. send  \xff\xff\xff\xff challenge rcon\n\0   -> \xff\xff\xff\xff challenge rcon <num>\n\0
//   2. send  \xff\xff\xff\xff rcon <num> <pwd> <cmd>\n\0 -> \xff\xff\xff\xff l<body>
//
// Usage:
//   node e2e/repro/rcon.cjs <host> <port> <password> <command...>
//   node e2e/repro/rcon.cjs 127.0.0.1 27016 changeme amx_ktp_test_advance_live 1
const dgram = require('dgram');

const [host, portStr, password, ...cmdParts] = process.argv.slice(2);
if (!host || !portStr || !password || cmdParts.length === 0) {
    console.error('usage: node rcon.cjs <host> <port> <password> <command...>');
    process.exit(2);
}
const port = parseInt(portStr, 10);
const command = cmdParts.join(' ');
const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const TIMEOUT = 5000;

function roundTrip(sock, packet) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { sock.removeAllListeners('message'); reject(new Error('rcon timeout')); }, TIMEOUT);
        sock.once('message', (msg) => { clearTimeout(t); resolve(msg); });
        sock.send(packet, port, host, (err) => { if (err) { clearTimeout(t); reject(err); } });
    });
}

(async () => {
    const sock = dgram.createSocket('udp4');
    try {
        const ch = await roundTrip(sock, Buffer.concat([PREFIX, Buffer.from('challenge rcon\n\0')]));
        const m = ch.toString('binary').match(/challenge rcon (-?\d+)/);
        if (!m) throw new Error('no challenge: ' + ch.toString('utf8').slice(0, 80));
        const reply = await roundTrip(sock, Buffer.concat([PREFIX, Buffer.from(`rcon ${m[1]} ${password} ${command}\n\0`)]));
        process.stdout.write(reply.slice(5).toString('utf8'));
        console.log(`\n[rcon ok] ${command}`);
    } catch (e) {
        console.error(`[rcon FAIL] ${command}: ${e.message}`);
        process.exit(1);
    } finally {
        sock.close();
    }
})();
