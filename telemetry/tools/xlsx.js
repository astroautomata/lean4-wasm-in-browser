import { once } from 'node:events'
import fs from 'node:fs'
import zlib from 'node:zlib'

/** A streaming XLSX writer for the human-readable export (docs/exports.md).
 *
 * Every cell is an inline string with the Text number format, so spreadsheet
 * applications show values such as `=HYPERLINK(...)`, `+1`, `-cmd`, `@sum` or
 * DDE payloads as text and never evaluate them; the stored data is untouched.
 * Rows stream through a deflate stream into a ZIP file with data descriptors,
 * so memory does not grow with the export. Limits are explicit:
 *
 * - a cell holds at most 32767 characters; longer values are cut and end with
 *   a marker naming the machine export, and are counted;
 * - a sheet holds at most 1048576 rows (header included); the export
 *   continues on a new sheet;
 * - the file stays below the classic ZIP 4 GiB limits; a larger export fails
 *   with a message to narrow it with filters. */

export const MAX_CELL_CHARACTERS = 32767
export const MAX_SHEET_ROWS = 1048576
const MAX_ZIP_BYTES = 0xF0000000
const TRUNCATION_MARKER = '… [truncated for the spreadsheet; the machine export (CSV/JSONL) has the full value]'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'

function columnName(index) {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name
  }
  return name
}

/** XML text for a cell value, with OOXML `_xHHHH_` escapes for characters
 * XML 1.0 cannot carry and a character reference for CR (which XML parsers
 * would otherwise normalise to LF). */
export function cellXml(value) {
  // A literal "_xHHHH_" in the data would be decoded as an escape: escape its underscore.
  const text = value.replace(/_(x[0-9A-Fa-f]{4}_)/gu, '_x005F_$1')
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0)
    if (character === '&') out += '&amp;'
    else if (character === '<') out += '&lt;'
    else if (character === '>') out += '&gt;'
    else if (character === '\r') out += '&#13;'
    else if (code === 0x9 || code === 0xA || (code >= 0x20 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || code >= 0x10000) {
      out += character
    } else {
      out += `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`
    }
  }
  return out
}

/** Cut a value to the cell limit without splitting a surrogate pair. */
export function fitCell(value) {
  if (value.length <= MAX_CELL_CHARACTERS) return { text: value, truncated: false }
  let end = MAX_CELL_CHARACTERS - TRUNCATION_MARKER.length
  const code = value.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF) end--
  return { text: value.slice(0, end) + TRUNCATION_MARKER, truncated: true }
}

function sheetName(index) {
  return index === 1 ? 'telemetry' : `telemetry (${index})`
}

class ZipFile {
  constructor(path) {
    this.fd = fs.openSync(path, 'w')
    this.offset = 0
    this.entries = []
  }

  raw(buffer) {
    if (this.offset + buffer.length > MAX_ZIP_BYTES) {
      throw new Error('the spreadsheet would exceed 4 GiB; narrow the export with --since/--until/--game')
    }
    fs.writeSync(this.fd, buffer)
    this.offset += buffer.length
  }

