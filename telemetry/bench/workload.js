import crypto from 'node:crypto'

/** Synthetic telemetry workload for benchmarks (docs/benchmark.md).
 *
 * Deterministic for a given seed, so runs are comparable. Simulated players
 * follow the real protocol: each attempt sends level_start (sequence 0), then
 * steps numbered from 1, then optionally level_complete; a player's events are
 * sent in sequence order. Payload sizes and the visual/classic mix are drawn
 * from a profile of aggregate quantiles (bench/profiles/*.json); generated text
 * is synthetic. */

/** mulberry32: small, fast, seedable. Returns floats in [0, 1). */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Exponential inter-arrival time (seconds) for a Poisson process of `rate` per second. */
export function exponential(random, rate) {
  return -Math.log(1 - random()) / rate
}

export function pickWeighted(random, weights) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0)
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  let target = random() * total
  for (const [key, weight] of entries) {
    target -= weight
    if (target < 0) return key
  }
  return entries.at(-1)[0]
}

/** Sample from quantiles given at evenly spaced probabilities (p0..p100),
 * interpolating linearly between neighbours. */
export function sampleQuantiles(random, quantiles, fallback = 16) {
  if (!Array.isArray(quantiles) || quantiles.length === 0) return fallback
  if (quantiles.length === 1) return quantiles[0]
  const position = random() * (quantiles.length - 1)
  const low = Math.floor(position)
  const high = Math.min(low + 1, quantiles.length - 1)
  return Math.round(quantiles[low] + (quantiles[high] - quantiles[low]) * (position - low))
}

/** Nearest-rank percentile of numbers (sorted copy). */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

export function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length > 0 ? Math.max(...values) : null,
  }
}

/** Batch size distributions: how many events one request carries.
 * 'client': what the browser scheduler produces for isolated actions with a
 * 2-5 s interval (mostly one or a few events, occasionally a backlog);
 * 'single': one event per request; 'max': full 50-event batches. */
