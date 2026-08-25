// Release build: bundles src/ + three into one minified IIFE, strips the debug hooks,
// and emits a self-contained dist/ that runs from file:// with no server and no CDN.
//
// Run: npm run build     (npm run release also verifies the output)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from './tools/zip.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// IIFE, not ESM: <script type="module"> is blocked under file://, so a module build
// would only work behind a server. A classic script runs from a double-clicked file.
const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  define: { RR_DEBUG_HOOKS: 'false' },   // drops the whole __rr* hook block
  outfile: path.join(DIST, 'app.js'),
  metafile: true,
});

// Rewrite index.html: drop the importmap and the module script, point at the bundle.
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace(
    /<script type="module" src="\.\/src\/main\.js"><\/script>/,
    '<script src="./app.js"></script>');
if (html.includes('importmap') || html.includes('src/main.js')) {
  throw new Error('index.html rewrite failed — check the script tags still match');
}
fs.writeFileSync(path.join(DIST, 'index.html'), html);

// Ship the zombie model with the bundle — the release must stay self-contained.
// The fetch path is relative, so the same './public/models/...' URL works from dist/.
fs.mkdirSync(path.join(DIST, 'public', 'models'), { recursive: true });
fs.copyFileSync(
  path.join(ROOT, 'public', 'models', 'zombie.obj'),
  path.join(DIST, 'public', 'models', 'zombie.obj'));

fs.writeFileSync(path.join(DIST, 'HOW-TO-PLAY.txt'), `READY-RUN — playtest build

TO PLAY
  Extract this whole folder somewhere, then double-click index.html.
  Chrome or Edge recommended. Needs WebGL; no install, no internet.
  Click the page once to start, then click again to lock the mouse.

CONTROLS (desktop)
  W A S D   move
  SHIFT     sprint      -- loud
  CTRL      crouch      -- near silent
  F         flashlight  -- the click carries
  E         hold to align a relay -- it screams the whole time
  ESC       release the mouse

CONTROLS (phone)
  Left stick     move
  Right-half drag look / turn the view
  RUN            sprint -- loud
  CROUCH         near silent
  LIGHT          flashlight -- the click carries
  HOLD           hold to align a relay

HOW IT WORKS
  The thing down here has no eyes. It hunts by sound.
  The bar at the bottom-left is how loud you are -- that is your real health bar.
  Standing still makes you effectively invisible to it.
  It is faster than you when it is hunting, so running in a straight line loses.
  Breaking away and going still is what works.

  Align all three relays, then reach the lift.

IF IT DOES NOT LOAD
  Some browsers restrict local files. If the screen stays black, serve the folder:
    python -m http.server 8177
  then open http://127.0.0.1:8177
`);

const bytes = fs.statSync(path.join(DIST, 'app.js')).size;
console.log(`dist/app.js       ${(bytes / 1024).toFixed(0)} KB minified`);
console.log(`dist/index.html   ${(fs.statSync(path.join(DIST, 'index.html')).size / 1024).toFixed(1)} KB`);

// Guard: the hooks must not survive into the shipped bundle.
const code = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8');
const leaked = ['__rrBanish', '__rrWarp', '__rrSetState', '__rrShowcase', '__readyRun']
  .filter((h) => code.includes(h));
if (leaked.length) throw new Error('debug hooks leaked into build: ' + leaked.join(', '));
console.log('debug hooks       stripped');
if (result.metafile) {
  fs.writeFileSync(path.join(DIST, '..', 'build-meta.json'),
    JSON.stringify(result.metafile, null, 2));
}

// Zip it for handoff. Everything is nested under one folder so extracting into a
// Downloads directory does not scatter three loose files next to whatever else is there.
// Recurses into subdirectories (public/models/...) so the zip stays self-contained.
const zipName = 'Ready-Run-playtest.zip';
const zipEntries = [];
const collect = (dir, rel) => {
  for (const f of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, f);
    const relPath = rel ? `${rel}/${f}` : f;
    if (fs.statSync(abs).isDirectory()) collect(abs, relPath);
    else zipEntries.push({
      name: 'Ready-Run/' + relPath,
      data: fs.readFileSync(abs),
      mtime: fs.statSync(abs).mtime,
    });
  }
};
collect(DIST, '');
const zip = zipSync(zipEntries);
fs.writeFileSync(path.join(ROOT, zipName), zip);
console.log(`${zipName}   ${(zip.length / 1024).toFixed(0)} KB  (send this)`);
