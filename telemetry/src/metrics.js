/** A small Prometheus text-format registry with bounded label sets.
 *
 * Labels must come from fixed vocabularies (route names, status classes,
 * reason codes), never from UUIDs, game ids or other client-chosen strings.
 * As a backstop each metric keeps at most `maxSeries` label combinations;
 * further combinations are folded into one series whose labels are all
 * "other", and telemetry_metric_series_overflow_total counts the folds. */

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}

function formatValue(value) {
  if (value === Infinity) return '+Inf'
  if (value === -Infinity) return '-Inf'
  return Number.isNaN(value) ? 'NaN' : String(value)
}

class Metric {
  constructor(registry, type, name, help, labelNames, maxSeries) {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name ${name}`)
    this.registry = registry
    this.type = type
    this.name = name
    this.help = help
    this.labelNames = labelNames
    this.maxSeries = maxSeries
    this.series = new Map()
  }

  key(labels = {}) {
    for (const name of Object.keys(labels)) {
      if (!this.labelNames.includes(name)) throw new Error(`${this.name} has no label ${name}`)
    }
    const values = this.labelNames.map(name => String(labels[name] ?? ''))
    let key = JSON.stringify(values)
    if (!this.series.has(key) && this.series.size >= this.maxSeries) {
      this.registry.overflow.inc({ metric: this.name })
      key = JSON.stringify(this.labelNames.map(() => 'other'))
    }
    return key
  }

  labelText(key, extra = []) {
    const values = JSON.parse(key)
    const pairs = this.labelNames.map((name, index) => `${name}="${escapeLabel(values[index])}"`).concat(extra)
    return pairs.length > 0 ? `{${pairs.join(',')}}` : ''
  }
}

export class Counter extends Metric {
  inc(labels, value = 1) {
    if (!(value >= 0)) throw new Error('counters only increase')
    const key = this.key(labels)
    this.series.set(key, (this.series.get(key) ?? 0) + value)
  }

  get(labels) {
    return this.series.get(JSON.stringify(this.labelNames.map(name => String(labels?.[name] ?? '')))) ?? 0
  }

  render() {
    return [...this.series].map(([key, value]) => `${this.name}${this.labelText(key)} ${formatValue(value)}`)
  }
}

export class Gauge extends Metric {
  set(labels, value) {
    if (typeof labels === 'number') [labels, value] = [undefined, labels]
    this.series.set(this.key(labels), value)
  }

  inc(labels, value = 1) {
    if (typeof labels === 'number') [labels, value] = [undefined, labels]
    const key = this.key(labels)
    this.series.set(key, (this.series.get(key) ?? 0) + value)
  }

  dec(labels, value = 1) {
    if (typeof labels === 'number') [labels, value] = [undefined, labels]
    this.inc(labels, -value)
  }

  get(labels) {
    return this.series.get(JSON.stringify(this.labelNames.map(name => String(labels?.[name] ?? '')))) ?? 0
  }

  render() {
    return [...this.series].map(([key, value]) => `${this.name}${this.labelText(key)} ${formatValue(value)}`)
  }
}

export class Histogram extends Metric {
  constructor(registry, name, help, labelNames, maxSeries, buckets) {
    super(registry, 'histogram', name, help, labelNames, maxSeries)
    this.buckets = [...buckets].sort((left, right) => left - right)
  }

  observe(labels, value) {
    if (typeof labels === 'number') [labels, value] = [undefined, labels]
    const key = this.key(labels)
    let state = this.series.get(key)
    if (!state) {
      state = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }
      this.series.set(key, state)
    }
    for (let index = 0; index < this.buckets.length; index++) {
      if (value <= this.buckets[index]) state.counts[index]++
    }
    state.sum += value
    state.count++
  }

  /** Start a timer; the returned function observes elapsed seconds. */
  startTimer(labels) {
    const started = process.hrtime.bigint()
    return (finalLabels = labels) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9
      this.observe(finalLabels, seconds)
      return seconds
    }
  }

  render() {
    const lines = []
    for (const [key, state] of this.series) {
      this.buckets.forEach((bound, index) => {
        lines.push(`${this.name}_bucket${this.labelText(key, [`le="${formatValue(bound)}"`])} ${state.counts[index]}`)
      })
      lines.push(`${this.name}_bucket${this.labelText(key, ['le="+Inf"'])} ${state.count}`)
      lines.push(`${this.name}_sum${this.labelText(key)} ${formatValue(state.sum)}`)
      lines.push(`${this.name}_count${this.labelText(key)} ${state.count}`)
    }
    return lines
  }
}

export const LATENCY_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15])

export class Registry {
  constructor({ maxSeries = 200 } = {}) {
    this.maxSeries = maxSeries
    this.metrics = new Map()
    this.collectors = []
    this.overflow = new Counter(this, 'counter', 'telemetry_metric_series_overflow_total',
      'Label combinations folded into "other" because a metric reached its series limit.', ['metric'], 1000)
    this.metrics.set(this.overflow.name, this.overflow)
  }

  register(metric) {
    if (this.metrics.has(metric.name)) throw new Error(`metric ${metric.name} already registered`)
    this.metrics.set(metric.name, metric)
    return metric
  }

  counter(name, help, labelNames = [], { maxSeries = this.maxSeries } = {}) {
    return this.register(new Counter(this, 'counter', name, help, labelNames, maxSeries))
  }

  gauge(name, help, labelNames = [], { maxSeries = this.maxSeries } = {}) {
    return this.register(new Gauge(this, 'gauge', name, help, labelNames, maxSeries))
  }

  histogram(name, help, labelNames = [], { buckets = LATENCY_BUCKETS, maxSeries = this.maxSeries } = {}) {
    return this.register(new Histogram(this, name, help, labelNames, maxSeries, buckets))
  }

  /** `collect()` runs before each render, to refresh sampled gauges. */
  onCollect(collect) {
    this.collectors.push(collect)
  }

  async render() {
    for (const collect of this.collectors) {
      try {
        await collect()
      } catch {
        // A failed sampler leaves its gauges at their previous values.
      }
    }
    const lines = []
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help.replaceAll('\n', ' ')}`)
      lines.push(`# TYPE ${metric.name} ${metric.type}`)
      lines.push(...metric.render())
    }
    return `${lines.join('\n')}\n`
  }
}
