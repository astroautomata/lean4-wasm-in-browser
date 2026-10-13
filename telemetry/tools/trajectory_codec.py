#!/usr/bin/env python3
"""Reference decoder for lean-trajectory/1 chunks (docs/trajectory-format.md).

Standard library only, so archives stay readable without the collector code.
It applies the same checks as src/trajectory/codec.js: the payload never
inflates beyond its declared size, the sha256 of the uncompressed bytes must
match, and every row must decode to a valid action.

Usage:
    python3 trajectory_codec.py CHUNK_MANIFEST.json [PAYLOAD.ltj.gz]

prints the decoded actions as JSON lines. The manifest is the archive's
chunk-<id>.json; the payload defaults to its payload_file.
"""

import hashlib
import json
import re
import sys
import zlib
from pathlib import Path

FORMAT = 'lean-trajectory/1'
CODEC = 'gzip'
COLUMNS = ['sequence', 'elapsed_ms', 'step_type', 'command', 'from_line',
           'removed_lines', 'event_id', 'client_ts_us', 'received_at_us', 'attributes']
STEP_TYPES = {0: 'command', 1: 'undo', 2: 'edit', 3: 'reset'}
DEFAULT_LIMITS = {
    'max_events': 2000,
    'max_uncompressed_bytes': 4 * 1024 * 1024,
    'max_compressed_bytes': 4 * 1024 * 1024,
}
INT32_MAX = 2147483647
SAFE_INTEGER = 2 ** 53 - 1
HEX32 = re.compile(r'^[0-9a-f]{32}$')


class TrajectoryFormatError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise TrajectoryFormatError(code, message)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_int32(value, minimum=0):
    return _is_int(value) and minimum <= value <= INT32_MAX


def _is_micros(value):
    return _is_int(value) and -SAFE_INTEGER <= value <= SAFE_INTEGER


def _uuid(hex32):
    return f'{hex32[0:8]}-{hex32[8:12]}-{hex32[12:16]}-{hex32[16:20]}-{hex32[20:32]}'


def _inflate(payload, declared):
    """Gunzip at most `declared` bytes; anything beyond is a bomb or corruption."""
    decompressor = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        output = decompressor.decompress(payload, declared)
        if decompressor.unconsumed_tail:
            _fail('chunk_too_large', 'payload inflates beyond its declared size')
        output += decompressor.flush(1)
    except zlib.error:
        _fail('corrupt_chunk', 'payload is not valid gzip')
    if len(output) > declared:
        _fail('chunk_too_large', 'payload inflates beyond its declared size')
    if not decompressor.eof or decompressor.unused_data:
        _fail('corrupt_chunk', 'payload has trailing or missing data')
    return output