  begin(name) {
    const nameBytes = Buffer.from(name, 'utf8')
    const entry = { name: nameBytes, offset: this.offset, crc: 0, compressed: 0, size: 0 }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0808, 6) // data descriptor + UTF-8 names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0x21, 12) // 1980-01-01: reproducible output
    header.writeUInt16LE(nameBytes.length, 26)
    this.raw(Buffer.concat([header, nameBytes]))
    const deflate = zlib.createDeflateRaw({ level: 6 })
    deflate.on('data', chunk => {
      this.raw(chunk)
      entry.compressed += chunk.length
    })
    let failure = null
    deflate.on('error', error => { failure = error })
    return {
      write: async text => {
        const buffer = Buffer.from(text, 'utf8')
        entry.crc = zlib.crc32(buffer, entry.crc)
        entry.size += buffer.length
        if (entry.size > MAX_ZIP_BYTES) throw new Error('a spreadsheet part would exceed 4 GiB')
        if (!deflate.write(buffer)) await once(deflate, 'drain')
        if (failure) throw failure
      },
      end: async () => {
        const ended = once(deflate, 'end')
        deflate.end()
        await ended
        if (failure) throw failure
        const descriptor = Buffer.alloc(16)
        descriptor.writeUInt32LE(0x08074b50, 0)
        descriptor.writeUInt32LE(entry.crc >>> 0, 4)
        descriptor.writeUInt32LE(entry.compressed, 8)
        descriptor.writeUInt32LE(entry.size, 12)
        this.raw(descriptor)
        this.entries.push(entry)
      },
    }
  }

  async file(name, text) {
    const entry = this.begin(name)
    await entry.write(text)
    await entry.end()
  }

  close() {
    const start = this.offset
    for (const entry of this.entries) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(20, 6)
      header.writeUInt16LE(0x0808, 8)
      header.writeUInt16LE(8, 10)
      header.writeUInt16LE(0, 12)
      header.writeUInt16LE(0x21, 14)
      header.writeUInt32LE(entry.crc >>> 0, 16)
      header.writeUInt32LE(entry.compressed, 20)
      header.writeUInt32LE(entry.size, 24)
      header.writeUInt16LE(entry.name.length, 28)
      header.writeUInt32LE(entry.offset, 42)
      this.raw(Buffer.concat([header, entry.name]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(this.offset - start, 12)
    end.writeUInt32LE(start, 16)
    this.raw(end)
    fs.fsyncSync(this.fd)
    fs.closeSync(this.fd)
  }
}

export class XlsxWriter {
  constructor(path, columns, { maxRowsPerSheet = MAX_SHEET_ROWS } = {}) {
    this.zip = new ZipFile(path)
    this.columns = columns
    this.maxRowsPerSheet = maxRowsPerSheet
    this.sheets = 0
    this.sheet = null
    this.rowInSheet = 0
    this.rows = 0
    this.truncatedCells = 0
    this.buffer = ''
  }

  async startSheet() {
    if (this.sheet) await this.endSheet()
    this.sheets++
    this.sheet = this.zip.begin(`xl/worksheets/sheet${this.sheets}.xml`)
    this.rowInSheet = 0
    await this.sheet.write(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}"><sheetData>`)
    await this.writeRow(this.columns)
  }

  async endSheet() {
    await this.flush()
    await this.sheet.write('</sheetData></worksheet>')
    await this.sheet.end()
    this.sheet = null
  }

  async flush() {
    if (this.buffer) {
      await this.sheet.write(this.buffer)
      this.buffer = ''
    }
  }

  async writeRow(values) {
    const row = ++this.rowInSheet
    let xml = `<row r="${row}">`
    values.forEach((value, index) => {
      if (value === null || value === undefined) return
      const { text, truncated } = fitCell(String(value))
      if (truncated) this.truncatedCells++
      xml += `<c r="${columnName(index)}${row}" t="inlineStr" s="1"><is><t xml:space="preserve">${cellXml(text)}</t></is></c>`
    })
    this.buffer += `${xml}</row>`
    if (this.buffer.length > 1 << 20) await this.flush()
  }

  /** Add one data row (an array of strings or nulls, in column order). */
  async addRow(values) {
    if (!this.sheet || this.rowInSheet >= this.maxRowsPerSheet) await this.startSheet()
    await this.writeRow(values)
    this.rows++
  }

  async close() {
    if (!this.sheet) await this.startSheet()
    await this.endSheet()
    const sheets = Array.from({ length: this.sheets }, (_, index) => index + 1)
    await this.zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>${sheets.map(index =>
        `<sheet name="${sheetName(index)}" sheetId="${index}" r:id="rId${index}"/>`).join('')}</sheets></workbook>`)
    await this.zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="${PKG_REL_NS}">${sheets.map(index =>
        `<Relationship Id="rId${index}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index}.xml"/>`).join('')}` +
      `<Relationship Id="rId${this.sheets + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`)
    // Style 1: number format 49 ("@", Text), so edited cells also stay text.
    await this.zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<styleSheet xmlns="${NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    await this.zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
    await this.zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      `${sheets.map(index => `<Override PartName="/xl/worksheets/sheet${index}.xml" ContentType="${SHEET_TYPE}"/>`).join('')}</Types>`)
    this.zip.close()
    return { sheets: this.sheets, rows: this.rows, truncatedCells: this.truncatedCells }
  }
}
