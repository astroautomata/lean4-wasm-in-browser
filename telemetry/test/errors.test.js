import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AbortError, connectionUnusable, databaseErrorClass, describeError, HttpError, OverloadError, toHttpError,
  transientConflict,
} from '../src/http/errors.js'

const pgError = (code, message = 'server says: value "secret proof" rejected') => Object.assign(new Error(message), { code })

test('classifies PostgreSQL and connection failures into bounded classes', () => {
  const cases = [
    [pgError('08006'), 'connection'], [pgError('57P01'), 'shutdown'], [pgError('57P03'), 'shutdown'],
    [pgError('57014'), 'statement_timeout'], [pgError('55P03'), 'lock_timeout'], [pgError('25P03'), 'idle_in_transaction'],
    [pgError('40P01'), 'deadlock'], [pgError('40001'), 'serialization'], [pgError('53300'), 'resources'],
    [pgError('23505'), 'race'], [pgError('22021'), 'data'], [pgError('22P02'), 'data'], [pgError('42P01'), 'other'],
    [Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), 'connection'],
    [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'connection'],
    [new Error('timeout exceeded when trying to connect'), 'pool_timeout'],
    [new Error('Query read timeout'), 'query_timeout'],
    [new Error('Connection terminated unexpectedly'), 'connection'],
    [new Error('Client has encountered a connection error and is not queryable'), 'connection'],
    [Object.assign(new Error('x'), { name: 'ChunkUnavailableError' }), 'chunk'],
    [new TypeError('bug'), 'other'],
  ]
  for (const [error, expected] of cases) assert.equal(databaseErrorClass(error), expected, `${error.code ?? error.message}`)
})

test('maps failures to statuses: retryable 503, data 400, unexpected 500', () => {
  for (const code of ['08006', '57P01', '57014', '55P03', '40P01', '40001', '25P03', '53300']) {
    const answer = toHttpError(pgError(code))
    assert.equal(answer.status, 503, code)
    assert.equal(answer.code, 'db_unavailable')
    assert.ok(answer.retryAfter >= 1)
  }
  assert.equal(toHttpError(new Error('timeout exceeded when trying to connect')).status, 503)
  assert.equal(toHttpError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).status, 503)
  assert.deepEqual([toHttpError(pgError('22021')).status, toHttpError(pgError('22021')).code], [400, 'invalid_event'])
  assert.equal(toHttpError(new TypeError('bug')).status, 500)
  assert.equal(toHttpError(new TypeError('bug')).retryAfter, null)
  assert.equal(toHttpError(new AbortError('deadline')).status, 503)
  assert.equal(toHttpError(new AbortError('deadline')).code, 'deadline')
  const overload = new OverloadError('queue_full')
  assert.equal(toHttpError(overload), overload)
  assert.equal(overload.status, 503)
  const http = new HttpError(413, 'body_too_large')
  assert.equal(toHttpError(http), http)
})

test('marks connections with uncertain state unusable and conflicts as retryable once', () => {
  assert.equal(connectionUnusable(new Error('Query read timeout')), true)
  assert.equal(connectionUnusable(pgError('57P01')), true)
  assert.equal(connectionUnusable(new Error('Connection terminated unexpectedly')), true)
  assert.equal(connectionUnusable(pgError('55P03')), false)
  assert.equal(connectionUnusable(pgError('57014')), false)
  assert.equal(transientConflict(pgError('40P01')), true)
  assert.equal(transientConflict(pgError('23505')), true)
  assert.equal(transientConflict(pgError('55P03')), false)
})

test('describes errors without their messages, which may quote submitted values', () => {
  const text = describeError(pgError('22021'))
  assert.match(text, /22021/u)
  assert.doesNotMatch(text, /secret|proof/u)
})
