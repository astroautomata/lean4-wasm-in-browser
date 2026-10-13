import { abortErrorFrom, toHttpError } from './http/errors.js'

/** Optional cross-request microbatching (off unless MICROBATCH_WINDOW_MS > 0).
 *
 * When single-event requests dominate, validated batches from concurrent
 * requests are combined for at most `windowMs` (bounded by `maxEvents` and
 * `maxBytes`) into one writer transaction. Each request still receives only
 * its own outcomes, and only after the shared COMMIT. A retryable failure
 * fails every member (nothing was committed); any other failure retries each
 * member alone, so one request's bad data cannot poison the others. Measure
 * the benefit before enabling it (docs/design.md section 8).
 *
 * submit(events, { bytes, signal }) has the same contract as running
 * `write(events)` through `queue`, which it does when microbatching is off. */
export function createMicrobatcher({ windowMs = 0, maxEvents = 200, maxBytes = 2097152, queue, write, metrics = null }) {
  const runAlone = (events, bytes, signal) =>
    queue.run(jobSignal => write(events, { signal: jobSignal }), { events: events.length, bytes, signal })

  if (!(windowMs > 0)) {
    return { submit: (events, { bytes = 0, signal } = {}) => runAlone(events, bytes, signal), get pending() { return 0 } }
  }

  let group = null

  function flush(target) {
    if (group === target) group = null
    clearTimeout(target.timer)
    const members = target.members.filter(member => !member.done)
    for (const member of members) member.signal?.removeEventListener('abort', member.onAbort)
    if (members.length === 0) return
    metrics?.microbatchRequests.observe(members.length)

    // The shared job is abandoned only when every member has given up.
    const controller = new AbortController()
    let waiting = members.length
    for (const member of members) {
      member.signal?.addEventListener('abort', () => {
        if (--waiting === 0) controller.abort(member.signal.reason)
      }, { once: true })
    }
    const events = members.flatMap(member => member.events)
    const bytes = members.reduce((sum, member) => sum + member.bytes, 0)
    runAlone(events, bytes, controller.signal).then(outcomes => {
      let offset = 0
      for (const member of members) {
        member.resolve(outcomes.slice(offset, offset + member.events.length))
        offset += member.events.length
      }
    }, error => {
      if (members.length === 1 || toHttpError(error).status === 503) {
        for (const member of members) member.reject(error)
        return
      }
      for (const member of members) runAlone(member.events, member.bytes, member.signal).then(member.resolve, member.reject)
    })
  }

  function submit(events, { bytes = 0, signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortErrorFrom(signal))
    if (group && (group.events + events.length > maxEvents || group.bytes + bytes > maxBytes)) flush(group)
    if (!group) {
      const created = { members: [], events: 0, bytes: 0, timer: null }
      created.timer = setTimeout(() => flush(created), windowMs)
      group = created
    }
    const target = group
    return new Promise((resolve, reject) => {
      const member = { events, bytes, signal, resolve, reject, done: false, onAbort: null }
      member.onAbort = () => {
        // Left before the group was written: release it from the group.
        member.done = true
        target.events -= events.length
        target.bytes -= bytes
        reject(abortErrorFrom(signal))
      }
      signal?.addEventListener('abort', member.onAbort, { once: true })
      target.members.push(member)
      target.events += events.length
      target.bytes += bytes
      if (target.events >= maxEvents || target.bytes >= maxBytes) flush(target)
    })
  }

  return {
    submit,
    get pending() {
      return group ? group.members.filter(member => !member.done).length : 0
    },
  }
}
