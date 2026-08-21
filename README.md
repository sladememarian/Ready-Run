# Ready·Run

A 3D horror game for the browser. You are a Sounder, alone in a listening station a kilometre
underground. The thing down there has no eyes — it hunts by sound, and every task you must
complete makes noise.

**[Play it in your browser →](https://sladememarian.github.io/Ready-Run/)**

Built with Three.js and WebGL. No plugins, no install, no external assets — every mesh is
procedural geometry and every sound is synthesised in WebAudio at runtime.

---

## The mechanic

Your noise meter is the real health bar.

| Input | Noise | Effect |
|---|---|---|
| Standing still | 0.00 | effectively invisible to it |
| Crouch-walking | 0.15 | safe at moderate range |
| Walking | ~0.45 | audible nearby |
| Sprinting | 1.00 | it will come |
| Aligning a relay | 0.90 | for seven unbroken seconds |
| Flashlight click | spike | the toggle itself carries |

It is faster than you when it is hunting, so running in a straight line loses. Breaking line
of travel and going still is what works. Align the three relays, then reach the lift.

## Controls

```
W A S D   move
SHIFT     sprint        — loud
CTRL      crouch        — near silent
F         flashlight    — the click carries
E         hold to align a relay — it screams the whole time
ESC       release the mouse
```

## Running from source

```bash
npm install
npm run dev        # serves on http://127.0.0.1:8177
```

Dev mode loads Three.js as ESM from a CDN via importmap, so it needs a server — opening
`index.html` directly will not work. The release build is different by design (below).

## Build

```bash
npm run build      # -> dist/ and Ready-Run-playtest.zip
npm run release    # build, then verify the zip end to end
```

`npm run build` produces a self-contained `dist/`: one minified IIFE bundle, no CDN
dependency, no sourcemap, and no debug hooks. It runs from `file://` — a playtester can
extract the zip and double-click `index.html` with no server and no internet.

The bundle is a **classic IIFE, not ESM**. `<script type="module">` is blocked under
`file://` by the browser's module CSP, so a module build only works behind a server. See
[`CLAUDE.md`](CLAUDE.md#shipping).

`npm run release` verifies the artifact a playtester actually receives: it extracts the zip
with the OS unzipper, then boots the *extracted* copy from `file://` in real Chrome with no
special flags. Testing `dist/` in place would not catch a malformed archive.

## Tests

```bash
npm test           # 60 logic checks + 36 playtest checks
npm run verify-dist   # 16 release checks (needs a build first)
```

`tests/playtest.mjs` drives real Chrome through the whole game — boots it, walks it, escalates
the creature, aligns all three relays, reaches the lift — and asserts measured numbers, not
adjectives: draw calls under budget, frame luminance in range, flashlight ON measurably
brighter than OFF.

`tests/probe-monster.mjs` is the diagnostic worth knowing about. It prints, per body part, the
world position, distance, **angle off the flashlight axis**, projected screen pixel, and sampled
peak luminance. Screenshots tell you *that* something is broken; that table tells you *why* —
it found a bug in one run that several rounds of screenshots had only narrowed down.

## Layout

```
src/main.js       bootstrap, player controller, noise model, game loop
src/level.js      procedural maze generation, pathfinding, instanced geometry
src/listener.js   the creature — hearing model, state machine, procedural body
src/audio.js      WebAudio synthesis
build.mjs         release bundler
tools/zip.mjs     dependency-free ZIP writer
CLAUDE.md         engineering constraints: 3D math, perf budgets, shipping
design/gdd/       game design document and lore
```

## A note on source

This repository is public, so the source is readable here in full. The minified release
bundle is a convenience for handing the game to a playtester as one small file — it is not
concealment, and nothing in a browser game can be. Minification and a stripped sourcemap
stop casual reading; they do not stop determined extraction.

The release build does strip the `__rr*` debug hooks, and that part matters: `__rrWarp('lift')`
in the console would let a playtester skip straight to the win screen, which would quietly
invalidate their feedback. `build.mjs` asserts none of those names survive into the bundle.
