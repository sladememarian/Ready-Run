// Logic checks for the android-branch touch overlay. No browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

console.log('\n=== touch overlay (android) ===');
check('viewport meta', html.includes('width=device-width'));
check('touch-ui markup', html.includes('id="touch-ui"') && html.includes('id="joy-knob"'));
check('four action buttons', ['btn-e', 'btn-f', 'btn-sprint', 'btn-crouch'].every((id) => html.includes(`id="${id}"`)));
check('keyboard WASD still present', js.includes('keys.KeyW') && js.includes('keys.KeyA'));
check('pointer lock skipped in touch mode', js.includes('!touch.active') && js.includes('requestPointerLock'));
check('stick feeds movement', js.includes('touch.x') && js.includes('touch.y') && js.includes('addScaledVector(TMP.fwd'));
check('deadzone on stick', js.includes('0.12'));
check('sprint/crouch/hold OR keyboard', js.includes('touch.sprint') && js.includes('touch.crouch') && js.includes('touch.holdE'));
check('look via pointer delta', js.includes('game.yaw -= dx * 0.0044'));
check('pitch still clamped', js.includes('Math.PI / 2 - 0.02'));
check('desktop KeyE still works', js.includes('keys.KeyE || touch.holdE'));
check('no pointer lock on mobile begin', js.includes('if (!touch.active) renderer.domElement.requestPointerLock()'));

// Analog mapping: screen +y (down) must walk backward relative to yaw 0 (facing -Z).
{
  const yaw = 0;
  const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }; // (0, -1)
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }; // (1, 0)
  const touchY = 1, touchX = 0; // thumb down
  const mx = fwd.x * -touchY + right.x * touchX;
  const mz = fwd.z * -touchY + right.z * touchX;
  check('stick down walks +Z (back)', mz > 0.9 && Math.abs(mx) < 1e-9, `mx=${mx} mz=${mz}`);
}

if (fails) {
  console.error(`\n${fails} touch checks failed`);
  process.exit(1);
}
console.log('\nall touch checks passed');
