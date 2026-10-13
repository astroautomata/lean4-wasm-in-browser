"""extract-replays.py streams the export and keeps its replay format
(docs/exports.md). The previous, load-everything version is the oracle:
both must write byte-identical replays for the same export."""

import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TELEMETRY = Path(__file__).resolve().parents[2]
SCRIPT = TELEMETRY / 'extract-replays.py'
COLUMNS = ['record_type', 'record_id', 'record_ts', 'user_id', 'user_first_seen', 'user_last_seen', 'attempt_id',
           'source_attempt_id', 'game_id', 'world_id', 'level_id', 'mode', 'attempt_started_at',
           'attempt_completed_at', 'attempt_duration_ms', 'attempt_completed', 'step_sequence', 'step_elapsed_ms',
           'step_type', 'step_command', 'step_from_line', 'step_removed_lines', 'initial_script', 'play_script',
           'lean_script', 'feedback_message', 'feedback_proof_state', 'feedback_received_at', 'attributes']


def uid(n):
    return f'00000000-0000-4000-8000-{n:012d}'


class Export:
    def __init__(self):
        self.rows = []
        self.counter = 0

    def next_id(self):
        self.counter += 1
        return uid(self.counter)

    def attempt(self, user, mode, steps, completed=False, play='', lean='', initial='', started='2026-08-04 12:00:00+00',
                world='Tutorial', level=2, attributes='{"build": {"site": "3c14d15a1b2c"}}'):
        attempt_id = self.next_id()
        base = {'user_id': user, 'user_first_seen': '2026-08-01 10:00:00+00', 'user_last_seen': '2026-08-09 10:00:00.5+00',
                'attempt_id': attempt_id, 'game_id': 'g/local/NNG4', 'world_id': world, 'level_id': str(level),
                'mode': mode, 'attempt_started_at': started, 'attempt_completed': 't' if completed else 'f',
                'attempt_completed_at': '2026-08-04 12:05:00+00' if completed else '',
                'attempt_duration_ms': '300000' if completed else ''}
        self.rows.append({**base, 'record_type': 'attempt', 'record_id': attempt_id, 'record_ts': started,
                          'initial_script': initial, 'play_script': play, 'lean_script': lean, 'attributes': attributes})
        for sequence, (kind, command, from_line, removed) in steps:
            self.rows.append({**base, 'record_type': 'step', 'record_id': self.next_id(),
                              'record_ts': f'2026-08-04 12:00:{sequence:02d}.25+00', 'step_sequence': str(sequence),
                              'step_elapsed_ms': str(sequence * 1000), 'step_type': kind, 'step_command': command,
                              'step_from_line': '' if from_line is None else str(from_line),
                              'step_removed_lines': '' if removed is None else str(removed), 'attributes': '{}'})
        return attempt_id

    def feedback(self, user, message, world='Tutorial', level=2):
        self.rows.append({'record_type': 'feedback', 'record_id': self.next_id(), 'record_ts': '2026-08-04 12:06:00+00',
                          'user_id': user, 'user_first_seen': '2026-08-01 10:00:00+00' if user else '',
                          'user_last_seen': '2026-08-09 10:00:00.5+00' if user else '', 'game_id': 'g/local/NNG4',
                          'world_id': world, 'level_id': str(level), 'mode': 'visual', 'feedback_message': message,
                          'feedback_proof_state': '{"proofBody": "intro n", "nested": {"a": [1, 2]}}',
                          'feedback_received_at': '2026-08-04 12:06:01+00', 'attributes': '{}'})

    def write(self, path):
        with open(path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, COLUMNS)
            writer.writeheader()
            for row in self.rows:
                writer.writerow({column: row.get(column, '') for column in COLUMNS})


