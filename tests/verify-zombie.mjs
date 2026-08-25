// Logic tests for the zombie-v2 monster: OBJ parser, normalization, jump-scare state.
// Runs in Node with real three (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

// stub what zombie.js touches at import time (document/canvas only used in texture fn)
globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext() { return new Proxy({}, { get: () => () => undefined }); },
    };
  },
};

const { Listener, STATE } = await import('../src/zombie.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Re-implement the parser contract by loading through loadModel with a fetch stub —
// verifies normalization numbers on the REAL shipped model file.
test('zombie model loads and normalizes to ~2.58m', async () => {
  const objText = fs.readFileSync(path.join(ROOT, 'public/models/zombie.obj'), 'utf8');
  globalThis.fetch = async () => ({ ok: true, text: async () => objText });

  const level = {
    toWorld: (x, z) => ({ x: x * 1, y: 0, z: z * 1 }),
    toGrid: () => ({ x: 0, z: 0 }),
    open: () => true, path: () => null, roomCenters: [], spawn: { x: 0, z: 0 },
  };
  const L = new Listener(level, { x: 0, z: 0 });
  const group = await L.loadModel('stub.obj');
  assert.ok(group, 'group built');
  const mesh = group.children[0];
  mesh.geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  mesh.geometry.boundingBox.getSize(size);
  // normalized height target is 2.58
  assert.ok(Math.abs(size.y - 2.58) < 0.01, `height ${size.y.toFixed(3)} ≈ 2.58`);
  // feet at origin
  mesh.geometry.computeBoundingBox();
  assert.ok(Math.abs(mesh.geometry.boundingBox.min.y) < 0.001, 'feet at y=0');
  L.dispose();
});

test('jump scare triggers near a HUNTING zombie and lunge closes distance', async () => {
  const calls = [];
  const audio = { tick() {}, jumpscareStinger() { calls.push('stinger'); } };
  const level = {
    toWorld: (x, z) => new THREE.Vector3(x, 0, z),
    toGrid: (p) => ({ x: Math.round(p.x), z: Math.round(p.z) }),
    open: () => true,
    path: (from) => ({ x: from.x + Math.sign(1 - from.x), z: from.z }),
    roomCenters: [], spawn: { x: 0, z: 0 },
  };
  const L = new Listener(level, { x: 0, z: 0 });
  // fake minimal rig — update() needs this.mesh only for position copies
  L.mesh = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), traverse() {} };
  L.pos.set(0, 0, 0);
  L.state = STATE.HUNT;

  const player = new THREE.Vector3(0, 0, 1.8);   // inside LUNGE_TRIGGER (2.1)
  let scareStarted = false;
  let progress = 0;
  const hooks = {
    scareBlocked: () => false,
    onJumpscareStart: () => { scareStarted = true; },
    onScareProgress: (p) => { progress = p; },
  };

  let caught = L.update(0.05, player, audio, hooks);
  assert.ok(scareStarted, 'jumpscare start hook fired');
  assert.ok(calls.includes('stinger'), 'stinger sound played');
  assert.equal(caught, false, 'first frame of lunge not yet lethal');

  // second frame reports lunge progress
  L.update(0.05, player, audio, hooks);
  assert.ok(progress > 0, 'progress reported');

  // simulate forward — lunge speed 9.5 m/s over ~0.42s must close 1.8m gap quickly
  for (let i = 0; i < 20 && !caught; i++) caught = L.update(0.05, player, audio, hooks);
  assert.ok(caught, 'lunge catches the player');
});

test('no jump scare when not hunting or when blocked', () => {
  const audio = { tick() {}, jumpscareStinger() { throw new Error('must not fire'); } };
  const level = {
    toWorld: (x, z) => new THREE.Vector3(x, 0, z),
    toGrid: () => ({ x: 0, z: 0 }),
    open: () => true, path: () => null, roomCenters: [], spawn: { x: 0, z: 0 },
  };
  const L = new Listener(level, { x: 0, z: 0 });
  L.mesh = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), traverse() {} };
  L.pos.set(0, 0, 0);
  L.state = STATE.DORMANT;
  let caught = L.update(0.05, new THREE.Vector3(0, 0, 1.5), audio, { scareBlocked: () => false });
  assert.equal(L.lungeT, -1, 'dormant zombie never lunges');

  L.state = STATE.HUNT;
  caught = L.update(0.05, new THREE.Vector3(0, 0, 1.5), audio, { scareBlocked: () => true });
  assert.equal(L.lungeT, -1, 'blocked scare does not engage');
});
