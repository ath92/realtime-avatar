// Typed env readers, deliberately free of Node built-ins so the provider
// pipeline can run unchanged in a Cloudflare Worker.
//
// Node reads process.env by default. The Worker calls setEnvSource(env) once per
// request to point these readers at its bindings; the .env loader itself lives
// in server/load-env.mjs and is only imported by local entry points.

let source = null;

export function setEnvSource(next) {
  source = next && typeof next === 'object' ? next : null;
}

function raw(name) {
  if (source) {
    const value = source[name];
    return typeof value === 'string' ? value : undefined;
  }
  if (typeof process !== 'undefined' && process.env) return process.env[name];
  return undefined;
}

// Empty string means "not configured" so a commented-out key in .env behaves
// the way a human expects.
export function env(name, fallback = '') {
  const value = raw(name);
  return value === undefined || value === '' ? fallback : value;
}

export function envNum(name, fallback) {
  const value = env(name);
  if (value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name, fallback = false) {
  const value = env(name).toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

// `LLM_TEMPERATURE=none` lets reasoning-model endpoints omit the field.
export function envOptionalNum(name) {
  const value = env(name).toLowerCase();
  if (!value || value === 'none' || value === 'omit') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
