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

import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
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

/**
 * Bug-L fix (2026-06-01): cache-bust every script/css URL in
 * index.html with a per-build version stamp. Reason: when src/index.ts
 * was sending Cache-Control: max-age=31536000, immutable for non-
 * index.html assets (the previous policy), Safari locked in cached
 * copies for a year. Switching the server header to no-cache fixed
 * NEW visitors but does NOT free existing visitors from the poisoned
 * immutable entry — per HTTP spec the browser MUST NOT revalidate an
 * immutable response during its freshness lifetime. The only fool-
 * proof unlock is a NEW URL, so we append `?v=<buildStamp>` to every
 * referenced script/style. Each new deploy gets a new stamp, the URLs
 * change, the browser fetches fresh code. Old cache entries stay in
 * the cache pointlessly but are never referenced again.
 */
function rewriteHtmlWithCacheBust(html, buildStamp) {
  // Replace src="foo.js" / src='foo.jsx' / href="foo.css" attributes
  // with the same path + ?v=<buildStamp>. Skip URLs that:
  //   - already carry a query string (someone is doing their own bust)
  //   - are absolute (https://, //) — we don't proxy those
  //   - point at fragments / mailto (no path component)
  const tagPattern = /(\s(?:src|href)=)(["'])([^"']+)\2/g;
  return html.replace(tagPattern, (whole, attr, quote, url) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) return whole;
    if (url.startsWith('#') || url.startsWith('mailto:')) return whole;
    if (url.includes('?')) return whole;
    if (!/\.(jsx?|mjs|css)$/i.test(url)) return whole;
    return `${attr}${quote}${url}?v=${buildStamp}${quote}`;
  });
}

function main() {
  // Wipe the previous build so stale files (e.g. the old vite-built
  // index.html that didn't reference the design bundle) never leak.
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
  ensureDir(DIST_DIR);

  // Build stamp: epoch seconds (10-digit, sorts naturally, no shell
  // dependency on git which may be missing in some CI shapes).
  const buildStamp = Math.floor(Date.now() / 1000).toString();

  for (const item of COPY_PLAN) {
    const src = join(item.root, item.from);
    if (!existsSync(src)) {
      console.error(`web-build: missing source ${src}`);
      process.exit(1);
    }
    const dest = join(DIST_DIR, item.to);
    ensureDir(dirname(dest));
    // index.html gets its script/css URLs cache-busted on the way in.
    // Every other file is a verbatim copy.
    if (item.to === 'index.html') {
      const html = readFileSync(src, 'utf-8');
      writeFileSync(dest, rewriteHtmlWithCacheBust(html, buildStamp), 'utf-8');
    } else {
      copyFileSync(src, dest);
    }
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

  // Sanity check: the cache-bust pass must have actually inserted ?v=
  // at least once, otherwise we ship a stale-cache hazard for free.
  const finalHtml = readFileSync(join(DIST_DIR, 'index.html'), 'utf-8');
  if (!finalHtml.includes(`?v=${buildStamp}`)) {
    console.error('web-build: cache-bust pass produced ZERO replacements — every script/css URL in index.html was skipped. Either the file is empty or the regex no longer matches the current markup. Refusing to ship a known stale-cache hazard.');
    process.exit(1);
  }

  console.log(`web-build: assembled ${COPY_PLAN.length} files into ${DIST_DIR}, cache-bust stamp=${buildStamp}`);
}

main();
