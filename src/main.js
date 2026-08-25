// main.js — Ready-Run. Camera, player, noise model, objectives, post, loop.
import * as THREE from 'three';
import { Level, CELL } from './level.js';
import { Listener, STATE } from './zombie.js';
import { Audio } from './audio.js';

const NOISE = { still: 0, crouch: 0.15, walk: 0.45, sprint: 1.0 };
const EYE_STAND = 1.62, EYE_CROUCH = 0.95;
const ALIGN_TIME = 7.0;

const DEATH_NOTES = [
  'It heard the relay. It was always going to hear the relay.',
  'You ran. Running is the loudest thing a person can do.',
  'The flashlight clicked. That was all it needed.',
  'It circled back. It does not forget where sound came from.',
];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  loading: $('loading'), start: $('start'), death: $('death'), win: $('win'),
  deathNote: $('death-note'), hud: $('hud'), noiseFill: $('noise-fill'),
  objList: $('obj-list'), prompt: $('prompt'), promptText: $('prompt-text'),
  progressFill: $('progress-fill'), subtitle: $('subtitle'),
};

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const coarse = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.25 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
const BASE_EXPOSURE = 1.35;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
// Density 0.055 not 0.085: at 0.085 fog swallowed half the image by 10m, so corridors
// went black just past the flashlight's pool and the maze became unreadable.
scene.fog = new THREE.FogExp2(0x05050a, 0.055);

const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.055, 90);

// yaw on holder, pitch on camera — never stacked into one quaternion (CLAUDE.md)
const yawObj = new THREE.Object3D();
const pitchObj = new THREE.Object3D();
yawObj.add(pitchObj);
pitchObj.add(camera);
scene.add(yawObj);

// ---------- lights (budget: 1 shadow-caster) ----------
// NOTE: three r155+ is physically-correct only — intensity is candela and decay is
// real inverse-square-ish. Legacy-model values (intensity ~3) render as black here.
// Balance rule: the flashlight must dominate the frame. Ambient and fill exist only so
// full-dark stays navigable, not so the corridor is legible without the light — if
// ambient carries the image, pressing F changes nothing on screen and the whole
// noise-versus-visibility tradeoff stops mattering.
const FLASHLIGHT_ON = 92;
scene.add(new THREE.AmbientLight(0x2a3a52, 0.14));
// decay 1.0 rather than physical 2.0: a real torch is collimated, so in-beam falloff
// is far gentler than a bare bulb's. At decay 1.15 the useful throw was under 4m and
// corridors read as black even with the light on.
const flashlight = new THREE.SpotLight(0xfff0d8, 0, 32, Math.PI / 6.2, 0.32, 1.0);
// GOTCHA: SpotLight's constructor does `position.copy(Object3D.DEFAULT_UP)`, so it
// ships at (0,1,0). Parented to the camera that put the emitter 1m above the eye
// aiming 45deg at the floor — everything above chest height fell outside the cone.
flashlight.position.set(0, 0, 0);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.2;
flashlight.shadow.camera.far = 32;      // matches the throw — depth precision
flashlight.shadow.bias = -0.0022;
camera.add(flashlight);
camera.add(flashlight.target);
flashlight.target.position.set(0, 0, -1);
// faint always-on fill so full-dark is navigable but useless for detail
const fill = new THREE.PointLight(0x5566aa, 1.6, 7, 1.6);
camera.add(fill);

