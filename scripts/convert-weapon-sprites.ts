/**
 * Weapon-sprite converter: BMP (dark silhouette on white) -> white-on-transparent PNG.
 *
 * The source art (assets/weapons-src/*.bmp) is 512x512 32-bit BMP: a thin DARK weapon
 * silhouette (~1.4% of pixels) on a pure-WHITE background, with a dead/all-zero alpha
 * channel. The HUD overlay panels are dark (rgba(48,54,97,.9)), so we recompute alpha
 * from luminance and force the silhouette to pure WHITE — the classic DoD death-notice
 * look, visible on the dark panels. Anti-aliased edges become partial-alpha white.
 *
 *   lum   = 0.299*R + 0.587*G + 0.114*B    // gray-on-white source
 *   alpha = 255 - lum                       // white -> transparent, dark -> opaque
 *   R = G = B = 255                          // pure-white silhouette
 *
 * Output filenames MUST equal the dodx `xmod_get_wpnlogname` value, because the frontend
 * does a literal `weaponImages[weapon]` key lookup against the raw string KTPHudObserver
 * emits (KTPHudObserver.sma:691 -> 712). The authoritative vocabulary is the dodx
 * weaponData[] table (KTPAMXX/modules/dod/dodx/Utils.cpp). Hence the RENAME map below
 * (the sprite author named some files by class/nickname, not by logname).
 *
 * The committed PNGs in web/.../images/weapons/ are the build artifact. Rerun this only
 * when the source art changes:  npm run assets:weapons
 *
 * Source BMPs live in assets/weapons-src/ (gitignored — 18 MB extracted). They compress
 * to assets/weapons-src.zip (38 KB), which IS committed for provenance. On a fresh clone,
 * extract the zip into assets/weapons-src/ before running (the script prints the command).
 */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const SRC_DIR = path.resolve(__dirname, '../assets/weapons-src');
const OUT_DIR = path.resolve(__dirname, '../web/src/components/screen/resources/images/weapons');
const LONGEST = 128;       // longest side of the trimmed output (renders at 12-18px; keeps quality)
const ALPHA_BBOX = 16;     // alpha threshold for the content bounding box (ignore AA fringe)
const PAD_FRAC = 0.06;     // breathing room around the weapon, as a fraction of bbox size

// Stems to skip. buttsmack.bmp has a GRAY (not white) background, so the luminance->alpha
// key turns the whole frame into a translucent box. Rifle-butt kills are rare (k43butt /
// garandbutt) and text-fall-back fine; re-enable if cleaner butt-smack art arrives.
const SKIP = new Set<string>(['buttsmack']);

// BMP stem -> output PNG name (= dodx logname). Stems not listed keep their own name
// (garand, bar, k43, colt, luger, spade, amerknife are already lognames).
const RENAME: { [stem: string]: string } = {
    kar98:        'kar',         // K98  (Axis Grenadier/Stosstruppe primary)
    scopekar:     'scopedkar',   // scoped K98 (Axis Scharfschuetze/sniper)
    stg:          'mp44',        // STG44 (Axis Sturmtruppe)
    unt:          'mp40',        // Unteroffizier's MP40
    tommy:        'thompson',    // Thompson (Allied Master Sergeant)
    sprinmg:      'spring',      // Springfield (Allied Sniper)
    amergrenade:  'grenade',     // US frag (logname "grenade")
    stickgrenade: 'grenade2',    // German frag (logname "grenade2")
    bayo:         'bayonet',     // K98 bayonet melee
};

// Standard Allies-vs-Axis 6v6 lognames we expect to map. Used only to report coverage.
const EXPECTED_6V6 = [
    'garand', 'm1carbine', 'thompson', 'bar', 'spring', 'bazooka', 'colt', 'amerknife',
    'kar', 'k43', 'mp40', 'mp44', 'scopedkar', 'pschreck', 'mg42', 'luger', 'spade',
];

function outNameFor(stem: string): string {
    return RENAME[stem] || stem;
}

async function convertOne(srcPath: string, outPath: string): Promise<void> {
    const img = await Jimp.read(srcPath);
    const W = img.bitmap.width, H = img.bitmap.height;

    // 1) white silhouette: alpha from luminance, RGB forced white (dead source alpha ignored)
    let minX = W, minY = H, maxX = -1, maxY = -1;
    img.scan(0, 0, W, H, function (this: any, x: number, y: number, idx: number) {
        const data = this.bitmap.data;
        const lum = 0.299 * data[idx + 0] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        const a = Math.round(255 - lum);
        data[idx + 0] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = a;
        if (a > ALPHA_BBOX) { // track content bounding box
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    });

    // 2) trim to the content bbox (+ padding) so the weapon fills the frame. The source
    //    art is a thin weapon centered in a mostly-empty 512px square; without trimming a
    //    rifle constrained to height:12-16px would be ~2px tall and invisible.
    if (maxX >= minX && maxY >= minY) {
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const padX = Math.round(bw * PAD_FRAC) + 2, padY = Math.round(bh * PAD_FRAC) + 2;
        const cx = Math.max(0, minX - padX), cy = Math.max(0, minY - padY);
        const cw = Math.min(W - cx, bw + 2 * padX), ch = Math.min(H - cy, bh + 2 * padY);
        img.crop(cx, cy, cw, ch);
    }

    // 3) resize so the longest side is LONGEST, preserving aspect (natural proportions)
    if (img.bitmap.width >= img.bitmap.height) img.resize(LONGEST, Jimp.AUTO);
    else img.resize(Jimp.AUTO, LONGEST);

    await img.writeAsync(outPath);
}

async function main(): Promise<void> {
    const ZIP = path.resolve(__dirname, '../assets/weapons-src.zip');
    const bmps: string[] = fs.existsSync(SRC_DIR)
        ? fs.readdirSync(SRC_DIR).filter((f: string) => f.toLowerCase().endsWith('.bmp')).sort()
        : [];
    if (bmps.length === 0) {
        console.error(`No source BMPs in ${SRC_DIR}`);
        console.error(`Extract the committed source zip first, e.g.:`);
        console.error(`  unzip "${ZIP}" -d "${SRC_DIR}"`);
        process.exit(3);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const produced: string[] = [];
    for (const file of bmps) {
        const stem = path.basename(file, path.extname(file));
        if (SKIP.has(stem)) {
            console.log(`  ${file.padEnd(20)} -> SKIPPED`);
            continue;
        }
        const outName = outNameFor(stem);
        await convertOne(path.join(SRC_DIR, file), path.join(OUT_DIR, `${outName}.png`));
        const renamed = outName !== stem ? `  (from ${stem})` : '';
        console.log(`  ${file.padEnd(20)} -> ${outName}.png${renamed}`);
        produced.push(outName);
    }

    console.log(`\nConverted ${produced.length} sprite(s) -> ${OUT_DIR}`);

    const missing = EXPECTED_6V6.filter((w) => !produced.includes(w));
    if (missing.length) {
        console.log(`\nNo sprite for standard-6v6 logname(s) (text fallback in HUD): ${missing.join(', ')}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
