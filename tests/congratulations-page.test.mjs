import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateFeedback } from '../telemetry/src/validation.js'

const page = await readFile(new URL('../congratulations.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../src/congratulations.ts', import.meta.url), 'utf8')
const viteConfig = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8')

const expectedCopy = [
  '🎉 Congratulations! 🎉',
  'Thank you for playing!',
  'We hope you enjoyed your time and learned a bit about formal mathematics and Lean.',
  "If you'd like to learn more about Lean, we recommend checking out",
  "Kevin Buzzard's course",
  'Feel free to leave any last feedback below.',
]

test('completion page preserves the supplied copy', () => {
  for (const copy of expectedCopy) {
    assert.ok(page.includes(copy), `missing completion-page copy: ${copy}`)
  }
})

test("Kevin Buzzard's course resolves to a GitHub link", () => {
  const match = /href="(https:\/\/github\.com\/[^"]+)"[^>]*>Kevin Buzzard's course</u.exec(page)
  assert.ok(match, 'the course reference is not a GitHub link')
})

test('the page ships a feedback form wired to the module', () => {
  for (const id of [
    'final-feedback-form',
    'final-feedback-message',
    'final-feedback-count',
    'final-feedback-submit',
    'final-feedback-status',
  ]) {
    assert.ok(page.includes(`id="${id}"`), `missing feedback element: ${id}`)
  }
  assert.match(page, /<script type="module" src="\/src\/congratulations\.ts">/u)
  // Matches the collector's own message ceiling.
  assert.match(page, /maxlength="1000"/u)
})

test('the completion page is a real build entry, so its URL is static', () => {
  assert.match(viteConfig, /congratulations: resolve\(/u)
  assert.match(viteConfig, /'congratulations\.html'/u)
})

test('feedback posts to the shared collector under a reserved world', () => {
  assert.match(script, /\/v1\/feedback/u)
  assert.match(script, /world_id: 'Ending'/u)
  assert.match(script, /level_id: 0/u)
  assert.match(script, /game_id: 'g\/local\/NNG4'/u)
})

test('an anonymous report is only identified once telemetry was accepted', () => {
  // The in-level form sends regardless of consent and attaches the id only when
  // the player opted in; the completion page must not diverge from that.
  assert.match(script, /localStorage\.getItem\(CONSENT_KEY\) !== 'accepted'/u)
  assert.match(script, /\.\.\.\(userId \? \{ user_uuid: userId \} : \{\}\)/u)
})

/** Rebuild the exact body the page sends, then run the collector's validator. */
function completionReport(overrides = {}) {
  return {
    report_id: '3f1a6c52-9d4e-4a7b-8c21-5e0b7d9f4a13',
    game_id: 'g/local/NNG4',
    world_id: 'Ending',
    level_id: 0,
    mode: 'visual',
    message: 'Loved it, thank you!',
    proof_state: { source: 'congratulations-page' },
    ts: new Date().toISOString(),
    ...overrides,
  }
}

test('the collector accepts the completion report shape', () => {
  const accepted = validateFeedback(completionReport())
  assert.ok(accepted, 'the collector rejected the completion page payload')
  assert.equal(accepted.worldId, 'Ending')
  assert.equal(accepted.levelId, 0)
  assert.equal(accepted.gameId, 'g/local/NNG4')
  assert.equal(accepted.mode, 'visual')
  assert.equal(accepted.userId, null)
})

test('an opted-in report keeps its anonymous id', () => {
  const accepted = validateFeedback(
    completionReport({ user_uuid: 'a1b2c3d4-1111-4222-8333-444455556666' }))
  assert.ok(accepted)
  assert.equal(accepted.userId, 'a1b2c3d4-1111-4222-8333-444455556666')
})

test('the reserved world stays distinguishable from real level reports', () => {
  const fromLevel = validateFeedback(completionReport({ world_id: 'Addition', level_id: 1 }))
  const fromEnding = validateFeedback(completionReport())
  assert.ok(fromLevel && fromEnding)
  assert.notEqual(fromLevel.worldId, fromEnding.worldId)
})