// ---------- post: ONE composited pass (CLAUDE.md) ----------
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType,
});
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postUniforms = {
  tDiffuse: { value: rt.texture },
  uTime: { value: 0 },
  uGrain: { value: 0.085 },
  uVignette: { value: 1.05 },
  uAberration: { value: 0.0016 },
  uDesat: { value: 0.55 },
  uPulse: { value: 0.0 },
};
const postMat = new THREE.ShaderMaterial({
  uniforms: postUniforms,
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uAberration, uDesat, uPulse;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      // chromatic aberration scales toward the edges, and with threat pulse
      float ab = uAberration * (1.0 + uPulse * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;
      // desaturate
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l), uDesat);
      // sodium-cold split tone
      col *= mix(vec3(1.0), vec3(1.06, 0.96, 0.88), 0.5);
      // vignette, tightening with threat
      float v = smoothstep(0.92, 0.22, length(c) * (uVignette + uPulse * 0.55));
      col *= v;
      // grain
      float g = hash(uv * 700.0 + uTime * 40.0) - 0.5;
      col += g * uGrain;
      // threat desaturation-to-red at very close range; uPulse spikes to ~1.9 during a jump scare
      float scare = max(uPulse - 1.0, 0.0);                 // 0 normal, ~0.9 at pounce
      col = mix(col, vec3(l * 1.15, l * 0.42, l * 0.42), clamp(uPulse, 0.0, 1.0) * 0.35);
      // full-frame blood wash at scare peak — this is the frame you remember
      col = mix(col, vec3(0.55, 0.02, 0.02), clamp(scare, 0.0, 1.0) * 0.65);
      col += vec3(0.25, 0.03, 0.03) * pow(scare, 3.0);       // hot core blowout
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

// ---------- reusable temporaries (never allocate in the loop) ----------
const TMP = {
  fwd: new THREE.Vector3(), right: new THREE.Vector3(), move: new THREE.Vector3(),
  next: new THREE.Vector3(), pos: new THREE.Vector3(), q: new THREE.Quaternion(),
};

// ---------- state ----------
const audio = new Audio();
let level, listener, relayMeshes = [], liftMesh, relayPool;
let game = null;
const keys = Object.create(null);
let running = false, pointerLocked = false;

// Touch overlay — additive. Keyboard/mouse keep working. Visible only in touch-mode.
const touch = {
  active: false,
  x: 0, y: 0,           // analog stick, -1..1
  lookId: null,
  lookX: 0, lookY: 0,
  sprint: false,
  crouch: false,
  holdE: false,
};

function makeGame() {
  return {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    yaw: 0, pitch: 0, crouch: false,
    eye: EYE_STAND, bob: 0,
    flashlight: true,
    noise: 0, smoothNoise: 0,
    relays: [false, false, false],
    aligning: -1, alignT: 0,
    liftLive: false, over: false,
    t: 0, pingT: 0,
    scare: 0,
  };
}

// ---------- objectives HUD ----------
function renderObjectives() {
  const names = ['ALPHA', 'BETA', 'GAMMA'];
  let h = '';
  for (let i = 0; i < 3; i++) {
    const cls = game.relays[i] ? 'o done' : (game.aligning === i ? 'o live' : 'o');
    h += `<div class="${cls}">RELAY ${names[i]}</div>`;
  }
  const all = game.relays.every(Boolean);
  h += `<div class="${all ? 'o live' : 'o'}" style="${all ? '' : 'opacity:.18'}">REACH THE LIFT</div>`;
  el.objList.innerHTML = h;
}

let subTimer = 0;
function say(text, dur = 4.5) {
  el.subtitle.textContent = text;
  el.subtitle.classList.add('on');
  subTimer = dur;
}

// ---------- build / reset ----------
async function build() {
  // tear down previous run
  if (level) {
    listener?.dispose();
    level.dispose();
    relayPool?.geo.dispose();
    relayPool?.mat.dispose();
    relayPool?.doneMat.dispose();
    while (scene.children.length) {
      const c = scene.children[0];
      scene.remove(c);
    }
    scene.add(new THREE.AmbientLight(0x223044, 0.11));
    scene.add(yawObj);
  }

  level = new Level(1985 + Math.floor(Math.random() * 9999));
  level.build(scene);

  game = makeGame();
  const sp = level.toWorld(level.spawn.x, level.spawn.z);
  game.pos.set(sp.x, 0, sp.z);

  // relays
  const geo = new THREE.CylinderGeometry(0.30, 0.42, 1.5, 8);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3a3228, roughness: 0.55, metalness: 0.6,
    emissive: 0xff8a3c, emissiveIntensity: 0.55,
  });
  const doneMat = new THREE.MeshStandardMaterial({
    color: 0x2a3a30, roughness: 0.6, metalness: 0.5,
    emissive: 0x44ff99, emissiveIntensity: 0.5,
  });
  relayPool = { geo, mat, doneMat };
  relayMeshes = level.relays.map((c) => {
    const m = new THREE.Mesh(geo, mat);
    const w = level.toWorld(c.x, c.z);
    m.position.set(w.x, 0.75, w.z);
    m.castShadow = true;
    scene.add(m);
    return m;
  });

  // lift
  const liftGeo = new THREE.BoxGeometry(CELL * 0.9, 2.6, CELL * 0.9);
  const liftMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a20, roughness: 0.5, metalness: 0.7,
    emissive: 0x000000, emissiveIntensity: 1,
  });
  liftMesh = new THREE.Mesh(liftGeo, liftMat);
  const lw = level.toWorld(level.lift.x, level.lift.z);
  liftMesh.position.set(lw.x, 1.3, lw.z);
  scene.add(liftMesh);

  // Listener (zombie) spawns far from the player. Model load is async but the
  // build() call below guards: it throws if the mesh isn't ready, so await it.
  let far = level.roomCenters[0], bd = -1;
  for (const c of level.roomCenters) {
    const d = Math.hypot(c.x - level.spawn.x, c.z - level.spawn.z);
    if (d > bd) { bd = d; far = c; }
  }
  listener = new Listener(level, far);
  if (!listener.mesh) {
    try {
      await listener.loadModel('./public/models/zombie.obj');
    } catch (err) {
      console.error('zombie model failed to load:', err);
      say('SIGNAL LOST — the deep is silent.', 6);
      throw err;
    }
  }
  listener.build(scene);
  listener.onCall = () => audio.call();

  renderObjectives();
  say('Align the three relays. They will scream. — READY. RUN.', 6.5);
}

