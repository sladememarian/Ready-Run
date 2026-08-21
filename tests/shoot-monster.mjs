// Visual check: creature silhouette in each state + corridor exposure.
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
    let sum = 0, max = 0, clipped = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      sum += l; if (l > max) max = l; if (l > 0.98) clipped++;
    }
    return {
      mean: +(sum / 14400).toFixed(4), max: +max.toFixed(3),
      clippedPct: +(100 * clipped / 14400).toFixed(2),
    };
  }, buf.toString('base64'));
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.click('#start');
await page.waitForTimeout(1800);

await page.evaluate(() => window.__rrBanish());
await page.waitForTimeout(500);
console.log('corridor  ', JSON.stringify(await luma('20-corridor')));

console.log(await page.evaluate(() => window.__rrShowcase(2.6, 4.2)));
await page.evaluate(() => window.__rrFreeze(true));
for (const st of ['DORMANT', 'ALERT', 'HUNT']) {
  await page.evaluate((s) => window.__rrSetState(s), st);
  await page.waitForTimeout(700);
  console.log(st.padEnd(10), JSON.stringify(await luma('21-' + st.toLowerCase())));
}

// Further away — does it still read at the edge of the cone's throw?
await page.evaluate(() => window.__rrShowcase(8, 12));
await page.evaluate(() => window.__rrSetState('HUNT'));
await page.waitForTimeout(700);
console.log('far HUNT  ', JSON.stringify(await luma('22-far-hunt')));

await browser.close();
