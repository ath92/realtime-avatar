#!/usr/bin/env node
// Build assets/head.avtr from the procedural rig.
//
//   node tools/make-avatar.mjs [--density 1] [--out assets/head.avtr]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildHead } from './rig.mjs';
import { encodeAvatar, layout } from '../shared/format.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const density = Number(opt('density', 1));
const out = resolve(opt('out', 'assets/head.avtr'));

const t0 = performance.now();
const head = buildHead({ density });
const bytes = encodeAvatar(head);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);

const { bytes: bodyBytes } = layout(head.n, head.nb);
const nonZero = head.deltas.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0);

console.log(`gaussians   ${head.n.toLocaleString()}`);
console.log(`channels    ${head.nb} (${head.names.join(', ')})`);
console.log(`payload     ${(bodyBytes / 1e6).toFixed(2)} MB`);
console.log(`deltas      ${((nonZero / head.deltas.length) * 100).toFixed(1)}% non-zero`);
console.log(`built in    ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`written     ${out}`);