// ---------- input ----------
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyF' && running && game && !game.over) {
    game.flashlight = !game.flashlight;
    audio.click();
    emitNoise(0.6);                        // the click carries
    say(game.flashlight ? '' : '', 0.01);
  }
  if (['KeyW','KeyA','KeyS','KeyD','Space','ShiftLeft','ControlLeft'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

renderer.domElement.addEventListener('click', () => {
  if (running && !pointerLocked && !touch.active) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || !game || game.over) return;
  game.yaw -= e.movementX * 0.0022;
  game.pitch -= e.movementY * 0.0022;
  const lim = Math.PI / 2 - 0.02;          // clamp per CLAUDE.md
  game.pitch = Math.max(-lim, Math.min(lim, game.pitch));
});

function enableTouchMode() {
  if (touch.active) return;
  touch.active = true;
  document.body.classList.add('touch-mode');
  document.exitPointerLock?.();
}

function syncPlayingClass() {
  document.body.classList.toggle('playing', running && game && !game.over);
}

function bindHold(el, on, off) {
  if (!el) return;
  const down = (e) => { e.preventDefault(); e.stopPropagation(); enableTouchMode(); on(); el.classList.add('on'); };
  const up = (e) => { e.preventDefault(); e.stopPropagation(); off(); el.classList.remove('on'); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', (e) => { if (e.buttons) up(e); });
}

(function setupTouch() {
  const joyZone = document.getElementById('joy-zone');
  const joyBase = document.getElementById('joy-base');
  const joyKnob = document.getElementById('joy-knob');
  const lookZone = document.getElementById('look-zone');
  if (!joyZone || !lookZone) return;

  let joyId = null, joyCx = 0, joyCy = 0, joyR = 52;

  const setKnob = (nx, ny) => {
    const px = nx * joyR, py = ny * joyR;
    if (joyKnob) joyKnob.style.transform = `translate(${px}px, ${py}px)`;
  };

  const joyFrom = (clientX, clientY) => {
    const dx = clientX - joyCx, dy = clientY - joyCy;
    const mag = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(1, mag / joyR);
    touch.x = (dx / mag) * clamped;
    touch.y = (dy / mag) * clamped;
    setKnob(touch.x, touch.y);
  };

  joyZone.addEventListener('pointerdown', (e) => {
    if (joyId !== null) return;
    e.preventDefault();
    enableTouchMode();
    joyId = e.pointerId;
    joyZone.setPointerCapture?.(e.pointerId);
    const r = (joyBase || joyZone).getBoundingClientRect();
    joyCx = r.left + r.width / 2;
    joyCy = r.top + r.height / 2;
    joyR = Math.min(r.width, r.height) * 0.42;
    joyFrom(e.clientX, e.clientY);
  });
  joyZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyId) return;
    e.preventDefault();
    joyFrom(e.clientX, e.clientY);
  });
  const joyEnd = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    touch.x = 0; touch.y = 0;
    setKnob(0, 0);
  };
  joyZone.addEventListener('pointerup', joyEnd);
  joyZone.addEventListener('pointercancel', joyEnd);

  lookZone.addEventListener('pointerdown', (e) => {
    if (touch.lookId !== null) return;
    e.preventDefault();
    enableTouchMode();
    touch.lookId = e.pointerId;
    touch.lookX = e.clientX;
    touch.lookY = e.clientY;
    lookZone.setPointerCapture?.(e.pointerId);
  });
  lookZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touch.lookId || !game || game.over) return;
    e.preventDefault();
    const dx = e.clientX - touch.lookX;
    const dy = e.clientY - touch.lookY;
    touch.lookX = e.clientX;
    touch.lookY = e.clientY;
    // Slightly hotter than mouse so a thumb swipe covers a full turn.
    game.yaw -= dx * 0.0044;
    game.pitch -= dy * 0.0044;
    const lim = Math.PI / 2 - 0.02;
    game.pitch = Math.max(-lim, Math.min(lim, game.pitch));
  });
  const lookEnd = (e) => {
    if (e.pointerId !== touch.lookId) return;
    touch.lookId = null;
  };
  lookZone.addEventListener('pointerup', lookEnd);
  lookZone.addEventListener('pointercancel', lookEnd);

  bindHold(document.getElementById('btn-sprint'), () => { touch.sprint = true; }, () => { touch.sprint = false; });
  bindHold(document.getElementById('btn-crouch'), () => { touch.crouch = true; }, () => { touch.crouch = false; });
  bindHold(document.getElementById('btn-e'), () => { touch.holdE = true; }, () => { touch.holdE = false; });

  const btnF = document.getElementById('btn-f');
  if (btnF) {
    btnF.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      enableTouchMode();
      if (!running || !game || game.over) return;
      game.flashlight = !game.flashlight;
      audio.click();
      emitNoise(0.6);
      btnF.classList.toggle('on', game.flashlight);
    });
  }

  window.addEventListener('touchstart', enableTouchMode, { passive: true, once: true });
})();

