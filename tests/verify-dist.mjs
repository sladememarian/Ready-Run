// Verifies the release build end-to-end along the path a playtester actually takes:
// extract the zip with the OS's own unzipper, then run the EXTRACTED copy from file://
// with no server and no special browser flags.
//
// Testing dist/ directly would not catch a malformed archive, and tools/zip.mjs is
// hand-rolled — a zip Explorer refuses to open is worthless no matter how good the build is.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const ZIP = path.join(ROOT, 'Ready-Run-playtest.zip');
const SHOTS = path.join(ROOT, 'tests', 'shots');

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

console.log('\n=== dist contents ===');
const files = fs.readdirSync(DIST).sort();
console.log('  ' + files.join('  '));
const expected = ['HOW-TO-PLAY.txt', 'app.js', 'index.html'];
check('ships exactly the built artifacts',
  JSON.stringify(files) === JSON.stringify(expected), files.join(','));

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
check('no CDN dependency', !html.includes('jsdelivr') && !html.includes('importmap'));
check('no module script (would break file://)', !html.includes('type="module"'));

// The point of the exercise: no readable source in the payload. Minification is not
// secrecy, but the original files and names must not be sitting there in plain text.
const bundle = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8');
check('no sourcemap shipped', !bundle.includes('sourceMappingURL')
  && !fs.existsSync(path.join(DIST, 'app.js.map')));
check('source filenames not embedded',
  !['listener.js', 'level.js', 'main.js', 'audio.js'].some((f) => bundle.includes(f)));

console.log('\n=== archive unpacks with the OS unzipper ===');
check('zip exists', fs.existsSync(ZIP), ZIP);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-dist-'));
// Expand-Archive uses the same System.IO.Compression that Explorer does, so a pass here
// means a double-click extract works too.
execFileSync('powershell', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${tmp}' -Force`],
  { stdio: 'pipe' });
const extracted = path.join(tmp, 'Ready-Run');
check('extracts to a single named folder', fs.existsSync(extracted),
  fs.readdirSync(tmp).join(','));
check('extracted files intact',
  JSON.stringify(fs.readdirSync(extracted).sort()) === JSON.stringify(expected),
  fs.readdirSync(extracted).join(','));
check('extracted bundle is byte-identical',
  fs.readFileSync(path.join(extracted, 'app.js')).equals(
    fs.readFileSync(path.join(DIST, 'app.js'))));

const url = pathToFileURL(path.join(extracted, 'index.html')).href;
console.log('\n=== the extracted copy boots from file:// with no server ===');
console.log('  ' + url);

const errors = [];
const browser = await chromium.launch({ channel: 'chrome' });   // no extra flags
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(url);
await page.waitForTimeout(2500);
check('start screen renders', (await page.textContent('#start h1')) === 'READY·RUN');
check('loading overlay cleared',
  await page.evaluate(() => document.getElementById('loading').classList.contains('hide')));

console.log('\n=== debug hooks are gone ===');
// __rrBanish / __rrWarp in the console would let a playtester skip the game, which
// quietly invalidates their feedback — the reason the build strips them at all.
const hooks = await page.evaluate(() => ({
  readyRun: typeof window.__readyRun,
  banish: typeof window.__rrBanish,
  warp: typeof window.__rrWarp,
  setState: typeof window.__rrSetState,
  showcase: typeof window.__rrShowcase,
  freeze: typeof window.__rrFreeze,
  probe: typeof window.__rrProbe,
}));
console.log('  ' + JSON.stringify(hooks));
check('every __rr* hook undefined', Object.values(hooks).every((t) => t === 'undefined'));

console.log('\n=== renders and plays ===');
await page.click('#start');
await page.waitForTimeout(2500);
await page.keyboard.down('KeyW');
await page.waitForTimeout(900);
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);

const buf = await page.screenshot({ path: path.join(SHOTS, '30-dist-filesystem.png') });
const lit = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 160, 90);
  const d = g.getImageData(0, 0, 160, 90).data;
  let sum = 0, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    sum += l; if (l > max) max = l;
  }
  return { mean: +(sum / 14400).toFixed(4), max: +max.toFixed(3) };
}, buf.toString('base64'));
console.log('  frame luma: ' + JSON.stringify(lit));
check('canvas is rendering, not black', lit.mean > 0.008, `mean=${lit.mean}`);
check('frame has flashlight highlights', lit.max > 0.20, `max=${lit.max}`);
check('HUD is live', await page.evaluate(() =>
  document.getElementById('hud').classList.contains('on')));

// Not checked here: audio. The release build strips every probe by design, so there is
// no way to read the AudioContext state from outside — verified in dev by tests/playtest.mjs.

const real = errors.filter((e) => !/favicon/i.test(e));
if (real.length) real.slice(0, 8).forEach((e) => console.log('    ' + e));
check('no console/page errors', real.length === 0, real.length ? `${real.length}` : '');

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nRelease build verified.');
process.exit(fails ? 1 : 0);
