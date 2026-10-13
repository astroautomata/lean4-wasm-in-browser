"""The Python reference decoder agrees with the JavaScript encoder
(tools/trajectory_codec.py, src/trajectory/codec.js)."""

import gzip
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TELEMETRY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(TELEMETRY / 'tools'))

import trajectory_codec  # noqa: E402

ENCODE = """
import { encodeChunk } from './src/trajectory/codec.js'
const input = JSON.parse(await new Promise(resolve => { let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => resolve(s)) }))
const chunk = encodeChunk(input)
process.stdout.write(JSON.stringify({
  manifest: { format: chunk.format, codec: chunk.codec, attempt_id: input.attemptId, event_count: chunk.eventCount,
    seq_first: chunk.seqFirst, seq_last: chunk.seqLast, uncompressed_bytes: chunk.uncompressedBytes,
    checksum_sha256: chunk.checksum.toString('hex') },
  payload: chunk.payload.toString('base64'),
}))
"""

ATTEMPT = '505300ff-0847-48eb-994b-7e834f938c4e'
ACTIONS = [
    {'eventId': 'd707e185-136e-4f54-bca8-e1aaffbbe396', 'sequence': 1, 'clientTsUs': 1786017600123000, 'elapsedMs': 1234,
     'stepType': 'command', 'command': 'rw [add_zero]', 'fromLine': None, 'removedLines': None, 'attributes': {},
     'receivedAtUs': 1786017600456789},
    {'eventId': '0b8c7b52-31a4-4c55-9d43-6b0f2b7f7c11', 'sequence': 2, 'clientTsUs': 1786017599000001, 'elapsedMs': 900,
     'stepType': 'undo', 'command': 'undo', 'fromLine': None, 'removedLines': None, 'attributes': {}, 'receivedAtUs': None},
    {'eventId': '9d1f7a56-7fd2-4f0a-8f6c-0b1d2e3f4a5b', 'sequence': 5, 'clientTsUs': 1786017601000000, 'elapsedMs': 4000,
     'stepType': 'edit', 'command': 'induction n with\n| zero => rfl \U0001F389 ', 'fromLine': 3, 'removedLines': 0,
     'attributes': {'phantom': True, 'nested': {'b': [1, 'x'], 'a': None}}, 'receivedAtUs': 1786017601000000},
    {'eventId': '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5', 'sequence': 6, 'clientTsUs': 1786017601000002, 'elapsedMs': 4100,
     'stepType': 'reset', 'command': '', 'fromLine': None, 'removedLines': None, 'attributes': {},
     'receivedAtUs': 1786017600999999},
]


def encode(actions):
    result = subprocess.run(['node', '--input-type=module', '-e', ENCODE], cwd=TELEMETRY, check=True,
                            input=json.dumps({'attemptId': ATTEMPT, 'actions': actions}).encode('utf-8'),
                            capture_output=True)
    document = json.loads(result.stdout)
    import base64
    return document['manifest'], base64.b64decode(document['payload'])


def as_python(action):
    return {
        'event_id': action['eventId'], 'sequence': action['sequence'], 'client_ts_us': action['clientTsUs'],
        'elapsed_ms': action['elapsedMs'], 'step_type': action['stepType'], 'command': action['command'],
        'from_line': action['fromLine'], 'removed_lines': action['removedLines'], 'attributes': action['attributes'],
        'received_at_us': action['receivedAtUs'],
    }


class DecoderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest, cls.payload = encode(ACTIONS)

    def test_decodes_what_javascript_encodes(self):
        decoded = trajectory_codec.decode_chunk(self.payload, self.manifest)
        self.assertEqual(decoded, [as_python(action) for action in ACTIONS])

    def test_rejects_manifest_mismatches(self):
        for key, value in [('event_count', 3), ('seq_last', 7), ('attempt_id', 'a4ac71f1-54c6-40df-89f7-b5062bf71d60'),
                           ('checksum_sha256', '0' * 64), ('format', 'lean-trajectory/2'), ('codec', 'zstd')]:
            with self.subTest(key=key):
                with self.assertRaises(trajectory_codec.TrajectoryFormatError):
                    trajectory_codec.decode_chunk(self.payload, {**self.manifest, key: value})

    def test_rejects_corruption(self):
        corrupt = bytearray(self.payload)
        corrupt[len(corrupt) // 2] ^= 0xFF
        with self.assertRaises(trajectory_codec.TrajectoryFormatError):
            trajectory_codec.decode_chunk(bytes(corrupt), self.manifest)
        with self.assertRaises(trajectory_codec.TrajectoryFormatError):
            trajectory_codec.decode_chunk(b'not gzip', self.manifest)

    def test_never_inflates_past_the_declared_size(self):
        bomb = gzip.compress(b'\0' * (64 * 1024 * 1024))
        with self.assertRaises(trajectory_codec.TrajectoryFormatError) as raised:
            trajectory_codec.decode_chunk(bomb, {**self.manifest, 'uncompressed_bytes': 1024})
        self.assertEqual(raised.exception.code, 'chunk_too_large')
        with self.assertRaises(trajectory_codec.TrajectoryFormatError):
            trajectory_codec.decode_chunk(bomb, {**self.manifest, 'uncompressed_bytes': 64 * 1024 * 1024})

    def test_command_line_prints_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / 'chunk-1.json'
            (Path(directory) / 'chunk-1.ltj.gz').write_bytes(self.payload)
            manifest_path.write_text(json.dumps({**self.manifest, 'payload_file': 'chunk-1.ltj.gz'}), encoding='utf-8')
            result = subprocess.run([sys.executable, '-I', str(TELEMETRY / 'tools' / 'trajectory_codec.py'), str(manifest_path)],
                                    check=True, capture_output=True, text=True)
            lines = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(lines, [as_python(action) for action in ACTIONS])


if __name__ == '__main__':
    unittest.main()
