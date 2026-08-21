// listener.js — the antagonist. Blind; navigates by heard noise pings.
import * as THREE from 'three';

export const STATE = { DORMANT: 'DORMANT', ALERT: 'ALERT', HUNT: 'HUNT', SEARCH: 'SEARCH' };

const SPEED = { DORMANT: 1.25, ALERT: 2.15, HUNT: 3.55, SEARCH: 1.7 };
const HEAR_RANGE = 46;    // metres at intensity 1.0
const KILL_DIST = 1.15;

export class Listener {
  constructor(level, spawnCell) {
    this.level = level;
    this.state = STATE.DORMANT;
    this.pos = level.toWorld(spawnCell.x, spawnCell.z);
    this.pos.y = 0;
    this.target = null;          // grid cell of interest
    this.stepCell = null;
    this.stateT = 0;
    this.repathT = 0;
    this.tickT = 0;
    this.searchT = 0;
    this.lastHeard = null;
    this._v = new THREE.Vector3();
    this._facing = new THREE.Quaternion();
    this._wanderNext = 0;
  }

  build(scene) {
    // Pale, elongated, mostly ear. Built from primitives — no external assets.
    const g = new THREE.Group();
    // Albedo tuned against the flashlight: pale-looking but ~0.35 reflectance, or it
    // blows out to a white blob at close range and the silhouette (the thing that
    // makes it read as a creature) is lost. No emissive — the flashlight is the only
    // thing that should ever reveal it.
    // Albedo tuned against the flashlight: pale-looking but ~0.30 reflectance, or it
    // blows out to a white blob at close range and the silhouette (the thing that
    // makes it read as a creature) is lost. No emissive — the flashlight is the only
    // thing that should ever reveal it. Retune these whenever FLASHLIGHT_ON changes;
    // tests/probe-monster.mjs prints per-part peak luma.
    const skin = new THREE.MeshStandardMaterial({
      color: 0x585044, roughness: 0.80, metalness: 0.02,
    });
    // Limbs a stop darker so they separate from the trunk instead of merging into one
    // mass. Not near-black — that erased the legs entirely.
    const limbMat = new THREE.MeshStandardMaterial({
      color: 0x3e392f, roughness: 0.85, metalness: 0.02,
    });
    // The frills are membranes: an open cone needs DoubleSide or the inner face culls
    // away and the ear reads as a flat cardboard cutout.
    const frillMat = new THREE.MeshStandardMaterial({
      color: 0x5c5145, roughness: 0.72, metalness: 0.02, side: THREE.DoubleSide,
    });
    // The maw is a hole, so it must not catch the flashlight — near-black and rough.
    const mawMat = new THREE.MeshStandardMaterial({
      color: 0x0c0908, roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
    });
    this.mats = [skin, limbMat, frillMat, mawMat];

    // Silhouette is the whole read — it is seen for a second or two at the edge of a
    // cone, so proportion does the work. ~2.6m, starved thin, no shoulders to speak
    // of, and a skull that is mostly ear. Landmarks: knee 0.78, hip 1.28, chest 1.85,
    // shoulder 2.02, jaw 2.20, crown 2.58.
    //
    // Everything hangs off named pivots rather than being positioned absolutely: the
    // pose code rotates joints, and a joint has to be at the joint or the limb detaches
    // from the body as it swings.

    // Trunk — one lathed profile rather than stacked capsules. Three capsules read as
    // a stack of eggs because each one's silhouette closes off before the next begins;
    // a lathe gives a continuous starved taper from hip to shoulder in a single mesh.
    // Profile is (radius, height) from the hip up, closed at both ends so it stays a
    // solid and needs no DoubleSide.
    const trunkProfile = [
      [0.000, -0.06], [0.062, -0.04], [0.130, 0.00],   // hip
      [0.145, 0.10],
      [0.112, 0.24], [0.102, 0.36],                    // starved waist
      [0.152, 0.50],
      [0.196, 0.66],                                   // widest at the ribcage
      [0.174, 0.78],
      [0.112, 0.88], [0.048, 0.93], [0.000, 0.95],     // shoulder girdle
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const trunkGeo = new THREE.LatheGeometry(trunkProfile, 14);
    const trunk = new THREE.Mesh(trunkGeo, skin);
    trunk.name = 'torso';
    trunk.position.set(0, 1.16, 0.01);
    trunk.rotation.x = 0.14;              // pitched forward — it walks stooped
    trunk.scale.set(1, 1, 0.74);          // flattened front-to-back: starved, not tubby
    trunk.castShadow = true;
    g.add(trunk);
    this.trunkGeo = trunkGeo;

    // Ribs — three shallow bands that catch the flashlight edge-on, so the trunk reads
    // as a starved ribcage instead of a smooth pod.
    const ribGeo = new THREE.TorusGeometry(0.15, 0.012, 4, 12);
    this.ribGeo = ribGeo;
    for (let i = 0; i < 3; i++) {
      const rib = new THREE.Mesh(ribGeo, skin);
      rib.name = 'rib' + i;
      rib.position.set(0, 1.72 + i * 0.115, 0.02);
      rib.rotation.set(Math.PI / 2 + 0.14, 0, 0);
      rib.scale.set(1 - i * 0.06, 1 - i * 0.06, 0.74);
      rib.castShadow = false;
      g.add(rib);
    }

    // Neck — long, craned forward, so the skull leads the body.
    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.20, 3, 6), skin);
    neck.name = 'neck';
    neck.position.set(0, 2.08, 0.05);
    neck.rotation.x = 0.38;                // craned out over the chest
    neck.castShadow = true;
    g.add(neck);

