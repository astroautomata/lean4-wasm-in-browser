import fs from 'node:fs'

/** Environment parsing shared by the collector, migration runner and jobs.
 * Every reader takes an explicit `env` so tests never depend on process.env. */

export class ConfigError extends Error {}

/** A secret from `NAME`, or from the file named by `NAME_FILE` (Compose
 * secrets). Trailing newlines are trimmed. Setting both is an error. */
export function secret(env, name) {
  const direct = env[name]
  const file = env[`${name}_FILE`]
  if (direct != null && direct !== '' && file) throw new ConfigError(`set only one of ${name} and ${name}_FILE`)
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').replace(/\r?\n$/u, '')
    } catch (error) {
      throw new ConfigError(`cannot read ${name}_FILE: ${error.code ?? 'unreadable'}`)
    }
  }
  return direct == null || direct === '' ? null : direct
}

export function string(env, name, fallback = null) {
  const value = env[name]
  return value == null || value.trim() === '' ? fallback : value.trim()
}

export function integer(env, name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = string(env, name)
  if (raw == null) return fallback
  if (!/^-?\d+$/u.test(raw)) throw new ConfigError(`${name} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}`)
  }
  return value
}

export function number(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = string(env, name)
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}

export function boolean(env, name, fallback) {
  const raw = string(env, name)
  if (raw == null) return fallback
  if (/^(1|true|yes|on)$/iu.test(raw)) return true
  if (/^(0|false|no|off)$/iu.test(raw)) return false
  throw new ConfigError(`${name} must be true or false`)
}

export function list(env, name, fallback = []) {
  const raw = string(env, name)
  return raw == null ? fallback : raw.split(',').map(value => value.trim()).filter(Boolean)
}

export function oneOf(env, name, allowed, fallback) {
  const raw = string(env, name)
  if (raw == null) return fallback
  if (!allowed.includes(raw)) throw new ConfigError(`${name} must be one of ${allowed.join(', ')}`)
  return raw
}

/** node-postgres connection options for one role: `<PREFIX>DATABASE_URL(_FILE)`,
 * or the shared PGHOST/PGPORT/PGDATABASE with `<PREFIX>PGUSER` and
 * `<PREFIX>PGPASSWORD(_FILE)`. A prefixed role never falls back to the
 * unprefixed (runtime) credentials. The password is never logged. */
export function connection(env, prefix = '') {
  const url = secret(env, `${prefix}DATABASE_URL`)
  if (url) return { connectionString: url }
  const host = string(env, 'PGHOST')
  if (!host) throw new ConfigError(`${prefix}DATABASE_URL or PGHOST is required`)
  const user = string(env, `${prefix}PGUSER`)
  if (!user) throw new ConfigError(`${prefix}PGUSER is required when ${prefix}DATABASE_URL is not set`)
  const options = {
    host,
    port: integer(env, 'PGPORT', 5432, { min: 1, max: 65535 }),
    database: string(env, 'PGDATABASE') ?? undefined,
    user,
  }
  const password = secret(env, `${prefix}PGPASSWORD`)
  if (password != null) options.password = password
  return options
}