// ---------- noise ----------
function emitNoise(intensity) {
  if (!listener || !game || game.over) return;
  TMP.pos.set(game.pos.x, 0, game.pos.z);
  listener.hear(TMP.pos, intensity);
}

// ---------- screens ----------
function show(screen) {
  [el.start, el.death, el.win].forEach((s) => s.classList.add('hide'));
  if (screen) screen.classList.remove('hide');
  el.hud.classList.toggle('on', !screen);
}

async function begin() {
  audio.start();
  running = false;                 // hold the loop until the zombie model is in
  show(null);
  syncPlayingClass();
  try {
    await build();
  } catch (err) {
    console.error('build failed:', err);
    show(el.start);
    return;
  }
  game = game || makeGame();
  running = true;
  const btnF = document.getElementById('btn-f');
  if (btnF) btnF.classList.toggle('on', !!game.flashlight);
  if (!touch.active) renderer.domElement.requestPointerLock();
}

function resetTouch() {
  touch.x = 0; touch.y = 0; touch.sprint = false; touch.crouch = false; touch.holdE = false;
  touch.lookId = null;
  document.querySelectorAll('#touch-btns .tbtn').forEach((b) => {
    if (b.id !== 'btn-f') b.classList.remove('on');
  });
}

function die() {
  if (game.over) return;
  game.over = true;
  running = false;
  audio.death();
  document.exitPointerLock?.();
  resetTouch();
  syncPlayingClass();
  el.deathNote.textContent = DEATH_NOTES[Math.floor(Math.random() * DEATH_NOTES.length)];
  setTimeout(() => show(el.death), 900);
}

function winRun() {
  if (game.over) return;
  game.over = true;
  running = false;
  audio.win();
  document.exitPointerLock?.();
  resetTouch();
  syncPlayingClass();
  setTimeout(() => show(el.win), 900);
}

el.start.addEventListener('click', begin);
el.death.addEventListener('click', begin);
el.win.addEventListener('click', begin);

// ---------- loop ----------
const clock = new THREE.Clock();
let acc = 0, frames = 0, fps = 60;
const sceneStats = { calls: 0, triangles: 0, geometries: 0, textures: 0 };

function frame() {
  requestAnimationFrame(frame);
  let dt = clock.getDelta();
  dt = Math.min(dt, 0.1);                  // clamp: alt-tab must not tunnel (CLAUDE.md)

  acc += dt; frames++;
  if (acc > 1) { fps = frames / acc; acc = 0; frames = 0; }

  if (running && game && !game.over) step(dt);

  postUniforms.uTime.value += dt;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  // Capture BEFORE the post pass — renderer.info resets on every render() call,
  // so reading it after the fullscreen quad reports 1 call / 2 triangles.
  sceneStats.calls = renderer.info.render.calls;
  sceneStats.triangles = renderer.info.render.triangles;
  sceneStats.geometries = renderer.info.memory.geometries;
  sceneStats.textures = renderer.info.memory.textures;
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCam);
}

