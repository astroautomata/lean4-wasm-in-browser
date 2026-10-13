import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'

/** Minimal readers for workbooks written by tools/xlsx.js, for tests. */

/** Read a ZIP produced by XlsxWriter through its central directory. */
export function readZip(file) {
  const data = fs.readFileSync(file)
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = data.readUInt16LE(end + 10)
  let offset = data.readUInt32LE(end + 16)
  const entries = {}
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50)
    const compressed = data.readUInt32LE(offset + 20)
    const size = data.readUInt32LE(offset + 24)
    const crc = data.readUInt32LE(offset + 16)
    const nameLength = data.readUInt16LE(offset + 28)
    const local = data.readUInt32LE(offset + 42)
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const content = zlib.inflateRawSync(data.subarray(start, start + compressed))
    assert.equal(content.length, size, name)
    assert.equal(zlib.crc32(content) >>> 0, crc, name)
    entries[name] = content.toString('utf8')
    offset += 46 + nameLength
  }
  return entries
}

/** Cells of a sheet as arrays of decoded strings (null for absent cells). */
export function sheetRows(xml) {
  const rows = []
  for (const row of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gsu)) {
    const cells = []
    for (const cell of row[2].matchAll(/<c r="([A-Z]+)\d+" t="inlineStr" s="1"><is><t xml:space="preserve">(.*?)<\/t><\/is><\/c>/gsu)) {
      let column = 0
      for (const letter of cell[1]) column = column * 26 + letter.charCodeAt(0) - 64
      cells[column - 1] = cell[2].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#13;', '\r')
        .replace(/_x([0-9A-F]{4})_/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replaceAll('&amp;', '&')
    }
    rows.push(Array.from(cells, value => value ?? null))
  }
  return rows
}