def sample_export():
    export = Export()
    alice, bob = uid(900001), uid(900002)
    # Visual: solved, phantom step, formula-like and unicode commands.
    export.attempt(alice, 'visual', [(1, ('command', '=HYPERLINK("x")', None, None)), (2, ('command', 'rw [add_zero] ∀ 🎉', None, None)),
                                     (3, ('undo', 'undo', None, None)), (4, ('command', 'rw [add_zero] ∀ 🎉', None, None)),
                                     (5, ('command', 'rfl', None, None))],
                   completed=True, play='=HYPERLINK("x")\nrw [add_zero] ∀ 🎉\nrfl', started='2026-08-04 12:00:00+00')
    export.attempt(alice, 'visual', [(1, ('command', 'intro n', None, None)), (2, ('command', 'click_goal', None, None)),
                                     (3, ('command', 'rfl', None, None))],
                   completed=True, play='intro n\nrfl', started='2026-08-04 12:10:00+00')
    export.attempt(alice, 'visual', [(1, ('command', 'intro n', None, None)), (3, ('command', 'rfl', None, None))],
                   started='2026-08-04 12:20:00+00')  # gap
    export.attempt(alice, 'visual', [], started='2026-08-04 12:30:00+00')  # no steps
    export.feedback(alice, '+cmd|calc')
    # Classic: verified, unverified (old clients) and an edit outside the document.
    export.attempt(bob, 'classic', [(1, ('edit', 'induction n with\n| zero => rfl', 1, 0)), (2, ('edit', '', 0, 1)),
                                    (3, ('edit', '@sum\r\nx', 0, 0))],
                   completed=True, initial='intro n\n', lean='@sum\r\nx\ninduction n with\n| zero => rfl\n', started='2026-08-05 09:00:00+00',
                   world='Addition', level=1)
    export.attempt(bob, 'classic', [(1, ('edit', 'rfl', 0, 0))], completed=True, initial='', lean='',
                   started='2026-08-05 09:10:00+00', world='Addition', level=1)
    export.attempt(bob, 'classic', [(1, ('edit', 'rfl', 5, 1))], initial='a', started='2026-08-05 09:20:00+00')
    export.feedback('', 'anonymous report')
    return export


def run(script, *args):
    return subprocess.run([sys.executable, '-I', str(script), *map(str, args)], capture_output=True, text=True)


class ExtractReplaysTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.original = TELEMETRY / 'test' / 'python' / 'fixtures' / 'extract_replays_original.py'
        if not self.original.exists():
            source = subprocess.run(['git', 'show', 'HEAD:telemetry/extract-replays.py'], cwd=TELEMETRY,
                                    capture_output=True, text=True)
            if source.returncode != 0:
                self.skipTest('the original extract-replays.py is not available from git')
            self.original = self.root / 'original.py'
            self.original.write_text(source.stdout, encoding='utf-8')

    def tearDown(self):
        self.directory.cleanup()

    def outputs(self, directory):
        return {path.name: path.read_bytes() for path in directory.iterdir() if path.name not in ('index.json', 'manifest.jsonl')}

    def test_replays_are_identical_to_the_previous_extractor(self):
        export = self.root / 'export.csv'
        sample_export().write(export)
        old, new = self.root / 'old', self.root / 'new'
        self.assertEqual(run(self.original, export, old).returncode, 0)
        result = run(SCRIPT, export, new)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.outputs(old), self.outputs(new))
        self.assertGreaterEqual(len(self.outputs(new)), 4)
        old_index = json.loads((old / 'index.json').read_text(encoding='utf-8'))
        new_index = json.loads((new / 'index.json').read_text(encoding='utf-8'))
        self.assertEqual(old_index['summary'], new_index['summary'])
        self.assertEqual(sorted(old_index['written']), sorted(new_index['written']))
        key = lambda item: item['attempt_id']
        self.assertEqual(sorted(old_index['skipped'], key=key), sorted(new_index['skipped'], key=key))

    def test_single_user_index_matches_byte_for_byte(self):
        export = Export()
        user = uid(1)
        export.attempt(user, 'visual', [(1, ('command', 'rfl', None, None))], completed=True, play='rfl')
        export.attempt(user, 'visual', [(2, ('command', 'rfl', None, None))], started='2026-08-04 13:00:00+00')
        export.attempt(user, 'visual', [], started='2026-08-04 14:00:00+00')
        path = self.root / 'one.csv'
        export.write(path)
        run(self.original, path, self.root / 'old')
        run(SCRIPT, path, self.root / 'new')
        self.assertEqual((self.root / 'old' / 'index.json').read_text(encoding='utf-8').replace(str(path), 'X'),
                         (self.root / 'new' / 'index.json').read_text(encoding='utf-8').replace(str(path), 'X'))

    def test_malformed_rows_are_reported_per_attempt(self):
        export = sample_export()
        broken = next(row for row in export.rows if row['record_type'] == 'step')
        broken['step_sequence'] = 'seven'
        bad_feedback = next(row for row in export.rows if row['record_type'] == 'feedback')
        bad_feedback['feedback_proof_state'] = '{not json'
        path = self.root / 'broken.csv'
        export.write(path)
        result = run(SCRIPT, path, self.root / 'out')
        self.assertEqual(result.returncode, 0, result.stderr)
        index = json.loads((self.root / 'out' / 'index.json').read_text(encoding='utf-8'))
        reasons = index['summary']['skipped']
        self.assertTrue(any(reason.startswith('malformed step row') for reason in reasons), reasons)
        self.assertEqual(reasons.get('malformed feedback row (ignored)'), 1)

    def test_ungrouped_input_is_refused(self):
        export = sample_export()
        export.rows.append(dict(export.rows[0], record_id=uid(777777), attempt_id=uid(777777)))
        path = self.root / 'ungrouped.csv'
        export.write(path)
        result = run(SCRIPT, path, self.root / 'out')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not grouped by user', result.stderr)

    def test_resume_keeps_identical_replays_and_rewrites_changed_ones(self):
        path = self.root / 'export.csv'
        sample_export().write(path)
        out = self.root / 'out'
        run(SCRIPT, path, out)
        victim = next(iter(sorted(self.outputs(out))))
        (out / victim).write_text('stale', encoding='utf-8')
        result = run(SCRIPT, path, out, '--resume')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('unchanged', result.stdout)
        self.assertNotEqual((out / victim).read_text(encoding='utf-8'), 'stale')

    def test_checkpointed_and_oversize_modes_are_marked(self):
        path = self.root / 'export.csv'
        sample_export().write(path)
        run(SCRIPT, path, self.root / 'checkpoints', '--proof-after', 'checkpoints', '--checkpoint-every', '2')
        replays = [json.loads(p.read_text(encoding='utf-8')) for p in (self.root / 'checkpoints').glob('*_visual_*.json')]
        replay = next(r for r in replays if len(r['steps']) == 5)
        self.assertEqual(replay['proof_after_mode'], 'checkpoints every 2 steps')
        self.assertEqual([('proof_after' in step) for step in replay['steps']], [True, False, True, False, True])
        run(SCRIPT, path, self.root / 'small', '--max-replay-bytes', '10')
        index = json.loads((self.root / 'small' / 'index.json').read_text(encoding='utf-8'))
        self.assertIn('replay exceeds --max-replay-bytes', index['summary']['skipped'])
        run(SCRIPT, path, self.root / 'marked', '--max-replay-bytes', '10', '--oversize', 'checkpoints')
        marked = [json.loads(p.read_text(encoding='utf-8')) for p in (self.root / 'marked').glob('*.json') if p.name != 'index.json']
        oversize = [r for r in marked if r.get('oversize')]
        self.assertTrue(oversize)
        self.assertTrue(all(r['proof_after_mode'].startswith('checkpoints') for r in oversize))


class PlatformTest(unittest.TestCase):
    def test_build_and_platform_reach_the_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export = Export()
            user = uid(42)
            attributes = '{"build": {"site": "3c14d15a1b2c"}, "platform": {"device": "mobile", "browser": "safari"}}'
            export.attempt(user, 'visual', [(1, ('command', 'rfl', None, None))], completed=True, play='rfl', attributes=attributes)
            export.feedback(user, 'feedback from a phone')
            export.rows[-1]['attributes'] = '{"platform": {"device": "mobile", "browser": "safari"}}'
            export.write(root / 'export.csv')
            result = run(SCRIPT, root / 'export.csv', root / 'out')
            self.assertEqual(result.returncode, 0, result.stderr)
            replay = json.loads(next((root / 'out').glob('*_visual_*.json')).read_text(encoding='utf-8'))
            self.assertEqual(replay['attributes']['platform'], {'browser': 'safari', 'device': 'mobile'})
            self.assertEqual(replay['attributes']['build'], {'site': '3c14d15a1b2c'})
            self.assertEqual(replay['feedback'][0]['attributes']['platform'], {'browser': 'safari', 'device': 'mobile'})


if __name__ == '__main__':
    unittest.main()