function step(dt) {
  game.t += dt;

  // --- crouch / eye height ---
  const wantCrouch = !!(keys.ControlLeft || keys.ControlRight || keys.KeyC || touch.crouch);
  game.crouch = wantCrouch;
  const targetEye = wantCrouch ? EYE_CROUCH : EYE_STAND;
  game.eye += (targetEye - game.eye) * Math.min(1, dt * 9);

  // --- movement basis from yaw only ---
  TMP.fwd.set(-Math.sin(game.yaw), 0, -Math.cos(game.yaw));
  TMP.right.set(Math.cos(game.yaw), 0, -Math.sin(game.yaw));
  TMP.move.set(0, 0, 0);
  if (keys.KeyW) TMP.move.add(TMP.fwd);
  if (keys.KeyS) TMP.move.sub(TMP.fwd);
  if (keys.KeyD) TMP.move.add(TMP.right);
  if (keys.KeyA) TMP.move.sub(TMP.right);
  // Analog stick: +y is screen-down = backward. Deadzone so a resting thumb is still.
  const stickMag = Math.hypot(touch.x, touch.y);
  if (stickMag > 0.12) {
    const nx = touch.x / stickMag, ny = touch.y / stickMag;
    const gain = Math.min(1, (stickMag - 0.12) / 0.88);
    TMP.move.addScaledVector(TMP.fwd, -ny * gain);
    TMP.move.addScaledVector(TMP.right, nx * gain);
  }

  const moving = TMP.move.lengthSq() > 0.0001;
  if (moving) TMP.move.normalize();

  const sprint = !!(keys.ShiftLeft || keys.ShiftRight || touch.sprint) && !wantCrouch;
  const speed = wantCrouch ? 1.5 : sprint ? 5.0 : 2.9;

  // --- noise model ---
  let n = NOISE.still;
  if (moving) n = wantCrouch ? NOISE.crouch : sprint ? NOISE.sprint : NOISE.walk;
  if (game.aligning >= 0) n = Math.max(n, 0.9);
  game.noise = n;
  game.smoothNoise += (n - game.smoothNoise) * Math.min(1, dt * 8);

  // periodic ping — the Listener only knows what it hears
  game.pingT -= dt;
  if (game.pingT <= 0) {
    game.pingT = 0.42;
    if (n > 0.02) emitNoise(n);
  }

  // --- collide-and-slide on axes independently ---
  if (moving) {
    TMP.next.copy(game.pos).addScaledVector(TMP.move, speed * dt);
    const tryX = TMP.pos.set(TMP.next.x, 0, game.pos.z);
    if (!level.collides(tryX)) game.pos.x = TMP.next.x;
    const tryZ = TMP.pos.set(game.pos.x, 0, TMP.next.z);
    if (!level.collides(tryZ)) game.pos.z = TMP.next.z;

    game.bob += dt * (sprint ? 13 : wantCrouch ? 5 : 8.5);
    audio.footstep(n);
  }

  // --- camera transform (quaternions; yaw parent, pitch child) ---
  const bobY = Math.sin(game.bob) * (moving ? (sprint ? 0.055 : 0.028) : 0);
  const bobX = Math.cos(game.bob * 0.5) * (moving ? (sprint ? 0.022 : 0.010) : 0);
  yawObj.position.set(game.pos.x + bobX, game.eye + bobY, game.pos.z);
  TMP.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, game.yaw);
  yawObj.quaternion.copy(TMP.q);
  TMP.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), game.pitch);
  pitchObj.quaternion.copy(TMP.q);

  flashlight.intensity += ((game.flashlight ? FLASHLIGHT_ON : 0) - flashlight.intensity)
    * Math.min(1, dt * 10);

  // --- relays ---
  let near = -1, nearD = 3.0;
  for (let i = 0; i < 3; i++) {
    if (game.relays[i]) continue;
    const d = relayMeshes[i].position.distanceTo(yawObj.position);
    if (d < nearD) { nearD = d; near = i; }
  }

  const holding = !!(keys.KeyE || touch.holdE);
  if (near >= 0 && holding) {
    if (game.aligning !== near) { game.aligning = near; game.alignT = 0; renderObjectives(); }
    game.alignT += dt;
    audio.setShriek(true);
    emitNoise(0.9);                                       // screams at the relay position
    el.promptText.textContent = 'ALIGNING — IT CAN HEAR THIS';
    el.progressFill.style.width = `${(game.alignT / ALIGN_TIME) * 100}%`;
    el.prompt.classList.add('on');
    relayMeshes[near].material.emissiveIntensity = 0.55 + Math.sin(game.t * 22) * 0.45;
    if (game.alignT >= ALIGN_TIME) {
      game.relays[near] = true;
      relayMeshes[near].material = relayPool.doneMat;
      game.aligning = -1;
      audio.setShriek(false);
      audio.relayDone();
      renderObjectives();
      const left = game.relays.filter((r) => !r).length;
      say(left ? `Relay aligned. ${left} remaining.` : 'All relays aligned. The lift has power.', 5);
      if (!left) {
        game.liftLive = true;
        liftMesh.material.emissive.setHex(0xff8a3c);
      }
    }
  } else {
    if (game.aligning >= 0) {
      game.aligning = -1;
      audio.setShriek(false);
      say('Alignment lost.', 2.5);
      renderObjectives();
    }
    if (near >= 0) {
      el.promptText.textContent = touch.active ? 'HOLD [HOLD] TO ALIGN' : 'HOLD [E] TO ALIGN';
      el.progressFill.style.width = '0%';
      el.prompt.classList.add('on');
    } else {
      el.prompt.classList.remove('on');
    }
  }

  // idle relay glow
  relayMeshes.forEach((m, i) => {
    if (!game.relays[i] && game.aligning !== i)
      m.material.emissiveIntensity = 0.45 + Math.sin(game.t * 2 + i) * 0.12;
  });

  // --- lift ---
  if (game.liftLive && liftMesh.position.distanceTo(yawObj.position) < 2.4) { winRun(); return; }

  // --- listener (zombie + jump-scare hooks) ---
  TMP.pos.set(game.pos.x, 0, game.pos.z);
  let scareFlash = 0;
  const caught = listener.update(dt, TMP.pos, audio, {
    scareBlocked: () => game.over,
    onJumpscareStart: () => { game.scare = 0.0001; },
    onScareProgress: (p) => { game.scare = p; },
  });
  if (game.scare > 0) scareFlash = Math.min(1, game.scare);
  const prox = listener.proximity(TMP.pos);
  audio.heartbeat(prox, dt);

  // threat pulse + jump-scare red flash drive the post pass
  postUniforms.uPulse.value += ((prox + scareFlash * 0.9) - postUniforms.uPulse.value)
    * Math.min(1, dt * 4);
  renderer.toneMappingExposure = BASE_EXPOSURE - prox * 0.25 - scareFlash * 0.35;

  // camera shake + white-red flash during the lunge — much harder than v1
  if (scareFlash > 0 && !game.over) {
    const amp = 0.09 * Math.sin(Math.min(1, scareFlash) * Math.PI);
    yawObj.position.x += (Math.random() - 0.5) * amp;
    yawObj.position.y += (Math.random() - 0.5) * amp;
    game.yaw += (Math.random() - 0.5) * 0.012;
    game.pitch += (Math.random() - 0.5) * 0.010;
  }

  if (listener.state === STATE.HUNT && prox > 0.55) {
    if (subTimer <= 0) say('It is coming. Do not run in a straight line.', 3);
  }

  if (caught) { die(); return; }

  // --- hud ---
  el.noiseFill.style.width = `${game.smoothNoise * 100}%`;
  el.noiseFill.style.background = game.smoothNoise > 0.7 ? '#ff5a3c'
    : game.smoothNoise > 0.35 ? '#ff8a3c' : '#d8d2c4';

  if (subTimer > 0) { subTimer -= dt; if (subTimer <= 0) el.subtitle.classList.remove('on'); }
}

