# Ready-Run — Project Harness

3D horror game. **Engine: Three.js / WebGL (browser).**

> The CCGS framework installed in `.claude/` is Unity/Godot-oriented and contains **zero**
> Three.js guidance. When a CCGS skill or agent gives engine-specific advice, the rules in
> this file win. Treat CCGS as process scaffolding (design docs, sprints, review gates),
> not as an engine reference.

---

## 3D Math Constraints

**Rotations: quaternions only.** Never accumulate rotation as Euler angles — it gimbal-locks
and the failure is orientation-dependent, so it will not show up in a straight-ahead test.

```js
// WRONG — accumulating Euler
mesh.rotation.y += dy; mesh.rotation.x += dx;

// RIGHT — compose quaternions
const q = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, dy);
mesh.quaternion.premultiply(q);
```

- Euler angles are acceptable **only** as a one-shot authoring value (an initial pose set
  once and never accumulated) or for display in debug UI.
- Interpolate with `Quaternion.slerp`, never by lerping Euler components.
- First-person camera: yaw on the parent object, pitch on the camera child, and clamp pitch to
  `±(π/2 − ε)`. Do not stack yaw and pitch into one quaternion, or the horizon will roll.

**Vector math:**
- Allocate `Vector3`/`Quaternion`/`Matrix4` **outside** the frame loop and reuse them. A `new`
  in a per-frame path is a GC stall, and in a horror game a stutter reads as a bug in the scare.
- Prefer `lengthSq()` over `length()` for comparisons — skips the square root.
- Use `distanceToSquared` for proximity/trigger checks.
- Normalize after any accumulation of directions; never assume a summed vector is unit-length.
- Frame-rate independence: scale every rate by `delta`. Clamp `delta` (e.g. `min(delta, 0.1)`)
  so an alt-tab pause cannot tunnel a body through a wall.

---

## Performance Limits

**Instancing — required for repeated geometry.** Any mesh appearing more than ~8 times uses
`THREE.InstancedMesh`, not N `Mesh` objects. Applies to: corridor props, pipes, debris, foliage,
lockers, ceiling lights.

```js
const im = new THREE.InstancedMesh(geo, mat, count);
im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // only if actually moving
```

Set `im.count` to shrink an instance pool — do not rebuild the mesh.

**Object pooling — required for anything spawned at runtime.** Particles, bullet/hit decals,
audio emitters, footstep marks. Pre-allocate at load, then `visible = false` to retire.
Never `new` a mesh or dispose geometry mid-gameplay.

**Dynamic lights — hard budget.** WebGL forward rendering recompiles shaders per light-count
change and cost scales with lit fragments.

