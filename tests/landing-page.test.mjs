import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

const expectedCopy = [
  'Visual Lean',
  'An experimental graphical user interface for writing Lean code.',
  'Lean verification runs locally on both desktop and mobile.',
  'Start here: The Visual Natural Numbers Game',
  'Formally prove the foundational properties of arithmetic!',
  'Elevator Pitch',
  "Take a brief tour of Visual Lean's three modes.",
  'The Natural Numbers Game Classic',
  'Play the Natural Numbers Game as it was originally designed, typing Lean code yourself.',
  'Scroll down for credits VVV',
  'Visual Lean was coded with the help of Codex and Claude Code.',
]

test('landing page preserves the supplied copy', () => {
  for (const copy of expectedCopy) assert.ok(app.includes(copy), `missing landing-page copy: ${copy}`)
  assert.match(app, /license info tbd/)
})

test('landing-page destinations point to the three local release experiences', () => {
  assert.match(app, /\/g\/local\/NNG4\/visual/)
  assert.match(app, /\/g\/local\/VisualTest\/visual/)
  assert.match(app, /\/g\/local\/NNG4'/)
})

test('credit placeholders are resolved as links', () => {
  for (const url of [
    'https://autumnofautumn.com/',
    'https://gowers.wordpress.com/',
    'https://astroautomata.com/',
    'https://www.damtp.cam.ac.uk/user/mjc249/home.html',
    'https://github.com/cauli/lean4-wasm-in-browser',
    'https://github.com/ryyanmapes/lean4game',
  ]) assert.ok(app.includes(`href="${url}"`), `missing credit link: ${url}`)
})
