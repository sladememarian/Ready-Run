// level.js — procedural Kestrel-9. Instanced walls per CLAUDE.md; grid collision.
import * as THREE from 'three';

export const CELL = 3.2;
export const GRID = 41;          // odd, required by the carver
const WALL_H = 3.4;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class Level {
  constructor(seed = 1985) {
    this.rnd = mulberry32(seed);
    this.g = [];                 // 1 = open, 0 = solid
    this._carve();
    this._rooms();
    this._placePOIs();
  }

  idx(x, z) { return z * GRID + x; }
  open(x, z) {
    if (x < 0 || z < 0 || x >= GRID || z >= GRID) return false;
    return this.g[this.idx(x, z)] === 1;
  }
  toWorld(x, z) {
    const o = (GRID * CELL) / 2;
    return new THREE.Vector3(x * CELL - o + CELL / 2, 0, z * CELL - o + CELL / 2);
  }
  toGrid(v) {
    const o = (GRID * CELL) / 2;
    return { x: Math.floor((v.x + o) / CELL), z: Math.floor((v.z + o) / CELL) };
  }

  _carve() {
    this.g = new Array(GRID * GRID).fill(0);
    const stack = [[1, 1]];
    this.g[this.idx(1, 1)] = 1;
    const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]];
    while (stack.length) {
      const [cx, cz] = stack[stack.length - 1];
      const opts = [];
      for (const [dx, dz] of dirs) {
        const nx = cx + dx, nz = cz + dz;
        if (nx > 0 && nz > 0 && nx < GRID - 1 && nz < GRID - 1 && !this.open(nx, nz))
          opts.push([nx, nz, cx + dx / 2, cz + dz / 2]);
      }
      if (!opts.length) { stack.pop(); continue; }
      const [nx, nz, mx, mz] = opts[Math.floor(this.rnd() * opts.length)];
      this.g[this.idx(mx, mz)] = 1;
      this.g[this.idx(nx, nz)] = 1;
      stack.push([nx, nz]);
    }
    // Braid: knock out some dead ends so the player always has an escape route.
    // A perfect maze is unfair when the threat is faster than you.
    for (let z = 1; z < GRID - 1; z++) {
      for (let x = 1; x < GRID - 1; x++) {
        if (!this.open(x, z)) continue;
        let n = 0;
        if (this.open(x + 1, z)) n++;
        if (this.open(x - 1, z)) n++;
        if (this.open(x, z + 1)) n++;
        if (this.open(x, z - 1)) n++;
        if (n === 1 && this.rnd() < 0.72) {
          const c = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .filter(([dx, dz]) => !this.open(x + dx, z + dz)
              && x + dx > 0 && z + dz > 0 && x + dx < GRID - 1 && z + dz < GRID - 1);
          if (c.length) {
            const [dx, dz] = c[Math.floor(this.rnd() * c.length)];
            this.g[this.idx(x + dx, z + dz)] = 1;
          }
        }
      }
    }
  }

  _rooms() {
    this.roomCenters = [];
    for (let i = 0; i < 9; i++) {
      const w = 3 + Math.floor(this.rnd() * 3), h = 3 + Math.floor(this.rnd() * 3);
      const x = 2 + Math.floor(this.rnd() * (GRID - w - 4));
      const z = 2 + Math.floor(this.rnd() * (GRID - h - 4));
      for (let dz = 0; dz < h; dz++)
        for (let dx = 0; dx < w; dx++) this.g[this.idx(x + dx, z + dz)] = 1;
      this.roomCenters.push({ x: x + (w >> 1), z: z + (h >> 1) });
    }
  }

  _placePOIs() {
    const far = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const pool = this.roomCenters.slice();
    // spawn in one corner-ish room, relays spread as far apart as possible
    pool.sort((a, b) => (a.x + a.z) - (b.x + b.z));
    this.spawn = pool.shift();
    this.relays = [];
    while (this.relays.length < 3 && pool.length) {
      let best = null, bestD = -1;
      for (const c of pool) {
        const d = Math.min(far(c, this.spawn), ...this.relays.map((r) => far(c, r)));
        if (d > bestD) { bestD = d; best = c; }
      }
      this.relays.push(best);
      pool.splice(pool.indexOf(best), 1);
    }
    // lift: farthest remaining room from spawn
    this.lift = pool.length
      ? pool.reduce((a, b) => (far(b, this.spawn) > far(a, this.spawn) ? b : a))
      : { x: GRID - 3, z: GRID - 3 };
  }

  // Solid if the target cell is solid, with a radius skin test on neighbours.
  collides(v, r = 0.42) {
    for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const gp = this.toGrid(new THREE.Vector3(v.x + ox, 0, v.z + oz));
      if (!this.open(gp.x, gp.z)) return true;
    }
    return false;
  }

  // BFS next step — cheap enough to run every few frames for one agent.
  path(from, to) {
    const s = this.idx(from.x, from.z), t = this.idx(to.x, to.z);
    if (s === t) return null;
    const prev = new Int32Array(GRID * GRID).fill(-1);
    const seen = new Uint8Array(GRID * GRID);
    const q = [s]; seen[s] = 1;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      if (cur === t) break;
      const cx = cur % GRID, cz = (cur - cx) / GRID;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (!this.open(nx, nz)) continue;
        const ni = this.idx(nx, nz);
        if (seen[ni]) continue;
        seen[ni] = 1; prev[ni] = cur; q.push(ni);
      }
    }
    if (!seen[t]) return null;
    let cur = t;
    while (prev[cur] !== s && prev[cur] !== -1) cur = prev[cur];
    return { x: cur % GRID, z: (cur - (cur % GRID)) / GRID };
  }

  // ---- geometry ----
  build(scene) {
    const disposables = [];

    // Albedo note: the flashlight is the only real light, so surfaces need enough
    // reflectance to read at all. Near-black base colours render as pure black here.
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x35322a, roughness: 0.94, metalness: 0.04,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x403c31, roughness: 0.88, metalness: 0.06,
    });
    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x1e1c17, roughness: 1.0, metalness: 0,
    });
    disposables.push(floorMat, wallMat, ceilMat);

    const span = GRID * CELL;
    const planeGeo = new THREE.PlaneGeometry(span, span);
    disposables.push(planeGeo);

    const floor = new THREE.Mesh(planeGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const ceil = new THREE.Mesh(planeGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = WALL_H;
    scene.add(ceil);

    // Only instance wall cells adjacent to open space — interior rock is never seen.
    const cells = [];
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        if (this.open(x, z)) continue;
        if (this.open(x + 1, z) || this.open(x - 1, z) ||
            this.open(x, z + 1) || this.open(x, z - 1)) cells.push([x, z]);
      }
    }

    const wallGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);
    disposables.push(wallGeo);
    const walls = new THREE.InstancedMesh(wallGeo, wallMat, cells.length);
    walls.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    walls.castShadow = true;
    walls.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    cells.forEach(([x, z], i) => {
      p.copy(this.toWorld(x, z)); p.y = WALL_H / 2;
      s.set(1, 1 + (this.rnd() - 0.5) * 0.05, 1);   // slight height jitter: less tiled
      m.compose(p, q, s);
      walls.setMatrixAt(i, m);
    });
    walls.instanceMatrix.needsUpdate = true;
    scene.add(walls);
    this.wallCount = cells.length;

    // Sodium emergency strips — emissive only, they cast no light (light budget).
    // Dimmed well below the sodium accent colour: MeshBasicMaterial is unlit and
    // full-value, so 0xff8a3c clips to a neon bar at exposure 1.35. These are
    // failing 40-year-old emergency lamps, not signage.
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x7a3210 });
    const stripGeo = new THREE.BoxGeometry(0.1, 0.1, CELL * 0.55);
    disposables.push(stripMat, stripGeo);
    const strips = [];
    for (let z = 1; z < GRID - 1; z += 3) {
      for (let x = 1; x < GRID - 1; x += 3) {
        if (!this.open(x, z)) continue;
        if (this.rnd() > 0.30) continue;
        strips.push([x, z]);
      }
    }
    const strip = new THREE.InstancedMesh(stripGeo, stripMat, Math.max(strips.length, 1));
    strips.forEach(([x, z], i) => {
      p.copy(this.toWorld(x, z)); p.y = WALL_H - 0.22;
      m.compose(p, q, s.set(1, 1, 1));
      strip.setMatrixAt(i, m);
    });
    strip.count = strips.length;
    strip.instanceMatrix.needsUpdate = true;
    scene.add(strip);

    // Pipes — instanced vertical props for silhouette interest.
    const pipeMat = new THREE.MeshStandardMaterial({
      color: 0x241f18, roughness: 0.7, metalness: 0.45,
    });
    const pipeGeo = new THREE.CylinderGeometry(0.11, 0.11, WALL_H, 6);
    disposables.push(pipeMat, pipeGeo);
    const pipes = [];
    for (const [x, z] of cells) if (this.rnd() < 0.14) pipes.push([x, z]);
    const pipe = new THREE.InstancedMesh(pipeGeo, pipeMat, Math.max(pipes.length, 1));
    pipe.castShadow = true;
    pipes.forEach(([x, z], i) => {
      p.copy(this.toWorld(x, z));
      p.y = WALL_H / 2;
      p.x += (this.rnd() - 0.5) * CELL * 0.8;
      p.z += (this.rnd() - 0.5) * CELL * 0.8;
      m.compose(p, q, s.set(1, 1, 1));
      pipe.setMatrixAt(i, m);
    });
    pipe.count = pipes.length;
    pipe.instanceMatrix.needsUpdate = true;
    scene.add(pipe);

    this.disposables = disposables;
    return { walls, floor, ceil };
  }

  dispose() {
    (this.disposables || []).forEach((d) => d.dispose && d.dispose());
  }
}
