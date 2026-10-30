#!/usr/bin/env node
// Build the static site that ships next to the Worker.
//
//   node tools/build-web.mjs
//
// The source tree serves the client from /client/ so relative module imports can
// reach /shared/. The deployed site lives at the domain root, so this copies the
// handful of browser files to dist/, rewrites the single ../shared import, and
// copies the avatar assets. No bundler, no dependencies.

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');

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

const avatars = (await readdir(join(ROOT, 'assets'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.avtr'))
  .map((entry) => entry.name)
  .sort();
if (!avatars.length) {
  throw new Error('build-web: no .avtr files in assets/ (run node tools/make-avatar.mjs)');
}
for (const name of avatars) {
  await copyFile(join(ROOT, 'assets', name), join(DIST, 'assets', name));
}

// Workers Static Assets reads _headers with the site. ETag revalidation keeps
// the 12 MB avatar cheap on repeat visits without risking a stale head after a
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

const bytes = await Promise.all(avatars.map(async (name) => {
  const data = await readFile(join(ROOT, 'assets', name));
  return { name, size: data.length };
}));
const total = bytes.reduce((sum, file) => sum + file.size, 0);

console.log(`dist/ ready (${CLIENT_FILES.length} client files, ${avatars.length} avatar${avatars.length === 1 ? '' : 's'}, ${(total / 1024 / 1024).toFixed(1)} MB)`);
for (const file of bytes) {
  console.log(`  assets/${file.name}  ${(file.size / 1024 / 1024).toFixed(1)} MB`);
}