// ---------- resize ----------
function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  rt.setSize(w, h);
}
addEventListener('resize', onResize);
visualViewport?.addEventListener('resize', onResize);

// ---------- debug + test hooks ----------
// Everything below is gated on RR_DEBUG_HOOKS, which esbuild replaces with a literal
// `false` for release builds (see build.mjs) so the whole block is dead-code eliminated.
// It must not ship: __rrBanish / __rrWarp / __rrSetState let anyone skip the game from
// the console, which would quietly invalidate any playtest feedback.
// eslint-disable-next-line no-undef
if (typeof RR_DEBUG_HOOKS === 'undefined' || RR_DEBUG_HOOKS) {
// ---------- debug readout (CLAUDE.md: report measured numbers) ----------
window.__readyRun = () => ({
  fps: +fps.toFixed(1),
  drawCalls: sceneStats.calls,
  triangles: sceneStats.triangles,
  geometries: sceneStats.geometries,
  textures: sceneStats.textures,
  wallInstances: level?.wallCount ?? 0,
  listenerState: listener?.state ?? null,
  relays: game?.relays ?? null,
  flashlight: game?.flashlight ?? null,
  flashlightIntensity: +flashlight.intensity.toFixed(1),
  noise: game ? +game.smoothNoise.toFixed(2) : null,
  listenerDist: game && listener
    ? +listener.pos.distanceTo(TMP.pos.set(game.pos.x, 0, game.pos.z)).toFixed(1) : null,
  liftLive: game?.liftLive ?? null,
  over: game?.over ?? null,
});

// Test hook: warp the player next to a relay (0-2) or the lift ('lift').
// Used by tests/playtest.mjs to exercise the alignment loop without a 5-minute walk.
window.__rrWarp = (which) => {
  if (!game || !level) return 'no-game';
  const c = which === 'lift' ? level.lift : level.relays[which];
  if (!c) return 'bad-target';
  const w = level.toWorld(c.x, c.z);
  game.pos.set(w.x, 0, w.z + 1.2);
  if (level.collides(TMP.pos.set(game.pos.x, 0, game.pos.z))) game.pos.set(w.x, 0, w.z);
  return `warped to ${which}`;
};
// Test hook: place the Listener a given number of cells from the player, so
// escalation can be tested deterministically instead of waiting on patrol RNG.
window.__rrPlaceListener = (cells = 5) => {
  if (!listener || !level || !game) return 'no-game';
  const here = level.toGrid(game.pos);
  for (let r = cells; r < cells + 8; r++) {
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      const x = here.x + Math.round(Math.cos(th) * r);
      const z = here.z + Math.round(Math.sin(th) * r);
      if (level.open(x, z)) {
        listener.pos.copy(level.toWorld(x, z));
        listener.pos.y = 0;
        listener.state = STATE.DORMANT;
        listener.lastHeard = null;
        listener.target = null;
        listener.stepCell = null;
        return `placed at ${listener.pos.distanceTo(game.pos).toFixed(1)}m`;
      }
    }
  }
  return 'no-open-cell';
};
// Test hook: place the Listener at the nearest open cell with clear line of sight,
// face the camera at it, and freeze it. For visual inspection of the creature —
// naive radial placement usually lands it behind a maze wall.
window.__rrShowcase = (minD = 3.0, maxD = 9.0) => {
  if (!listener || !level || !game) return 'no-game';
  const here = level.toGrid(game.pos);
  const clear = (target) => {
    const steps = Math.ceil(game.pos.distanceTo(target) / 0.25);
    for (let s = 1; s < steps; s++) {
      TMP.pos.lerpVectors(game.pos, target, s / steps);
      TMP.pos.y = 0;
      if (level.collides(TMP.pos, 0.1)) return false;
    }
    return true;
  };
  const cands = [];
  for (let dz = -4; dz <= 4; dz++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = here.x + dx, z = here.z + dz;
      if (!level.open(x, z)) continue;
      const w = level.toWorld(x, z); w.y = 0;
      const d = game.pos.distanceTo(w);
      if (d < minD || d > maxD) continue;
      cands.push({ w, d });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands) {
    if (!clear(c.w)) continue;
    listener.pos.copy(c.w);
    listener.pos.y = 0;
    listener.state = STATE.DORMANT;
    listener.target = null;
    listener.stepCell = null;
    listener.mesh.position.copy(listener.pos);
    const dx = listener.pos.x - game.pos.x, dz = listener.pos.z - game.pos.z;
    game.yaw = Math.atan2(-dx, -dz);
    game.pitch = 0;
    // Turn it to face the player. Frozen, it keeps whatever yaw it was walking with,
    // which meant inspection shots caught it in profile with the frills edge-on.
    TMP.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(-dx, -dz));
    listener.mesh.quaternion.copy(TMP.q);
    listener._frozen = true;
    return `showcased at ${c.d.toFixed(1)}m with clear LOS`;
  }
  return 'no-cell-with-LOS';
};

