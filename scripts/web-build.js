#!/usr/bin/env node
/**
 * web-build.js — assemble web/dist/ for the Node server to serve.
 *
 * The Jarvis web client is React + Babel-standalone loaded via CDN, so
 * the JSX files ship as-is (no Vite, no Webpack, no JSX transform). This
 * script is a deterministic file-copy: it pulls verbatim source from
 *
 *   design/claude-design/  (styles.css, tweaks-panel.jsx, ios-frame.jsx,
 *                           components.jsx)   ← the polished design surface
 *   web/                   (index.html, main.jsx, jarvis-client.js)
 *                                             ← the real WS + mic wiring
 *   web/public/            (pcm-recorder.js, pcm-player.js, demo/*)
 *                                             ← audio worklets + demo manifests
 *
 * into web/dist/. Run by `npm run web:build`. The Node server in
 * src/index.ts serves web/dist/ on `/`.
 *
 * No bundling, no minification — Babel-standalone transforms the JSX in
 * the browser on first load. That's fine for a single-page demo; the
 * trade-off (slower first paint) is acceptable given the gain (we can
 * drop the design's JSX in literally as-is and the maintenance cost is
 * one fewer build tool to keep alive).
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DESIGN_DIR = join(REPO_ROOT, 'design', 'claude-design');
const WEB_DIR = join(REPO_ROOT, 'web');
const PUBLIC_DIR = join(WEB_DIR, 'public');
const DIST_DIR = join(WEB_DIR, 'dist');

/**
 * Each entry copies one file from a source root into the dist root. The
 * `from` field is relative to the entry's `root`; the `to` field is
 * relative to the dist root. Keeping this declarative so it's obvious
 * which file came from where (the design vs. the real wiring).
 */
const COPY_PLAN = [
  // Polished design surface — verbatim.
  { root: DESIGN_DIR, from: 'styles.css',       to: 'styles.css'       },
  { root: DESIGN_DIR, from: 'tweaks-panel.jsx', to: 'tweaks-panel.jsx' },
  { root: DESIGN_DIR, from: 'ios-frame.jsx',    to: 'ios-frame.jsx'    },
  { root: DESIGN_DIR, from: 'components.jsx',   to: 'components.jsx'   },
  // Real wiring — overrides the design's mock main.jsx.
  { root: WEB_DIR, from: 'index.html',       to: 'index.html'       },
  { root: WEB_DIR, from: 'main.jsx',         to: 'main.jsx'         },
  { root: WEB_DIR, from: 'jarvis-client.js', to: 'jarvis-client.js' },
  // BUG-DIAG-2026-06-01: mic + Whisper isolation modal. Delete this
  // line when the modal is removed.
  { root: WEB_DIR, from: 'mic-test-modal.jsx', to: 'mic-test-modal.jsx' },
  // Audio worklets — loaded by jarvis-client.js via AudioContext.audioWorklet.addModule.
  { root: PUBLIC_DIR, from: 'pcm-recorder.js', to: 'pcm-recorder.js' },
  { root: PUBLIC_DIR, from: 'pcm-player.js',   to: 'pcm-player.js'   },
];

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function copyTree(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    const st = statSync(src);
    if (st.isDirectory()) copyTree(src, dest);
    else if (st.isFile()) copyFileSync(src, dest);
  }
}

function main() {
  // Wipe the previous build so stale files (e.g. the old vite-built
  // index.html that didn't reference the design bundle) never leak.
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
  ensureDir(DIST_DIR);

  for (const item of COPY_PLAN) {
    const src = join(item.root, item.from);
    if (!existsSync(src)) {
      console.error(`web-build: missing source ${src}`);
      process.exit(1);
    }
    const dest = join(DIST_DIR, item.to);
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
  }

  // Demo manifests subtree — recursive copy of web/public/demo/.
  const demoSrc = join(PUBLIC_DIR, 'demo');
  if (existsSync(demoSrc)) copyTree(demoSrc, join(DIST_DIR, 'demo'));

  // Sanity check: index.html must end up in dist or src/index.ts will 404
  // every `/` request.
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    console.error('web-build: dist/index.html not produced');
    process.exit(1);
  }

  console.log(`web-build: assembled ${COPY_PLAN.length} files into ${DIST_DIR}`);
}

main();
