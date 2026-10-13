import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseArguments } from '../tools/export.js'
import { csvField, jsonbText } from '../tools/pg-text.js'
import { cellXml, fitCell, MAX_CELL_CHARACTERS, XlsxWriter } from '../tools/xlsx.js'
import { readZip, sheetRows } from './helpers/xlsx.js'

test('jsonb text matches PostgreSQL formatting rules', () => {
  assert.equal(jsonbText({}), '{}')
  assert.equal(jsonbText({ bb: 1, a: [true, null, 'x'], ccc: { z: 'é"\\\n\u0001 ' } }),
    '{"a": [true, null, "x"], "bb": 1, "ccc": {"z": "é\\"\\\\\\n\\u0001 "}}')
  assert.equal(jsonbText({ é: 1, z: 2 }), '{"z": 2, "é": 1}', 'keys order by byte length first')
})

test('CSV fields follow COPY conventions', () => {
  assert.equal(csvField(null), '')
  assert.equal(csvField(''), '""')
  assert.equal(csvField('a,b'), '"a,b"')
  assert.equal(csvField('say "hi"'), '"say ""hi"""')
  assert.equal(csvField('line\nbreak'), '"line\nbreak"')
  assert.equal(csvField('\\.'), '"\\."')
  assert.equal(csvField(true), 't')
  assert.equal(csvField(false), 'f')
  assert.equal(csvField(42), '42')
  assert.equal(csvField('=1+1'), '=1+1', 'the machine export never alters stored text')
})

test('XML cell text escapes markup, CR and characters XML cannot carry', () => {
  assert.equal(cellXml('a<b>&c'), 'a&lt;b&gt;&amp;c')
  assert.equal(cellXml('x\r\ny'), 'x&#13;\ny')
  assert.equal(cellXml('nul\u0000bell\u0007'), 'nul_x0000_bell_x0007_')
  assert.equal(cellXml('_x0041_'), '_x005F_x0041_')
  assert.equal(cellXml('🎉 '), '🎉 ')
})

test('cells over the limit are cut explicitly, never splitting a surrogate pair', () => {
  assert.deepEqual(fitCell('short'), { text: 'short', truncated: false })
  const long = fitCell('🎉'.repeat(MAX_CELL_CHARACTERS))
  assert.equal(long.truncated, true)
  assert.ok(long.text.length <= MAX_CELL_CHARACTERS)
  assert.match(long.text, /machine export/u)
  assert.ok(long.text.isWellFormed())
})

test('the workbook is valid, typed as text and continues on new sheets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-xlsx-'))
  try {
    const file = path.join(directory, 'out.xlsx')
    const writer = new XlsxWriter(file, ['a', 'b'], { maxRowsPerSheet: 3 })
    const values = ['=HYPERLINK("http://example.invalid","x")', '+SUM(1,2)', '-2+3', '@cmd', '\t=1', '\r=1',
      "=cmd|' /C calc'!A0", 'plain', null]
    for (let index = 0; index < values.length; index += 2) await writer.addRow([values[index], values[index + 1] ?? null])
    const summary = await writer.close()
    assert.deepEqual(summary, { sheets: 3, rows: 5, truncatedCells: 0 })
    const entries = readZip(file)
    assert.ok(entries['[Content_Types].xml'].includes('/xl/worksheets/sheet3.xml'))
    assert.ok(entries['xl/styles.xml'].includes('numFmtId="49"'))
    assert.ok(!Object.values(entries).some(xml => /<f>|t="str"|t="n"/u.test(xml)), 'no formulas or numbers')
    const rows = [1, 2, 3].flatMap(index => sheetRows(entries[`xl/worksheets/sheet${index}.xml`]).slice(1))
    // The last row's trailing empty cell is simply absent.
    assert.deepEqual(rows.flat(), values.slice(0, -1))
    for (const index of [1, 2, 3]) assert.deepEqual(sheetRows(entries[`xl/worksheets/sheet${index}.xml`])[0], ['a', 'b'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('export arguments are validated', () => {
  assert.equal(parseArguments([], new Date('2026-10-13T08:00:00Z')).output, './telemetry-export-20261013T080000Z.csv')
  assert.equal(parseArguments(['out.jsonl', '--format', 'jsonl']).output, 'out.jsonl')
  assert.throws(() => parseArguments(['--format', 'ods']), /--format/u)
  assert.throws(() => parseArguments(['--since', 'yesterday']), /--since/u)
  assert.throws(() => parseArguments(['--attempt', 'nope']), /UUID/u)
  assert.throws(() => parseArguments(['--format', 'xlsx', '--resume']), /resume/u)
})