// Test hook: dump creature part world-space heights + spotlight params, and allow
// toggling shadows, for diagnosing "why is the upper body dark".
window.__rrProbe = (opts = {}) => {
  if (!listener) return 'no-game';
  if (opts.shadows !== undefined) {
    flashlight.castShadow = !!opts.shadows;
    listener.mesh.traverse((o) => { if (o.isMesh) o.castShadow = !!opts.shadows; });
  }
  if (opts.bias !== undefined) flashlight.shadow.bias = opts.bias;
  if (opts.ambient !== undefined) {
    scene.traverse((o) => { if (o.isAmbientLight) o.intensity = opts.ambient; });
  }
  if (opts.angleDeg !== undefined) flashlight.angle = opts.angleDeg * Math.PI / 180;
  if (opts.penumbra !== undefined) flashlight.penumbra = opts.penumbra;
  const parts = [];
  const lightW = new THREE.Vector3();
  const targetW = new THREE.Vector3();
  const axis = new THREE.Vector3();
  flashlight.updateWorldMatrix(true, false);
  flashlight.target.updateWorldMatrix(true, false);
  lightW.setFromMatrixPosition(flashlight.matrixWorld);
  targetW.setFromMatrixPosition(flashlight.target.matrixWorld);
  axis.subVectors(targetW, lightW).normalize();

  listener.mesh.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    // Angle off the spot axis decides whether this part is inside the cone at all.
    const toPart = new THREE.Vector3().subVectors(p, lightW);
    const dist = toPart.length();
    const offAxisDeg = Math.acos(
      THREE.MathUtils.clamp(toPart.normalize().dot(axis), -1, 1)) * 180 / Math.PI;
    // Screen position so a test can sample the actual pixel there.
    const ndc = p.clone().project(camera);
    parts.push({
      name: o.name || '?',
      y: +p.y.toFixed(2),
      dist: +dist.toFixed(2),
      offAxisDeg: +offAxisDeg.toFixed(1),
      sx: Math.round((ndc.x * 0.5 + 0.5) * innerWidth),
      sy: Math.round((-ndc.y * 0.5 + 0.5) * innerHeight),
      visible: o.visible,
      side: o.material.side,
      cast: o.castShadow,
    });
  });
  const outer = flashlight.angle * 180 / Math.PI;
  return {
    parts,
    camY: +yawObj.position.y.toFixed(2),
    spot: {
      intensity: +flashlight.intensity.toFixed(1),
      outerDeg: +outer.toFixed(1),
      innerDeg: +(outer * (1 - flashlight.penumbra)).toFixed(1),
      penumbra: flashlight.penumbra,
      decay: flashlight.decay,
      distanceCutoff: flashlight.distance,
      castShadow: flashlight.castShadow,
      bias: flashlight.shadow.bias,
      posY: +lightW.y.toFixed(2),
      axis: [+axis.x.toFixed(2), +axis.y.toFixed(2), +axis.z.toFixed(2)],
    },
  };
};
window.__rrSetState = (s) => {
  if (!listener) return 'no-game';
  if (!STATE[s]) return 'bad-state';
  listener.state = STATE[s];
  listener.stateT = 0;
  return `state=${s}`;
};