def decode_chunk(payload, manifest, limits=DEFAULT_LIMITS):
    """Decode and verify one chunk. `manifest` uses the archive's field names:
    format, codec, attempt_id, event_count, seq_first, seq_last,
    uncompressed_bytes, checksum_sha256 (hex). Returns a list of action dicts."""
    if manifest.get('format') != FORMAT:
        _fail('unsupported_format', f"unsupported trajectory format {manifest.get('format')}")
    if manifest.get('codec') != CODEC:
        _fail('unsupported_codec', f"unsupported trajectory codec {manifest.get('codec')}")
    if len(payload) > limits['max_compressed_bytes']:
        _fail('chunk_too_large', 'compressed chunk too large')
    declared = manifest.get('uncompressed_bytes')
    if not _is_int32(declared, 1) or declared > limits['max_uncompressed_bytes']:
        _fail('chunk_too_large', 'declared uncompressed size out of bounds')
    count = manifest.get('event_count')
    if not _is_int32(count, 1) or count > limits['max_events']:
        _fail('chunk_too_large', 'declared event count out of bounds')

    raw = _inflate(payload, declared)
    if len(raw) != declared:
        _fail('corrupt_chunk', 'uncompressed length mismatch')
    if hashlib.sha256(raw).hexdigest() != manifest.get('checksum_sha256'):
        _fail('corrupt_chunk', 'checksum mismatch')
    try:
        document = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        _fail('corrupt_chunk', 'payload is not UTF-8 JSON')
    if not isinstance(document, dict) or document.get('format') != FORMAT:
        _fail('corrupt_chunk', 'payload format mismatch')
    if document.get('attempt_id') != manifest.get('attempt_id'):
        _fail('corrupt_chunk', 'payload attempt mismatch')
    rows = document.get('rows')
    if document.get('count') != count or not isinstance(rows, list) or len(rows) != count:
        _fail('corrupt_chunk', 'event count mismatch')
    if document.get('columns') != COLUMNS:
        _fail('corrupt_chunk', 'column list mismatch')
    base = document.get('base')
    if (not isinstance(base, dict) or not _is_int32(base.get('sequence')) or not _is_int32(base.get('elapsed_ms'))
            or not _is_micros(base.get('client_ts_us'))
            or (base.get('received_at_us') is not None and not _is_micros(base.get('received_at_us')))):
        _fail('corrupt_chunk', 'invalid base')

    sequence = base['sequence']
    elapsed = base['elapsed_ms']
    client = base['client_ts_us']
    received = base['received_at_us']
    actions = []
    for index, row in enumerate(rows):
        if not isinstance(row, list) or len(row) != len(COLUMNS):
            _fail('corrupt_chunk', f'row {index} malformed')
        d_sequence, d_elapsed, kind, command, from_line, removed_lines, event_hex, d_client, d_received, attributes = row
        if not _is_int(d_sequence) or (d_sequence != 0 if index == 0 else d_sequence <= 0):
            _fail('corrupt_chunk', f'row {index} sequence')
        if not _is_int(d_elapsed) or not _is_micros(d_client):
            _fail('corrupt_chunk', f'row {index} delta')
        if not _is_int(kind) or kind not in STEP_TYPES or not isinstance(command, str):
            _fail('corrupt_chunk', f'row {index} type or command')
        if not isinstance(event_hex, str) or not HEX32.match(event_hex):
            _fail('corrupt_chunk', f'row {index} event id')
        if not (attributes == 0 and _is_int(attributes)) and not isinstance(attributes, dict):
            _fail('corrupt_chunk', f'row {index} attributes')
        if d_received is not None and (not _is_micros(d_received) or received is None):
            _fail('corrupt_chunk', f'row {index} received delta')
        for value in (from_line, removed_lines):
            if value is not None and not _is_int32(value):
                _fail('corrupt_chunk', f'row {index} edit coordinates')
        sequence += d_sequence
        elapsed += d_elapsed
        client += d_client
        if d_received is not None:
            received += d_received
        if not _is_int32(sequence) or not _is_int32(elapsed) or not _is_micros(client):
            _fail('corrupt_chunk', f'row {index} decodes out of range')
        actions.append({
            'event_id': _uuid(event_hex),
            'sequence': sequence,
            'client_ts_us': client,
            'elapsed_ms': elapsed,
            'step_type': STEP_TYPES[kind],
            'command': command,
            'from_line': from_line,
            'removed_lines': removed_lines,
            'attributes': {} if attributes == 0 else attributes,
            'received_at_us': None if d_received is None else received,
        })
    if actions[0]['sequence'] != manifest.get('seq_first') or actions[-1]['sequence'] != manifest.get('seq_last'):
        _fail('corrupt_chunk', 'sequence range mismatch')
    return actions


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    manifest_path = Path(argv[1])
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    payload_path = Path(argv[2]) if len(argv) == 3 else manifest_path.parent / manifest['payload_file']
    try:
        actions = decode_chunk(payload_path.read_bytes(), manifest)
    except TrajectoryFormatError as error:
        print(f'{error.code}: {error}', file=sys.stderr)
        return 1
    for action in actions:
        # ASCII escapes keep one action per line even for U+2028/U+2029 in commands.
        print(json.dumps(action))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
