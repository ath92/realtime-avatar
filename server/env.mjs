// Tiny .env loader + typed env readers.
//
// The repo has no dependencies on purpose, so this replaces dotenv. It is
// deliberately conservative: an existing process env var always wins, values
// are never logged, and a malformed line is skipped rather than fatal.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      // Parse the quoted section, then ignore a trailing ` # comment`.
      const quote = value[0];
      let parsed = '';
      let i = 1;
      let closed = false;
      while (i < value.length) {
        const ch = value[i];
        if (ch === '\\' && quote === '"' && i + 1 < value.length) {
          const next = value[i + 1];
          parsed += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (ch === quote) { closed = true; break; }
        parsed += ch;
        i++;
      }
      value = parsed;
      if (!closed) {
        // Unterminated quote: keep what we have rather than swallowing the rest.
        value = value.replace(/\s+#.*$/, '');
      }
    } else {
      // Allow trailing comments on unquoted values: KEY=value # why
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

// Load .env from the repo root (or ENV_FILE) without clobbering real env vars.
// Returns { path, count } so entry points can print what happened, never values.
export function loadEnv(file = process.env.ENV_FILE || resolve(ROOT, '.env')) {
  const path = resolve(file);
  if (!existsSync(path)) return { path, count: 0, loaded: false };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { path, count: 0, loaded: false };
  }
  const parsed = parseEnv(text);
  let count = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }
  return { path, count, loaded: true };
}

// Empty string means "not configured" so a commented-out key in .env behaves
// the way a human expects.
export function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function envNum(name, fallback) {
  const raw = env(name);
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name, fallback = false) {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

// `LLM_TEMPERATURE=none` lets reasoning-model endpoints omit the field.
export function envOptionalNum(name) {
  const raw = env(name).toLowerCase();
  if (!raw || raw === 'none' || raw === 'omit') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