// Test hook: aim the camera at the Listener (for visual inspection shots).
window.__rrLookAtListener = () => {
  if (!listener || !game) return 'no-game';
  const dx = listener.pos.x - game.pos.x, dz = listener.pos.z - game.pos.z;
  game.yaw = Math.atan2(-dx, -dz);
  game.pitch = 0;
  return `facing listener at ${Math.hypot(dx, dz).toFixed(1)}m`;
};

// Test hook: freeze the Listener so inspection shots are stable.
window.__rrFreeze = (on = true) => {
  if (!listener) return 'no-game';
  listener._frozen = on;
  return on ? 'frozen' : 'thawed';
};

// Test hook: push the Listener far away so timing tests aren't randomly killed.
window.__rrBanish = () => {
  if (!listener || !level) return 'no-game';
  const far = level.roomCenters.reduce((a, b) => {
    const da = Math.hypot(a.x - level.toGrid(game.pos).x, a.z - level.toGrid(game.pos).z);
    const db = Math.hypot(b.x - level.toGrid(game.pos).x, b.z - level.toGrid(game.pos).z);
    return db > da ? b : a;
  });
  listener.pos.copy(level.toWorld(far.x, far.z));
  listener.state = STATE.DORMANT;
  listener.lastHeard = null;
  listener.target = null;
  listener.stepCell = null;
  return 'banished';
};
}  // end RR_DEBUG_HOOKS

// ---------- go ----------
el.loading.classList.add('hide');
show(el.start);
frame();