| Light type | Budget |
|---|---|
| Shadow-casting dynamic | **2** (the player's flashlight + at most one other) |
| Non-shadow dynamic (point/spot) | **8** |
| Baked / emissive-material fake lights | unlimited — prefer these |

- Everything static gets baked into lightmaps or emissive materials.
- Flashlight: one `SpotLight` with `castShadow`, tuned `shadow.bias` to kill acne.
- **`SpotLight` and `DirectionalLight` ship at `position = (0,1,0)`**, not the origin — their
  constructors do `this.position.copy(Object3D.DEFAULT_UP)`. Parenting one to the camera
  without zeroing this puts the emitter 1 m above the eye aimed 45° at the floor, so
  everything above chest height falls outside the cone. Always `light.position.set(0,0,0)`
  after construction, and assert it in a test:

```js
const flashlight = new THREE.SpotLight(...);
flashlight.position.set(0, 0, 0);   // NOT optional — see above
camera.add(flashlight);
camera.add(flashlight.target);
flashlight.target.position.set(0, 0, -1);
```

- A hand torch is collimated, so in-beam falloff is much gentler than a bare bulb's.
  `decay: 1.0` gives a usable throw; physical `decay: 2.0` leaves corridors black past ~4 m.
- Keep shadow maps at 1024² unless a specific artifact justifies 2048².
- Set `shadow.camera.far` tight to the actual throw distance — a loose far plane wastes depth
  precision and produces peter-panning.

**Draw calls:** target < 150/frame. Merge static geometry (`BufferGeometryUtils.mergeGeometries`),
share materials, atlas textures. Check with `renderer.info.render.calls`.

**Disposal:** on level unload, explicitly `dispose()` geometries, materials, and textures.
Removing from the scene graph does **not** free GPU memory — this leaks until tab crash.

---

## Assets

| Asset | Budget |
|---|---|
| Hero prop / character | ≤ 15k tris |
| Standard prop | ≤ 3k tris |
| Environment module | ≤ 8k tris |
| Texture (albedo/normal) | 1024², 2048² for hero only |
| Total scene | ≤ 500k tris visible |

- Textures: power-of-two, KTX2/Basis compressed. Never ship raw PNG for 3D surfaces.
- Models: glTF/GLB only, Draco-compressed.
- Meshes need explicit LODs (`THREE.LOD`) if visible beyond ~20 units.
- Every material declares whether it is opaque, alpha-tested, or alpha-blended. Blended
  materials do not write depth and will sort wrong — justify each one.

---

## Shaders (GLSL / WGSL)

- Custom shaders go through `ShaderMaterial` / `NodeMaterial`, with uniforms declared and
  reused — no per-frame uniform object churn.
- `precision mediump float` unless a specific effect needs `highp`.
- No branching on varyings in fragment shaders; use `step`/`mix`.
- Fog, grain, chromatic aberration, vignette — the horror atmosphere stack — belong in **one**
  composited post pass, not stacked `EffectComposer` passes. Each pass is a full-screen blit.
- Always state which coordinate space you are in (world / view / tangent). Normal-mapping bugs
  are almost always a space mismatch.

---

## Verification

The Playwright MCP is configured in `.mcp.json`. Use it to actually look at the canvas rather
than reasoning about rendering from source:

- Screenshot the canvas after any camera, lighting, or shadow change.
- Check specifically for: near-plane clipping when the camera is against geometry, shadow acne
  and peter-panning, z-fighting on coplanar surfaces, and blown-out or crushed-black exposure.
- Read `renderer.info` (`render.calls`, `render.triangles`, `memory.geometries`,
  `memory.textures`) and report the numbers — do not estimate them.

**A rendering change is not done until it has been looked at.** Horror lighting in particular
cannot be validated from code: "too dark to see the monster" and "correctly dark" are identical
in the source and obvious in a screenshot.

**When a screenshot shows something wrong, measure — do not iterate on guesses.** Screenshots
tell you *that* something is broken; they rarely tell you *why*. `tests/probe-monster.mjs`
prints, per body part, the world position, distance, **angle off the spotlight axis**, projected
screen pixel, and sampled peak luminance. That table found the `DEFAULT_UP` bug in one run after
several screenshot rounds had ruled out only what it wasn't. Build the equivalent numeric probe
for whatever you are debugging.

Two invariants worth asserting rather than eyeballing, both in `tests/playtest.mjs`:
- Every part of a lit subject is inside the light cone (`offAxisDeg <= outerDeg`) **and** samples
  above a luma floor. Geometry can be inside the cone and still render black.
- Toggling the flashlight must measurably change the frame. If ambient carries the image, `F`
  does nothing on screen and the noise-versus-visibility tradeoff stops mattering.

---

## Shipping

Two targets, and they are not interchangeable:

| | Dev | Release |
|---|---|---|
| Entry | `index.html` + importmap → jsdelivr CDN | `dist/index.html` + bundled `dist/app.js` |
| Module format | ESM (`<script type="module">`) | **classic IIFE** |
| Runs from `file://` | no | yes |
| `__rr*` debug hooks | present | stripped |
| Command | `npm run dev` | `npm run release` |

- **The release bundle must stay a classic IIFE.** `<script type="module">` is blocked under
  `file://` by the browser's module CSP, so an ESM release only works behind a server and a
  playtester double-clicking `index.html` gets a black screen. `build.mjs` sets
  `format: 'iife'` for exactly this reason — do not "modernise" it to `esm`.
- **Debug hooks must not ship.** `__rrBanish()` / `__rrWarp()` / `__rrSetState()` in the
  console let a playtester skip the game, which silently invalidates their feedback. They live
  behind `if (typeof RR_DEBUG_HOOKS === 'undefined' || RR_DEBUG_HOOKS)`, which esbuild's
  `define` collapses to `false` so the block is dead-code eliminated. `build.mjs` asserts none
  of the names survive into the bundle and throws if any do.
- `build.mjs` rewrites `index.html` by pattern-matching the importmap and module `<script>`
  tags, and **throws if either pattern stops matching**. If you restructure those tags, the
  build fails loudly rather than shipping an HTML file that still points at `src/main.js`.
- **`npm run release` verifies the artifact a friend actually receives**: it extracts the zip
  with the OS unzipper, then boots the *extracted* copy from `file://` in real Chrome with no
  special flags. Testing `dist/` in place would not catch a malformed archive.
- Source cannot be truly hidden in a browser game. Minification and a stripped sourcemap stop
  casual reading; they do not stop determined extraction. Don't claim otherwise.

---

## Working Agreements

- Never claim a visual change works without a screenshot or a `renderer.info` reading.
- Report perf as measured numbers, not adjectives.
- If a requested effect would breach a budget above, say so with the number and propose the
  cheaper equivalent — then implement whichever is chosen.
- A test that cannot fail is worse than no test. If a probe is unavailable in the build under
  test (as the `__rr*` hooks are in release), delete the check rather than letting it pass
  vacuously — note where the real coverage lives instead.