    // Skull rides on a pivot at the base of the neck so the head can cock toward a
    // sound — the single most legible "it heard you" cue at distance.
    const skull = new THREE.Object3D();
    skull.position.set(0, 2.20, 0.13);
    g.add(skull);
    this.skull = skull;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.175, 12, 10), skin);
    head.name = 'head';
    head.position.y = 0.14;
    head.scale.set(0.84, 1.40, 1.20);     // long muzzle, narrow across — no face
    head.castShadow = true;
    skull.add(head);

    // The maw. No eyes anywhere on this thing, so the mouth is the only feature: a
    // tall vertical gash down the front of the muzzle, open-ended and near-black so
    // it reads as a hole. It must stay obviously elongated and sit low on the muzzle —
    // a small centred circle reads as a single eye, which inverts the whole premise.
    // Gape is driven on local Z, which is the vertical axis on the face once the cone
    // is rotated; scaling local Y would just push the opening further forward.
    const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.22, 6, 1, true), mawMat);
    jaw.name = 'jaw';
    jaw.position.set(0, 0.035, 0.15);
    jaw.rotation.x = Math.PI / 2 + 0.20;   // opening pitched forward and down
    jaw.castShadow = false;
    skull.add(jaw);
    this.jaw = jaw;

    // The frills — the defining feature. Ear membranes hinged at the temple, swept back
    // along the skull when dormant and thrown wide when it is homing in. Parented to
    // the skull so they track head-cock for free. Kept modest in span: at full fan they
    // must still not out-mass the body, or the silhouette reads as a bow tie.
    this.frills = [];
    const frillGeo = new THREE.ConeGeometry(0.155, 0.50, 5, 1, true);
    this.frillGeo = frillGeo;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Object3D();
      pivot.position.set(side * 0.085, 0.14, -0.055);
      const f = new THREE.Mesh(frillGeo, frillMat);
      f.name = side < 0 ? 'frillL' : 'frillR';
      f.position.y = 0.23;                // base at the pivot, tip sweeps outward
      f.scale.set(1, 1, 0.42);            // a membrane, not a horn
      f.castShadow = true;
      pivot.add(f);
      skull.add(pivot);
      this.frills.push({ mesh: pivot, side });
    }

    // Limbs — arms far too long, hanging past the knee. Legs are digitigrade: a real
    // knee joint, so the gait breaks at the middle instead of swinging like a pendulum.
    this.limbs = [];
    const upperArmGeo = new THREE.CapsuleGeometry(0.042, 0.54, 3, 6);
    const foreArmGeo = new THREE.CapsuleGeometry(0.034, 0.58, 3, 6);
    const handGeo = new THREE.CapsuleGeometry(0.020, 0.30, 3, 5);
    const thighGeo = new THREE.CapsuleGeometry(0.068, 0.42, 3, 6);
    const shinGeo = new THREE.CapsuleGeometry(0.048, 0.46, 3, 6);
    const footGeo = new THREE.BoxGeometry(0.10, 0.05, 0.26);
    this.limbGeos = [upperArmGeo, foreArmGeo, handGeo, thighGeo, shinGeo, footGeo];

    for (const side of [-1, 1]) {
      // Every mesh is named: tests/probe-monster.mjs prints one row per named mesh, and
      // an unnamed part shows up as '?' in the table exactly when you need to know which
      // part is unlit.
      const sfx = side < 0 ? 'L' : 'R';
      // --- arm: shoulder -> elbow -> fingers ---
      const shoulder = new THREE.Object3D();
      shoulder.position.set(side * 0.175, 2.00, 0.02);
      shoulder.rotation.z = side * 0.10;
      g.add(shoulder);

      const upperArm = new THREE.Mesh(upperArmGeo, limbMat);
      upperArm.name = 'arm' + sfx;
      upperArm.position.y = -0.31;
      upperArm.castShadow = true;
      shoulder.add(upperArm);

      const elbow = new THREE.Object3D();
      elbow.position.y = -0.62;
      elbow.rotation.x = 0.22;             // slack, hanging slightly back
      shoulder.add(elbow);

      const foreArm = new THREE.Mesh(foreArmGeo, limbMat);
      foreArm.name = 'foreArm' + sfx;
      foreArm.position.y = -0.33;
      foreArm.castShadow = true;
      elbow.add(foreArm);

      // Fingers hang past the knee — the detail that makes the proportions wrong.
      const hand = new THREE.Mesh(handGeo, limbMat);
      hand.name = 'hand' + sfx;
      hand.position.set(0, -0.82, 0.01);
      hand.rotation.x = 0.12;
      hand.castShadow = true;
      elbow.add(hand);

      this.limbs.push({ mesh: shoulder, side, kind: 'arm', restX: 0, restZ: side * 0.10 });

      // --- leg: hip -> knee -> foot ---
      const hip = new THREE.Object3D();
      hip.position.set(side * 0.105, 1.20, 0);
      g.add(hip);

      const thigh = new THREE.Mesh(thighGeo, limbMat);
      thigh.name = 'leg' + sfx;
      thigh.position.y = -0.25;
      thigh.castShadow = true;
      hip.add(thigh);

      const knee = new THREE.Object3D();
      knee.position.y = -0.50;
      knee.rotation.x = -0.30;             // digitigrade: knee kicks backward
      hip.add(knee);
      this.limbs.push({ mesh: knee, side, kind: 'knee', restX: -0.30, restZ: 0 });

      const shin = new THREE.Mesh(shinGeo, limbMat);
      shin.name = 'shin' + sfx;
      shin.position.y = -0.27;
      shin.castShadow = true;
      knee.add(shin);

      const foot = new THREE.Mesh(footGeo, limbMat);
      foot.name = 'foot' + sfx;
      foot.position.set(0, -0.52, 0.07);
      foot.rotation.x = 0.30;              // compensates the knee kick — sole flat
      foot.castShadow = true;
      knee.add(foot);

      this.limbs.push({ mesh: hip, side, kind: 'leg', restX: 0.16, restZ: 0 });
      hip.rotation.x = 0.16;
    }

    g.position.copy(this.pos);
    scene.add(g);
    this.mesh = g;
    return g;
  }

  // A noise ping. Attenuates with distance; loud noise close by escalates state.
  hear(worldPos, intensity) {
    const d = this.pos.distanceTo(worldPos);
    const heard = intensity * (1 - Math.min(d / (HEAR_RANGE * intensity + 0.001), 1));
    if (heard <= 0.055) return false;

    this.lastHeard = worldPos.clone();
    const cell = this.level.toGrid(worldPos);

    if (heard > 0.34 || this.state === STATE.HUNT) {
      if (this.state !== STATE.HUNT) this.onCall && this.onCall();
      this.state = STATE.HUNT;
      this.stateT = 0;
    } else if (this.state !== STATE.HUNT) {
      this.state = STATE.ALERT;
      this.stateT = 0;
    }
    this.target = cell;
    this.stepCell = null;
    return true;
  }

  proximity(playerPos) {
    const d = this.pos.distanceTo(playerPos);
    return Math.max(0, 1 - d / 22);
  }

  _alertness() {
    return this.state === STATE.HUNT ? 1 :
      this.state === STATE.ALERT ? 0.55 :
      this.state === STATE.SEARCH ? 0.4 : 0.1;
  }

  // Cosmetic pose — frills, head-cock and gait. Runs even when frozen so inspection
  // shots show the correct silhouette for the current state.
  _pose(dt, moving) {
    const alertness = this._alertness();
    this._poseT = (this._poseT || 0) + dt;
    const t = this._poseT;

    // Frills furl when dormant and fan wide open when alert (GDD state table).
    // rotation.z ~0.08pi is near-vertical (furled against the skull); ~0.34pi is
    // splayed out sideways. They also sweep forward as it homes in.
    this.frills.forEach((f, i) => {
      const open = 0.08 + alertness * 0.26;
      const sway = Math.sin(t * (2.2 + i * 0.7)) * 0.10 * (0.3 + alertness);
      f.mesh.rotation.z = f.side * (Math.PI * open + sway);
      f.mesh.rotation.x = -0.34 + alertness * 0.42;   // swept back -> pricked forward
    });

    // Head cock — a slow searching sweep when it does not know where you are, and a
    // dead-locked stare when it does. This is the clearest "it heard you" tell.
    const sweep = (1 - alertness) * 0.55;
    this.skull.rotation.y = Math.sin(t * 0.75) * sweep;
    this.skull.rotation.z = Math.sin(t * 0.52) * sweep * 0.45;
    this.skull.rotation.x = -0.22 + alertness * 0.30;  // lifts its head as it closes

    // The maw gapes wider the more alert it is, and shudders while hunting. X stays
    // pinned narrow so it reads as a gash; Z is the vertical axis on the face.
    const gape = 0.75 + alertness * 1.05 + (alertness > 0.9 ? Math.sin(t * 11) * 0.12 : 0);
    this.jaw.scale.set(0.40, 1, gape);

    const gait = moving ? t * (4 + alertness * 5) : 0;
    this.limbs.forEach((l, i) => {
      const ph = gait + (l.side < 0 ? 0 : Math.PI);
      if (!moving) {
        // Idle: a slight breathing drift, not a frozen T-pose.
        const idle = Math.sin(t * 1.1 + i) * 0.03;
        l.mesh.rotation.x = l.restX + idle;
      } else if (l.kind === 'knee') {
        // The knee only ever flexes one way — clamp so it never bends backwards.
        l.mesh.rotation.x = l.restX - Math.max(0, Math.sin(ph)) * 0.65;
      } else if (l.kind === 'leg') {
        l.mesh.rotation.x = l.restX + Math.sin(ph) * 0.55;
      } else {
        l.mesh.rotation.x = l.restX + Math.sin(ph + Math.PI) * 0.34;
      }
      l.mesh.rotation.z = l.restZ;
    });

    // taller, more upright when hunting
    this.mesh.scale.y = 1 + (this.state === STATE.HUNT ? 0.06 : 0);
  }

  update(dt, playerPos, audio) {
    if (this._frozen) {
      this.mesh.position.copy(this.pos);
      this._pose(dt, false);
      return false;
    }
    this.stateT += dt;
    this.repathT -= dt;
    this.tickT -= dt;

    const alertness =
      this.state === STATE.HUNT ? 1 :
      this.state === STATE.ALERT ? 0.55 :
      this.state === STATE.SEARCH ? 0.4 : 0.1;

    // idle clicking — the player's only cue to where it is
    if (this.tickT <= 0) {
      this.tickT = 1.9 - alertness * 1.35 + Math.random() * 0.5;
      const d = this.pos.distanceTo(playerPos);
      if (d < 40) audio.tick(alertness * (1 - d / 40));
    }

    // ---- state transitions ----
    if (this.state === STATE.HUNT) {
      // Hunt decays only if it has had no fresh ping for a while.
      this.target = this.level.toGrid(this.lastHeard || playerPos);
      if (this.stateT > 7.5) {
        this.state = STATE.SEARCH;
        this.stateT = 0;
        this.searchT = 0;
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
        // circle the last known position
        this.searchT = 1.6 + Math.random();
        const base = this.lastHeard ? this.level.toGrid(this.lastHeard) : this._randomOpen();
        this.target = this._nearOpen(base, 4);
      }
      if (this.stateT > 16) { this.state = STATE.DORMANT; this.stateT = 0; this.target = null; }
    } else {
      // DORMANT patrol
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

          // face travel direction via quaternion — never Euler accumulation
          const yaw = Math.atan2(this._v.x, this._v.z);
          this._facing.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
          this.mesh.quaternion.slerp(this._facing, Math.min(1, dt * 6));
        }
      }
    }

    this.mesh.position.copy(this.pos);
    this._pose(dt, !!this.stepCell);

    return this.pos.distanceTo(playerPos) < KILL_DIST;
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
    this.frillGeo?.dispose();
    (this.limbGeos || []).forEach((geo) => geo.dispose());
    this.mats?.forEach((m) => m.dispose());
    this.mesh?.traverse((o) => o.geometry && o.geometry.dispose());
  }
}
