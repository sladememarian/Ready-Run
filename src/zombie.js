// zombie.js — the new antagonist. Loads ZombieSmooth.obj, procedural rot texture,
// same blind sound-hunter AI contract as listener.js (hear/proximity/update/dispose),
// plus a jump-scare lunge when it reaches kill range.
import * as THREE from 'three';

export const STATE = { DORMANT: 'DORMANT', ALERT: 'ALERT', HUNT: 'HUNT', SEARCH: 'SEARCH' };

const SPEED = { DORMANT: 1.25, ALERT: 2.15, HUNT: 3.55, SEARCH: 1.7 };
const HEAR_RANGE = 46;
const KILL_DIST = 1.15;

// --- jump-scare tuning ---
const LUNGE_TRIGGER = 2.1;     // start the lunge from this distance
const LUNGE_TIME = 0.42;       // seconds of lunge before the kill lands
const LUNGE_SPEED = 9.5;       // m/s toward the player during the scare

// Procedural zombie skin — vertex colors. The shipped OBJ has only 42 UVs for
// 1054 verts (no usable unwrap), so a texture map cannot work; painting per-vertex
// rot colors does, and needs no assets.
function paintZombieVertices(geo) {
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  // deterministic hash noise so the pattern is stable frame to frame
  const h = (x, y, z) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n1 = h(x * 2.1, y * 2.3, z * 1.9);        // large mottle
    const n2 = h(x * 6.4, y * 6.9, z * 5.8);        // fine grain
    const heightT = y / 2.58;                        // 0 feet → 1 crown

    // base: decayed grey-green — pushed brighter so it reads in near-dark
    c.setRGB(
      0.38 + n1 * 0.14 + heightT * 0.12,
      0.44 + n1 * 0.12 - heightT * 0.05,
      0.32 + n2 * 0.08,
    );
    // rot patches: dark brown-black blotches
    if (n2 > 0.72) {
      const k = (n2 - 0.72) / 0.28;
      c.lerp(new THREE.Color(0.16, 0.10, 0.07), k * 0.85);
    }
    // exposed wounds: raw red-brown, rarer and deeper
    if (n1 > 0.86) {
      const k = Math.min(1, (n1 - 0.86) / 0.14);
      c.lerp(new THREE.Color(0.42, 0.11, 0.07), k);
    }
    // grime near the feet — crawled through filth
    if (heightT < 0.22) {
      c.lerp(new THREE.Color(0.13, 0.12, 0.09), (0.22 - heightT) / 0.22 * 0.7);
    }
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Minimal OBJ loader — v/vn/vt/f lines only, triangulated on read.
function parseOBJ(text) {
  const pos = [], nor = [], uvs = [];
  const verts = [], norms = [], uvsOut = [], idx = [];
  const map = Object.create(null);
  let next = 0;

  const key = (p, n, t) => `${p}|${n}|${t}`;
  const addCorner = (p, n, t) => {
    const k = key(p, n, t);
    if (map[k] !== undefined) { idx.push(map[k]); return; }
    map[k] = next++;
    const pp = pos[(p - 1) * 3];
    verts.push(pp, pos[(p - 1) * 3 + 1], pos[(p - 1) * 3 + 2]);
    uvsOut.push(t > 0 ? uvs[(t - 1) * 2] : 0, t > 0 ? uvs[(t - 1) * 2 + 1] : 0);
    if (n > 0 && nor.length >= n * 3) {
      norms.push(nor[(n - 1) * 3], nor[(n - 1) * 3 + 1], nor[(n - 1) * 3 + 2]);
    } else {
      norms.push(0, 1, 0); // patched after via computeVertexNormals fallback
    }
    idx.push(map[k]);
  };

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') pos.push(+parts[1], +parts[2], +parts[3]);
    else if (parts[0] === 'vn') nor.push(+parts[1], +parts[2], +parts[3]);
    else if (parts[0] === 'vt') uvs.push(+parts[1], +parts[2]);
    else if (parts[0] === 'f') {
      // f a/b/c d/e/f ... -> fan-triangulate
      const corners = parts.slice(1).map((tok) => {
        const [p, t, n] = tok.split('/');
        return [+p, +(t || 0), +(n || 0)];
      });
      for (let i = 1; i < corners.length - 1; i++) {
        addCorner(...corners[0]);
        addCorner(...corners[i]);
        addCorner(...corners[i + 1]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvsOut, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals(); // authoritative normals — OBJ ones may be sparse
  return geo;
}

export class Listener {
  constructor(level, spawnCell) {
    this.level = level;
    this.state = STATE.DORMANT;
    this.pos = level.toWorld(spawnCell.x, spawnCell.z);
    this.pos.y = 0;
    this.target = null;
    this.stepCell = null;
    this.stateT = 0;
    this.repathT = 0;
    this.tickT = 0;
    this.searchT = 0;
    this.lastHeard = null;
    this._v = new THREE.Vector3();
    this._facing = new THREE.Quaternion();
    this._wanderNext = 0;
    this.lungeT = -1;          // >=0 while the jump-scare is playing
    this._geo = null;
    this._tex = null;
    this._mat = null;
  }

  async loadModel(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`zombie.obj fetch ${res.status}`);
    const text = await res.text();
    const geo = parseOBJ(text);

    // Normalize: source model is ~7 units tall, feet at y≈0, off-center in XZ.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const size = new THREE.Vector3(); bb.getSize(size);
    const center = new THREE.Vector3(); bb.getCenter(center);
    const scale = 2.58 / size.y;                 // match old creature height (~2.6m)
    geo.translate(-center.x, -bb.min.y, -center.z);   // feet to origin, centered
    geo.scale(scale, scale, scale);
    geo.rotateY(Math.PI);                        // face travel direction like old rig
    geo.computeBoundingSphere();

    paintZombieVertices(geo);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,                 // baked rot colors, no UV unwrap needed
      roughness: 0.92, metalness: 0.0,
      emissive: new THREE.Color(0x1a0505),   // faint inner glow so it never fully vanishes
      emissiveIntensity: 0.35,
    });
    this._geo = geo; this._mat = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'torso';
    mesh.castShadow = true;
    const g = new THREE.Group();
    g.add(mesh);
    this.body = mesh;                     // rig root for animation
    this.mesh = g;                        // group handle (build/scene contract)
    return g;
  }

  build(scene) {
    // Model must be loaded first (loadModel). If not, fail loudly — silent missing
    // monster is exactly the bug class CLAUDE.md warns about.
    if (!this.mesh) throw new Error('Listener.build called before loadModel resolved');
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
    return this.mesh;
  }

  hear(worldPos, intensity) {
    if (this.lungeT >= 0) return true;           // committed to the scare
    const d = this.pos.distanceTo(worldPos);
    const heard = intensity * (1 - Math.min(d / (HEAR_RANGE * intensity + 0.001), 1));
    if (heard <= 0.055) return false;
    this.lastHeard = worldPos.clone();
    this.target = this.level.toGrid(worldPos);
    this.stepCell = null;
    if (heard > 0.34 || this.state === STATE.HUNT) {
      if (this.state !== STATE.HUNT) this.onCall && this.onCall();
      this.state = STATE.HUNT;
      this.stateT = 0;
    } else if (this.state !== STATE.HUNT) {
      this.state = STATE.ALERT;
      this.stateT = 0;
    }
    return true;
  }

  proximity(playerPos) {
    return Math.max(0, 1 - this.pos.distanceTo(playerPos) / 22);
  }

  _alertness() {
    return this.state === STATE.HUNT ? 1 :
      this.state === STATE.ALERT ? 0.55 :
      this.state === STATE.SEARCH ? 0.4 : 0.1;
  }

  _pose(dt, moving) {
    // Full-body procedural rig on this.body: shamble walk, head loll, weight
    // shift, hunt twitch, and a wind-up + pounce during the lunge.
    if (!this.body) return;
    const alertness = this._alertness();
    this._poseT = (this._poseT || 0) + dt;
    const t = this._poseT;

    const gait = moving ? Math.sin(t * (3.4 + alertness * 2.6)) : 0;
    const gait2 = moving ? Math.sin(t * (3.4 + alertness * 2.6) + Math.PI / 2) : 0;
    const breathe = Math.sin(t * 1.6) * 0.02;

    if (this.lungeT >= 0) {
      // POUNCE: brief recoil wind-up, then a forward-flung leap off the ground.
      const p = Math.min(1, this.lungeT / LUNGE_TIME);
      const spring = p < 0.22 ? -(1 - p / 0.22) * 0.24 : 0;
      this.body.rotation.x = 0.55 * p + spring;
      this.body.rotation.z = Math.sin(t * 30) * 0.05;
      this.body.position.y = Math.sin(Math.min(1, p) * Math.PI) * 0.38;
      return;
    }

    // Shamble: hunched spine, swaying roll, step bounce, head loll
    this.body.rotation.x = 0.14 + alertness * 0.10 + breathe + gait2 * 0.03;
    this.body.rotation.z = gait * 0.075;
    this.body.position.y = Math.abs(gait) * 0.05;
    this.skullLoll = Math.sin(t * 1.7) * 0.16 + alertness * 0.12;
    this.body.rotation.y = Math.sin(t * 0.9) * 0.08;
    this.armSwing = gait;

    // Hunt twitch — irregular, insect-like jerk plus a click so you hear it move
    if (this.state === STATE.HUNT && Math.random() < 0.02) {
      this.body.rotation.z += (Math.random() - 0.5) * 0.18;
      this._twitchAudio?.();
    }
  }

  update(dt, playerPos, audio, hooks = {}) {
    this._twitchAudio = () => audio.tick?.(0.5);
    // ---- jump-scare sequence ----
    if (this.lungeT >= 0) {
      this.lungeT += dt;
      this._v.subVectors(playerPos, this.pos);
      this._v.y = 0;
      this._v.normalize();
      this.pos.addScaledVector(this._v, LUNGE_SPEED * dt);
      this.mesh.position.copy(this.pos);
      // face the player hard during the lunge
      this._facing.setFromAxisAngle(
        THREE.Object3D.DEFAULT_UP, Math.atan2(this._v.x, this._v.z));
      this.mesh.quaternion.copy(this._facing);
      hooks.onScareProgress?.(Math.min(1, this.lungeT / LUNGE_TIME));
      return this.pos.distanceTo(playerPos) < KILL_DIST * 1.6;
    }

    this.stateT += dt;
    this.repathT -= dt;
    this.tickT -= dt;

    const alertness = this._alertness();

    if (this.tickT <= 0) {
      this.tickT = 1.9 - alertness * 1.35 + Math.random() * 0.5;
      const d = this.pos.distanceTo(playerPos);
      if (d < 40) audio.tick(alertness * (1 - d / 40));
    }

    // ---- state transitions ----
    if (this.state === STATE.HUNT) {
      this.target = this.level.toGrid(this.lastHeard || playerPos);
      if (this.stateT > 7.5) {
        this.state = STATE.SEARCH; this.stateT = 0; this.searchT = 0;
      }
    } else if (this.state === STATE.ALERT) {
      if (this.target && this._atCell(this.target)) {
        this.state = STATE.SEARCH; this.stateT = 0; this.searchT = 0;
      } else if (this.stateT > 12) {
        this.state = STATE.SEARCH; this.stateT = 0; this.searchT = 0;
      }
    } else if (this.state === STATE.SEARCH) {
      this.searchT -= dt;
      if (this.searchT <= 0) {
        this.searchT = 1.6 + Math.random();
        const base = this.lastHeard ? this.level.toGrid(this.lastHeard) : this._randomOpen();
        this.target = this._nearOpen(base, 4);
      }
      if (this.stateT > 16) { this.state = STATE.DORMANT; this.stateT = 0; this.target = null; }
    } else {
      this._wanderNext -= dt;
      if (!this.target || this._atCell(this.target) || this._wanderNext <= 0) {
        this.target = this._randomOpen();
        this._wanderNext = 6 + Math.random() * 5;
      }
    }

    // ---- movement ----
    if (this.target) {
      if (!this.stepCell || this.repathT <= 0 || this._atCell(this.stepCell)) {
        this.repathT = this.state === STATE.HUNT ? 0.25 : 0.6;
        const here = this.level.toGrid(this.pos);
        this.stepCell = this.level.path(here, this.target) || null;
      }
      if (this.stepCell) {
        const to = this.level.toWorld(this.stepCell.x, this.stepCell.z);
        this._v.subVectors(to, this.pos);
        this._v.y = 0;
        const len = this._v.length();
        if (len > 0.001) {
          this._v.normalize();
          const sp = SPEED[this.state];
          this.pos.addScaledVector(this._v, Math.min(sp * dt, len));
          const yaw = Math.atan2(this._v.x, this._v.z);
          this._facing.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
          this.mesh.quaternion.slerp(this._facing, Math.min(1, dt * 6));
        }
      }
    }

    this.mesh.position.copy(this.pos);
    this._pose(dt, !!this.stepCell);

    // ---- jump-scare trigger ----
    const dist = this.pos.distanceTo(playerPos);
    if (dist < LUNGE_TRIGGER && this.state === STATE.HUNT && !hooks.scareBlocked?.()) {
      this.lungeT = 0;
      audio.jumpscareStinger?.();
      hooks.onJumpscareStart?.();
      hooks.onScareProgress?.(0);
      return false;                              // kill lands next frame or two
    }

    return dist < KILL_DIST;
  }

  _atCell(c) {
    const w = this.level.toWorld(c.x, c.z);
    return this.pos.distanceTo(w) < 0.55;
  }
  _randomOpen() {
    for (let i = 0; i < 200; i++) {
      const x = 1 + Math.floor(Math.random() * (41 - 2));
      const z = 1 + Math.floor(Math.random() * (41 - 2));
      if (this.level.open(x, z)) return { x, z };
    }
    return this.level.toGrid(this.pos);
  }
  _nearOpen(c, r) {
    for (let i = 0; i < 60; i++) {
      const x = c.x + Math.floor((Math.random() - 0.5) * r * 2);
      const z = c.z + Math.floor((Math.random() - 0.5) * r * 2);
      if (this.level.open(x, z)) return { x, z };
    }
    return c;
  }
  dispose() {
    this._geo?.dispose();
    this._mat?.dispose();
    this.mesh?.traverse((o) => o.geometry && o.geometry.dispose());
  }
}
