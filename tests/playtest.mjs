// Boots the real game in Chrome, plays the full loop, screenshots, asserts budgets.
// Run: node tests/playtest.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.RR_URL || 'http://127.0.0.1:8177';
const SHOTS = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

const errors = [];
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const shot = async (n) => {
  await page.screenshot({ path: path.join(SHOTS, n + '.png') });
};
const info = () => page.evaluate(() => window.__readyRun());

// Mean luminance of the frame — catches "renders pure black" and "blown out".
const luma = async (name) => {
  const buf = await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  return page.evaluate(async (b64) => {
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
    return { mean: +(sum / (160 * 90)).toFixed(4), max: +max.toFixed(3) };
  }, buf.toString('base64'));
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

console.log('\n=== boot ===');
check('title renders', (await page.textContent('#start h1')) === 'READY·RUN');
await shot('01-start');

await page.click('#start');
await page.waitForTimeout(2200);
await page.evaluate(() => window.__rrBanish());
await page.waitForTimeout(400);

console.log('\n=== render sanity ===');
const i1 = await info();
console.log('  ' + JSON.stringify(i1));
check('level built', i1.wallInstances > 300, `${i1.wallInstances} wall instances`);
check('scene draws geometry', i1.drawCalls > 1, `drawCalls=${i1.drawCalls}`);
check('triangles rendered', i1.triangles > 1000, `tris=${i1.triangles}`);
check('draw calls under budget (<150)', i1.drawCalls < 150, `${i1.drawCalls}`);
check('fps >= 50', i1.fps >= 50, `${i1.fps}`);

console.log('\n=== flashlight actually lights ===');
const onL = await luma('05-flashlight-on');
console.log('  flashlight ON  luma:', JSON.stringify(onL));
check('lit frame is not black', onL.mean > 0.012, `mean=${onL.mean}`);
check('lit frame has highlights', onL.max > 0.20, `max=${onL.max}`);
check('lit frame not blown out', onL.mean < 0.60, `mean=${onL.mean}`);

await page.keyboard.press('KeyF');
await page.waitForTimeout(800);
const offL = await luma('04-flashlight-off');
console.log('  flashlight OFF luma:', JSON.stringify(offL));
const offInfo = await info();
check('flashlight state toggled', offInfo.flashlight === false);
check('intensity fell toward 0', offInfo.flashlightIntensity < 20, `I=${offInfo.flashlightIntensity}`);
check('OFF is darker than ON', offL.mean < onL.mean * 0.75,
  `off=${offL.mean} on=${onL.mean}`);
check('OFF still faintly navigable', offL.mean > 0.0015, `mean=${offL.mean}`);
await page.keyboard.press('KeyF');
await page.waitForTimeout(700);

console.log('\n=== creature is actually lit (regression: SpotLight DEFAULT_UP) ===');
// SpotLight's constructor sets position to (0,1,0). Parented to the camera that put
// the emitter 1m above the eye aiming 45deg down, so everything above chest height
// fell outside the cone and the creature rendered as a legless torso. These checks
// pin the cone to the eye and require every body part to be inside it AND lit.
await page.evaluate(() => window.__rrShowcase(2.6, 4.2));
await page.evaluate(() => { window.__rrSetState('HUNT'); window.__rrFreeze(true); });
await page.waitForTimeout(500);
const cre = await page.evaluate(() => window.__rrProbe({}));
check('spot emitter sits at the eye, not above it',
  Math.abs(cre.spot.posY - cre.camY) < 0.02, `spotY=${cre.spot.posY} camY=${cre.camY}`);
check('spot axis is level, not angled at the floor',
  Math.abs(cre.spot.axis[1]) < 0.02, `axis.y=${cre.spot.axis[1]}`);

const worst = cre.parts.reduce((a, p) => (p.offAxisDeg > a.offAxisDeg ? p : a));
check('every body part inside the flashlight cone',
  worst.offAxisDeg <= cre.spot.outerDeg,
  `worst=${worst.name} ${worst.offAxisDeg}deg vs outer ${cre.spot.outerDeg}deg`);

// An unnamed mesh reports as '?' in the probe table, which is useless precisely when a
// part is unlit and you need to know which one.
const unnamed = cre.parts.filter((p) => !p.name || p.name === '?');
check('every body part is named', unnamed.length === 0,
  unnamed.length ? `${unnamed.length} unnamed at y=${unnamed.map((p) => p.y).join(',')}` : '');

// Sample the real pixel at each part's projected position — geometry can be inside
// the cone and still render black if a material or shadow term is wrong.
const creShot = await page.screenshot({ path: path.join(SHOTS, '11-creature-lit.png') });
const lit = await page.evaluate(async ({ b64, parts }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return parts.map((p) => {
    const d = g.getImageData(Math.max(0, p.sx - 4), Math.max(0, p.sy - 4), 8, 8).data;
    let best = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      if (l > best) best = l;
    }
    return { name: p.name, y: p.y, peak: +best.toFixed(3) };
  });
}, { b64: creShot.toString('base64'), parts: cre.parts });
console.log('  ' + lit.map((p) => `${p.name}@${p.y}=${p.peak}`).join(' '));
const darkest = lit.reduce((a, p) => (p.peak < a.peak ? p : a));
check('no body part renders black', darkest.peak > 0.08,
  `darkest=${darkest.name} peak=${darkest.peak}`);
const brightest = lit.reduce((a, p) => (p.peak > a.peak ? p : a));
check('creature is not blown out', brightest.peak < 0.98,
  `brightest=${brightest.name} peak=${brightest.peak}`);

// The upper body specifically — that is what the bug hid.
const upper = lit.filter((p) => p.y > 2.0);
check('upper body (head/ears) is lit', upper.length >= 3 && upper.every((p) => p.peak > 0.08),
  upper.map((p) => `${p.name}=${p.peak}`).join(' '));

