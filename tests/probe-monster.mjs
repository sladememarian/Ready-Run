// Diagnostic: is the Listener's upper body actually lit? Samples the real pixel at
// each body part's projected screen position instead of eyeballing a screenshot.
import { chromium } from 'playwright';
import path from 'node:path';

const BASE = process.env.RR_URL || 'http://127.0.0.1:8177';
const SHOTS = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'shots');

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.click('#start');
await page.waitForTimeout(1800);

console.log(await page.evaluate(() => window.__rrShowcase(2.6, 4.2)));
await page.evaluate(() => { window.__rrSetState('HUNT'); window.__rrFreeze(true); });
await page.waitForTimeout(600);

const probe = await page.evaluate(() => window.__rrProbe({}));
console.log('spot:', JSON.stringify(probe.spot));
console.log('camY:', probe.camY);

// Sample the live canvas at each part's screen position, averaged over a small box
// so a 1px miss on a thin limb doesn't read as "black".
const shot = await page.screenshot({ path: path.join(SHOTS, '15-probe.png') });
const sampled = await page.evaluate(async ({ b64, parts }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const R = 4;
  return parts.map((p) => {
    const x0 = Math.max(0, p.sx - R), y0 = Math.max(0, p.sy - R);
    const w = Math.min(R * 2, c.width - x0), h = Math.min(R * 2, c.height - y0);
    if (w <= 0 || h <= 0) return { ...p, luma: null, note: 'offscreen' };
    const d = g.getImageData(x0, y0, w, h).data;
    let best = 0, sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      sum += l; n++; if (l > best) best = l;
    }
    return { ...p, luma: +(sum / n).toFixed(3), peak: +best.toFixed(3) };
  });
}, { b64: shot.toString('base64'), parts: probe.parts });

console.log('\npart      worldY  dist  offAxis  screen        luma   peak  side');
for (const p of sampled) {
  const inCone = p.offAxisDeg <= probe.spot.outerDeg ? '' : '  <-- OUTSIDE CONE';
  console.log(
    `${p.name.padEnd(9)} ${String(p.y).padStart(5)} ${String(p.dist).padStart(5)} ` +
    `${String(p.offAxisDeg).padStart(6)}째 ${String(p.sx).padStart(4)},${String(p.sy).padStart(3)}` +
    `   ${String(p.luma).padStart(5)} ${String(p.peak).padStart(5)}  ${p.side}${inCone}`);
}

await browser.close();