export const BATCH_SIZES = {
  single: () => 1,
  max: () => 50,
  client: random => {
    const bucket = pickWeighted(random, { one: 0.55, few: 0.35, some: 0.09, backlog: 0.01 })
    if (bucket === 'one') return 1
    if (bucket === 'few') return 2 + Math.floor(random() * 4)
    if (bucket === 'some') return 6 + Math.floor(random() * 15)
    return 21 + Math.floor(random() * 30)
  },
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz_ []()←→∀∃ℕ0123456789'

/** Placeholder platform mix until measured: override it with `platform_mix`
 * (and `device_mix`) in a profile once attributes.platform data exists. */
export const DEFAULT_PLATFORM_MIX = Object.freeze({
  chrome: 0.55, safari: 0.2, firefox: 0.07, edge: 0.08, samsung: 0.04, brave: 0.03, opera: 0.01, unknown: 0.02,
})
export const DEFAULT_DEVICE_MIX = Object.freeze({ desktop: 0.6, mobile: 0.4 })

/** The build record release clients send with every event (scripts/sync-lean4game-client.mjs). */
const BUILD = Object.freeze({
  site: '7c6ff788b674', client: 'b3ab1e7ef9bb', runtime: '26391a4ed9c1', nng4: '44a0a02f913e',
  visualtest: 'eec690a6a725', lean: '72a8f89f3126', built: '2026-10-12T21:00:00Z',
})

function syntheticText(random, bytes) {
  let text = ''
  while (Buffer.byteLength(text, 'utf8') < bytes) text += ALPHABET[Math.floor(random() * ALPHABET.length)]
  // Trim to at most `bytes` without splitting a character.
  while (Buffer.byteLength(text, 'utf8') > bytes) text = text.slice(0, -1)
  return text
}

function uuidFrom(random) {
  const bytes = Buffer.alloc(16)
  for (let index = 0; index < 16; index++) bytes[index] = Math.floor(random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Hash of the client content that identity is decided on (docs/protocol.md),
 * recorded in the acknowledgement log so bench/verify.js can compare it. */
export function contentHash(event) {
  const fields = [event.event_type, event.attempt_uuid, event.user_uuid, event.game_id, event.world_id, event.level_id,
    event.mode, event.sequence, event.ts, event.elapsed_ms, event.step_type ?? null, event.command ?? null,
    event.from_line ?? null, event.removed_lines ?? null, event.initial_script ?? null, event.source_attempt_uuid ?? null,
    event.play_script ?? null, event.lean_script ?? null]
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32)
}

/** createWorkload({ seed, players, profile, gameId, hotUserFraction, startTime }).
 * next(count, { playerIndex }) returns up to `count` wire events of one player,
 * continuing its current attempt or starting a new one. */
export function createWorkload({ seed = 1, players = 1000, profile, gameId = 'g/local/NNG4', hotUserFraction = 0,
  startTime = Date.now(), clock = () => Date.now() } = {}) {
  const random = seededRandom(seed)
  const mix = profile?.mode_mix ?? { visual: 0.95, classic: 0.05 }
  const completionRate = profile?.completion_rate ?? 0.6
  const platformMix = profile?.platform_mix ?? DEFAULT_PLATFORM_MIX
  const deviceMix = profile?.device_mix ?? DEFAULT_DEVICE_MIX
  // Each simulated player keeps one browser and device, as a real one does.
  const state = Array.from({ length: players }, () => ({
    userId: uuidFrom(random),
    attempt: null,
    platform: { browser: pickWeighted(random, platformMix), device: pickWeighted(random, deviceMix) },
  }))

  function newAttempt(player) {
    const mode = pickWeighted(random, mix)
    const steps = Math.max(1, sampleQuantiles(random, profile?.steps_per_attempt_with_steps, 8))
    player.attempt = {
      id: uuidFrom(random),
      mode,
      worldId: pickWeighted(random, { Tutorial: 3, Addition: 2, Multiplication: 1, Power: 1 }),
      levelId: 1 + Math.floor(random() * 8),
      plannedSteps: steps,
      sequence: 0,
      started: clock(),
      complete: random() < completionRate,
      done: false,
    }
  }

  function command(attempt) {
    if (attempt.mode === 'classic') {
      const bytes = sampleQuantiles(random, profile?.command_bytes?.classic_edit, 12)
      return { step_type: 'edit', command: syntheticText(random, bytes), from_line: Math.floor(random() * 6), removed_lines: Math.floor(random() * 2) }
    }
    if (random() < (profile?.step_type_mix?.visual_undo ?? 0.18)) return { step_type: 'undo', command: 'undo' }
    return { step_type: 'command', command: syntheticText(random, sampleQuantiles(random, profile?.command_bytes?.visual_command, 20)) }
  }

  function event(player, fields) {
    const attempt = player.attempt
    const now = clock()
    return {
      event_id: uuidFrom(random),
      user_uuid: player.userId,
      attempt_uuid: attempt.id,
      game_id: gameId,
      world_id: attempt.worldId,
      level_id: attempt.levelId,
      mode: attempt.mode,
      elapsed_ms: Math.max(0, Math.round(now - attempt.started)),
      ts: new Date(now).toISOString(),
      build: BUILD,
      platform: player.platform,
      ...fields,
    }
  }

  function nextEvent(player) {
    if (!player.attempt || player.attempt.done) newAttempt(player)
    const attempt = player.attempt
    if (attempt.sequence === 0) {
      attempt.sequence = 1
      const initial = attempt.mode === 'classic'
        ? syntheticText(random, sampleQuantiles(random, profile?.script_bytes?.classic_initial_script, 0)) : undefined
      return event(player, { event_type: 'level_start', sequence: 0, ...(initial !== undefined ? { initial_script: initial } : {}) })
    }
    if (attempt.sequence <= attempt.plannedSteps) {
      return event(player, { event_type: 'proof_step', sequence: attempt.sequence++, ...command(attempt) })
    }
    attempt.done = true
    if (!attempt.complete) return nextEvent(player)
    const scriptBytes = sampleQuantiles(random, profile?.script_bytes?.[`${attempt.mode}_lean_script`], 120)
    return event(player, {
      event_type: 'level_complete',
      sequence: attempt.sequence++,
      ...(attempt.mode === 'visual' ? { play_script: syntheticText(random, Math.max(1, Math.round(scriptBytes / 2))) } : {}),
      lean_script: syntheticText(random, scriptBytes),
    })
  }

  return {
    players: state,
    random,
    /** The player to act next: uniformly random, or the hot user with the
     * configured probability. */
    pickPlayer() {
      return random() < hotUserFraction ? 0 : Math.floor(random() * state.length)
    },
    next(count, { playerIndex = this.pickPlayer() } = {}) {
      const player = state[playerIndex]
      return Array.from({ length: count }, () => nextEvent(player))
    },
    feedback() {
      const player = state[Math.floor(random() * state.length)]
      return {
        report_id: uuidFrom(random),
        ...(random() < 0.7 ? { user_uuid: player.userId } : {}),
        game_id: gameId,
        world_id: 'Tutorial',
        level_id: 1 + Math.floor(random() * 8),
        mode: 'visual',
        message: syntheticText(random, 20 + Math.floor(random() * 200)),
        proof_state: { proofBody: syntheticText(random, 200), activeStreamId: null, streams: [syntheticText(random, 40)] },
        ts: new Date(clock()).toISOString(),
        build: BUILD,
        platform: player.platform,
      }
    },
    startTime,
  }
}