await page.evaluate(() => window.__rrFreeze(false));

console.log('\n=== movement + noise model ===');
await page.evaluate(() => window.__rrBanish());
const before = await page.evaluate(() => window.__readyRun().noise);
await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
await page.waitForTimeout(1100);
const sprintNoise = await page.evaluate(() => window.__readyRun().noise);
await page.keyboard.up('ShiftLeft');
await page.keyboard.down('ControlLeft');
await page.waitForTimeout(1100);
const crouchNoise = await page.evaluate(() => window.__readyRun().noise);
await page.keyboard.up('ControlLeft'); await page.keyboard.up('KeyW');
await page.waitForTimeout(600);
const stillNoise = await page.evaluate(() => window.__readyRun().noise);
console.log(`  idle=${before} sprint=${sprintNoise} crouch=${crouchNoise} still=${stillNoise}`);
check('sprint is loud', sprintNoise > 0.6, `${sprintNoise}`);
check('crouch is quiet', crouchNoise < 0.35, `${crouchNoise}`);
check('sprint louder than crouch', sprintNoise > crouchNoise);
check('standing still is silent', stillNoise < 0.1, `${stillNoise}`);
await shot('03-after-walk');

console.log('\n=== listener escalates on noise, ignores silence ===');
// Place it within hearing range (46m at full intensity) but not kill range.
const placed = await page.evaluate(() => window.__rrPlaceListener(7));
console.log('  ' + placed);
const dorm = (await info()).listenerState;

// Stand perfectly still for 2s — it must NOT escalate on silence.
await page.waitForTimeout(2000);
const afterSilence = await info();
check('listener starts dormant', dorm === 'DORMANT');
check('silence does not escalate', afterSilence.listenerState === 'DORMANT',
  afterSilence.listenerState);

// Now sprint — loud, and it must escalate.
await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
await page.waitForTimeout(1800);
const afterNoise = await info();
await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
console.log(`  ${dorm} -> ${afterNoise.listenerState}  (dist=${afterNoise.listenerDist}m)`);
check('sprinting escalates listener',
  afterNoise.listenerState === 'HUNT' || afterNoise.listenerState === 'ALERT',
  afterNoise.listenerState);
await shot('07-hunting');

// Crouch-walking from a fresh dormant state must not escalate to HUNT.
await page.evaluate(() => window.__rrPlaceListener(14));
await page.waitForTimeout(300);
await page.keyboard.down('ControlLeft'); await page.keyboard.down('KeyW');
await page.waitForTimeout(2200);
const afterCrouch = await info();
await page.keyboard.up('KeyW'); await page.keyboard.up('ControlLeft');
console.log(`  crouch-walk at 14 cells -> ${afterCrouch.listenerState}`);
check('crouching does not trigger HUNT', afterCrouch.listenerState !== 'HUNT',
  afterCrouch.listenerState);

console.log('\n=== relay alignment loop ===');
await page.evaluate(() => { window.__rrWarp(0); window.__rrBanish(); });
await page.waitForTimeout(500);
await shot('08a-at-relay');
const promptVisible = await page.evaluate(() =>
  document.getElementById('prompt').classList.contains('on'));
check('relay prompt appears in range', promptVisible);

await page.keyboard.down('KeyE');
await page.waitForTimeout(1500);
const midAlign = await page.evaluate(() => ({
  noise: window.__readyRun().noise,
  progress: document.getElementById('progress-fill').style.width,
  text: document.getElementById('prompt-text').textContent,
}));
console.log('  mid-align:', JSON.stringify(midAlign));
check('aligning is loud (0.9)', midAlign.noise > 0.8, `${midAlign.noise}`);
check('progress bar advances', parseFloat(midAlign.progress) > 5, midAlign.progress);
await shot('08b-aligning');

// hold to completion (ALIGN_TIME = 7s), re-banishing so the test isn't killed
for (let i = 0; i < 7; i++) {
  await page.evaluate(() => window.__rrBanish());
  await page.waitForTimeout(900);
}
await page.keyboard.up('KeyE');
await page.waitForTimeout(400);
const afterAlign = await info();
console.log('  relays:', JSON.stringify(afterAlign.relays));
check('relay 0 completed', afterAlign.relays[0] === true);
await shot('08c-relay-done');

console.log('\n=== complete all relays -> lift powers ===');
for (const r of [1, 2]) {
  await page.evaluate((n) => { window.__rrWarp(n); window.__rrBanish(); }, r);
  await page.waitForTimeout(400);
  await page.keyboard.down('KeyE');
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.__rrBanish());
    await page.waitForTimeout(900);
  }
  await page.keyboard.up('KeyE');
  await page.waitForTimeout(300);
}
const allDone = await info();
console.log('  relays:', JSON.stringify(allDone.relays), 'liftLive:', allDone.liftLive);
check('all three relays aligned', allDone.relays.every(Boolean));
check('lift powered', allDone.liftLive === true);

console.log('\n=== reach lift -> win ===');
await page.evaluate(() => { window.__rrWarp('lift'); window.__rrBanish(); });
await page.waitForTimeout(1600);
const winShown = await page.evaluate(() =>
  !document.getElementById('win').classList.contains('hide'));
check('win screen shown', winShown);
await shot('10-win');

console.log('\n=== stability ===');
const real = errors.filter((e) => !/favicon/i.test(e));
if (real.length) real.slice(0, 10).forEach((e) => console.log('    ' + e));
check('no console/page errors', real.length === 0, real.length ? `${real.length}` : '');

await browser.close();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nPlaytest passed.');
process.exit(fails ? 1 : 0);
