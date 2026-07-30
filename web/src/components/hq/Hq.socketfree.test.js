/**
 * Structural guard for the HQ board's one catastrophic failure mode.
 *
 * core/Socket/Socket.jsx calls socketio.connect() at MODULE TOP LEVEL and reads
 * the room from window.location.search in the same breath. Importing anything
 * from it — even just useHudStore — opens a socket and, absent a
 * ?server=/?match= param, joins the legacy `hud_socket` firehose, merging every
 * server's events into a module-level singleton store that cannot support two
 * concurrent consumers. On /hq that would corrupt state for whichever server
 * happened to emit last, with no error anywhere.
 *
 * This reads source text rather than rendering, so it's deterministic, runs in
 * milliseconds, and can't be defeated by lazy evaluation or conditional imports.
 */
const fs = require('fs');
const path = require('path');

/** The only core/ modules HQ may reach into. Both verified to import React only. */
const ALLOWED_CORE_IMPORTS = [
    '../core/Score/timer/Timer',
    '../core/Flags/humanize',
];

/**
 * Comments are stripped before scanning. Hq.jsx's header comment deliberately
 * names Socket.jsx, useHudStore and gameEvents to explain WHY the rule exists —
 * documentation must not trip the guard that documents it.
 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function hqSources() {
    return fs.readdirSync(__dirname)
        .filter(f => /\.jsx?$/.test(f) && !f.includes('.test.'))
        .map(f => [f, stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'))]);
}

/** Every module specifier imported or required by a file. */
function importsOf(src) {
    return [
        ...[...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
        ...[...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
        ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
    ];
}

describe('HQ board module boundaries', () => {
    it('finds HQ source files to check', () => {
        // Guards against the glob silently matching nothing, which would make
        // every assertion below vacuously pass.
        expect(hqSources().length).toBeGreaterThanOrEqual(5);
    });

    it('never imports core/Socket', () => {
        const offenders = [];
        for (const [file, src] of hqSources()) {
            for (const spec of importsOf(src)) {
                if (/core\/Socket/.test(spec)) offenders.push(`${file}: ${spec}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('never references the singleton store or the gameEvents bus in code', () => {
        const offenders = hqSources()
            .filter(([, src]) => /\buseHudStore\b|\bgameEvents\b|\bSocketStoreComponent\b/.test(src))
            .map(([file]) => file);
        expect(offenders).toEqual([]);
    });

    it('never imports socket.io-client directly', () => {
        const offenders = [];
        for (const [file, src] of hqSources()) {
            for (const spec of importsOf(src)) {
                if (/socket\.io-client/.test(spec)) offenders.push(`${file}: ${spec}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('reaches into core/ only via the vetted allowlist', () => {
        const violations = [];
        for (const [file, src] of hqSources()) {
            for (const spec of importsOf(src)) {
                if (!spec.includes('/core/')) continue;
                if (!ALLOWED_CORE_IMPORTS.includes(spec)) violations.push(`${file}: ${spec}`);
            }
        }
        expect(violations).toEqual([]);
    });
});

describe('Hq.css scoping', () => {
    /**
     * CRA emits one global stylesheet, and App.jsx statically imports the
     * /screen overlay — so Hq.css and Screen.css coexist at runtime. An
     * unprefixed selector here would silently restyle the live broadcast
     * overlay, which is in production use.
     */
    it('declares only .hq- prefixed selectors', () => {
        const css = fs.readFileSync(path.join(__dirname, 'Hq.css'), 'utf8');
        // Strip comments, then take the selector text preceding each rule block.
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const offenders = [];

        for (const match of withoutComments.matchAll(/(^|})([^{}]+){/g)) {
            const selectorList = match[2].trim();
            if (!selectorList || selectorList.startsWith('@')) continue;
            for (const selector of selectorList.split(',')) {
                const trimmed = selector.trim();
                if (trimmed && !trimmed.startsWith('.hq-')) offenders.push(trimmed);
            }
        }

        expect(offenders).toEqual([]);
    });
});
