// Headless logic verification — no WebGL, no browser. Run: node tests/verify-level.mjs
import fs from 'node:fs';

const LEVEL_PATH = new URL('../src/level.js', import.meta.url);
const src = fs.readFileSync(LEVEL_PATH, 'utf8');

// Stub three (Level's logic only needs Vector3) and strip the GPU build() method.
const THREE_STUB = `const THREE={Vector3:class{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}` +
  `set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}}};`;
const patched = src
  .replace(/^import \* as THREE from 'three';$/m, THREE_STUB)
  .replace(/\n {2}build\(scene\)[\s\S]*?\n {2}\}\n\n {2}dispose/, '\n  dispose');

const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(patched).toString('base64')
);
const { Level, GRID } = mod;

let fails = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
}

for (const seed of [1985, 42, 7777, 31415, 999, 20260820]) {
  const L = new Level(seed);

  // flood fill from spawn
  const seen = new Set();
  const stack = [[L.spawn.x, L.spawn.z]];
  seen.add(L.spawn.z * GRID + L.spawn.x);
  while (stack.length) {
    const [x, z] = stack.pop();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!L.open(nx, nz)) continue;
      const k = nz * GRID + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push([nx, nz]);
    }
  }

  let openCount = 0;
  for (let i = 0; i < GRID * GRID; i++) if (L.g[i] === 1) openCount++;

  check(`s${seed}: every open cell reachable`, seen.size === openCount, `${seen.size}/${openCount}`);
  L.relays.forEach((r, i) =>
    check(`s${seed}: relay ${i} reachable`, seen.has(r.z * GRID + r.x)));
  check(`s${seed}: lift reachable`, seen.has(L.lift.z * GRID + L.lift.x));
  check(`s${seed}: 3 distinct relays`,
    new Set(L.relays.map((r) => `${r.x},${r.z}`)).size === 3);

  const step = L.path(L.spawn, L.relays[0]);
  check(`s${seed}: path() yields a valid step`, !!step && L.open(step.x, step.z));

  const d = Math.hypot(L.lift.x - L.spawn.x, L.lift.z - L.spawn.z);
  check(`s${seed}: lift far from spawn`, d > 6, `d=${d.toFixed(1)}`);

  // spawn must not be inside a wall
  check(`s${seed}: spawn is open`, L.open(L.spawn.x, L.spawn.z));

  // braiding should leave few dead ends (fairness: escape routes exist)
  let deadEnds = 0;
  for (let z = 1; z < GRID - 1; z++) {
    for (let x = 1; x < GRID - 1; x++) {
      if (!L.open(x, z)) continue;
      let n = 0;
      if (L.open(x + 1, z)) n++;
      if (L.open(x - 1, z)) n++;
      if (L.open(x, z + 1)) n++;
      if (L.open(x, z - 1)) n++;
      if (n === 1) deadEnds++;
    }
  }
  const ratio = deadEnds / openCount;
  check(`s${seed}: dead ends braided down`, ratio < 0.06,
    `${deadEnds} (${(ratio * 100).toFixed(1)}%)`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll logic checks passed.');
process.exit(fails ? 1 : 0);
