import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
// index.html is what actually ships: it carries the pre-rendered landing markup
// and loads no script, so App.tsx alone proves nothing about the live page.
const page = await readFile(new URL('../index.html', import.meta.url), 'utf8')

const expectedCopy = [
  'Visual Lean',
  'An experimental graphical user interface for writing Lean code.',
  'Lean verification runs locally on both desktop and mobile through WASM.',
  'Start here: The Visual Natural Numbers Game',
  'Prove the fundamental properties of arithmetic from scratch!',
  'Elevator Pitch',
  "Take a brief tour of Visual Lean's three modes.",
  'The Natural Numbers Game Classic',
  'Play the Natural Numbers Game as it was originally designed, typing Lean code yourself.',
]

test('landing page preserves the supplied copy', () => {
  for (const copy of expectedCopy) assert.ok(app.includes(copy), `missing landing-page copy: ${copy}`)
  assert.match(app, /license info tbd/)
})

test('landing-page destinations point to the three local release experiences', () => {
  for (const href of ['/visualNNG', '/pitch', '/classicNNG']) {
    assert.ok(app.includes(`href: '${href}'`), `component is missing ${href}`)
    assert.ok(page.includes(`href="${href}"`), `shipped page is missing ${href}`)
  }
  for (const source of [app, page]) {
    assert.doesNotMatch(source, /\/lean4game\/index\.html#\/g\/local/u)
  }
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

test('the shipped index.html carries the same copy as the component', () => {
  for (const copy of expectedCopy) {
    assert.ok(page.includes(copy), `missing copy in index.html: ${copy}`)
  }
})

test('credits are a plain heading rather than a scroll prompt', () => {
  for (const source of [app, page]) {
    assert.ok(!source.includes('Scroll down for credits'), 'the scroll prompt is still present')
    assert.ok(!source.includes('credits-prompt'), 'the scroll prompt styles are still referenced')
    assert.match(source, /credits-heading"?>Credits</u)
  }
})

test('each destination keeps its assigned accent in both sources', () => {
  const accents = [
    ['/visualNNG', 'violet'],
    ['/pitch', 'teal'],
    ['/classicNNG', 'blue'],
  ]
  for (const [href, accent] of accents) {
    for (const source of [app, page]) {
      assert.ok(
        source.includes(`destination-${accent}" href="${href}"`) ||
          source.includes(`href: '${href}', accent: '${accent}'`),
        `destination ${href} is not ${accent}`)
    }
  }
})
