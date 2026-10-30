#!/usr/bin/env node
// Build the static site that ships next to the Worker.
//
//   node tools/build-web.mjs
//
// The source tree serves the client from /client/ so relative module imports can
// reach /shared/. The deployed site lives at the domain root, so this copies the
// handful of browser files to dist/, rewrites the single ../shared import, and
// copies the avatar assets. No bundler, no dependencies.

import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');
// The one avatar that ships. Keeping this explicit avoids accidentally
// uploading other personal captures that happen to be in assets/.
const DEFAULT_AVATAR = 'me.avtr';

// Refuse to rm anything that is not exactly <repo>/dist.
if (DIST !== join(ROOT, 'dist') || !DIST.startsWith(ROOT + sep)) {
  throw new Error(`refusing to build outside the repo: ${DIST}`);
}

const CLIENT_FILES = [
  'index.html',
  'style.css',
  'app.js',
  'audio.js',
  'idle.js',
  'mic.js',
  'rig.js',
  'splat.js',
];

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'shared'), { recursive: true });
await mkdir(join(DIST, 'assets'), { recursive: true });

for (const name of CLIENT_FILES) {
  await copyFile(join(ROOT, 'client', name), join(DIST, name));
}
await copyFile(join(ROOT, 'shared', 'format.mjs'), join(DIST, 'shared', 'format.mjs'));

const appPath = join(DIST, 'app.js');
const app = await readFile(appPath, 'utf8');
const rewritten = app.replace(
  "import { loadAvatar } from '../shared/format.mjs';",
  "import { loadAvatar } from './shared/format.mjs';",
);
if (rewritten === app) {
  throw new Error('build-web: expected ../shared/format.mjs import in client/app.js');
}
await writeFile(appPath, rewritten);

const avatarPath = join(ROOT, 'assets', DEFAULT_AVATAR);
let avatarInfo;
try {
  avatarInfo = await stat(avatarPath);
} catch {
  throw new Error(`build-web: missing assets/${DEFAULT_AVATAR} (the default avatar must be tracked)`);
}
if (!avatarInfo.isFile()) {
  throw new Error(`build-web: assets/${DEFAULT_AVATAR} is not a file`);
}
await copyFile(avatarPath, join(DIST, 'assets', DEFAULT_AVATAR));

// Workers Static Assets reads _headers with the site. ETag revalidation keeps
// the 6 MB avatar cheap on repeat visits without risking a stale head after a
// deploy.
await writeFile(join(DIST, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  X-Robots-Tag: noindex, nofollow',
  '  Cache-Control: no-cache',
  '',
  '/assets/*',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
].join('\n'));

// A public demo should not end up in search results; Cloudflare Access is the
// real control, but this is a cheap default.
await writeFile(join(DIST, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

console.log(`dist/ ready (${CLIENT_FILES.length} client files, 1 avatar, ${(avatarInfo.size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  assets/${DEFAULT_AVATAR}  ${(avatarInfo.size / 1024 / 1024).toFixed(1)} MB`);
