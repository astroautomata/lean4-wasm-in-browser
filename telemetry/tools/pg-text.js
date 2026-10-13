/** PostgreSQL text conventions the CSV machine export has always used (it was
 * produced by `COPY ... TO STDOUT WITH (FORMAT csv)`), reproduced for values
 * that no longer come straight from PostgreSQL, such as steps decoded from
 * trajectory chunks. */

const KEY_ENCODER = new TextEncoder()

function compareJsonbKeys(left, right) {
  // jsonb orders object keys by length in bytes, then bytewise.
  const a = KEY_ENCODER.encode(left)
  const b = KEY_ENCODER.encode(right)
  if (a.length !== b.length) return a.length - b.length
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function jsonbString(value) {
  let text = '"'
  for (const character of value) {
    const code = character.codePointAt(0)
    if (character === '"') text += '\\"'
    else if (character === '\\') text += '\\\\'
    else if (character === '\b') text += '\\b'
    else if (character === '\f') text += '\\f'
    else if (character === '\n') text += '\\n'
    else if (character === '\r') text += '\\r'
    else if (character === '\t') text += '\\t'
    else if (code < 0x20) text += `\\u${code.toString(16).padStart(4, '0')}`
    else text += character
  }
  return `${text}"`
}

/** jsonb's text output for a JSON value: keys in jsonb order, ", " and ": "
 * separators, PostgreSQL's string escaping. Numbers use JSON formatting;
 * jsonb compares 1.0 and 1 as equal, and that is the only difference from
 * PostgreSQL's own output. */
export function jsonbText(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return jsonbString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`
  const keys = Object.keys(value).sort(compareJsonbKeys)
  return `{${keys.map(key => `${jsonbString(key)}: ${jsonbText(value[key])}`).join(', ')}}`
}

/** One CSV field as COPY writes it: NULL is an empty unquoted field; an empty
 * string, or a value containing a comma, quote, CR or LF, or exactly `\.`, is
 * quoted with doubled quotes. Booleans are t/f. */
export function csvField(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 't' : 'f'
  const text = String(value)
  if (text === '' || text === '\\.' || /[",\r\n]/u.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export function csvRow(values) {
  return `${values.map(csvField).join(',')}\n`
}
