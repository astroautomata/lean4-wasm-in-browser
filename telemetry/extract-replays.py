#!/usr/bin/env python3
"""Split a telemetry export (export-telemetry.sh CSV) into one JSON replay per
level attempt.

Usage:
    python extract-replays.py [INPUT_CSV] [OUTPUT_DIR] [options]

Defaults: ../../userdata/out.csv and ../../userdata/replay_viewer/replays
relative to this file.

Options:
    --resume                 keep replays that already exist with identical
                             content instead of rewriting them
    --proof-after MODE       full (default): proof_after on every step, as
                             before; checkpoints: only every N-th and the last
                             step carry proof_after; none: no proof_after
    --checkpoint-every N     interval for --proof-after checkpoints (default 50)
    --max-steps N            attempts with more steps are skipped (default 20000)
    --max-replay-bytes N     bound on an attempt's reconstructed proof text
                             (default 67108864); larger attempts are skipped,
                             or written with checkpoints when --oversize is
                             checkpoints, and marked either way
    --oversize MODE          skip (default) or checkpoints

The export is streamed one pseudonymous user at a time: both export formats
group a user's rows together (older exports by first-seen time, newer ones by
user id). Input whose users are not grouped is refused rather than split
wrongly. Memory is bounded by one user's rows plus a small fixed record per
finished user. index.json keeps its format; its lists follow input order.
manifest.jsonl is written incrementally, one line per attempt.

A replay is written only when its trajectory is complete:
  * it has at least one recorded step and its step sequence numbers are
    contiguous (no lost events);
  * if the attempt reached level_complete (`solved: true`), replaying the
    steps reproduces the final proof. Unsolved attempts have no final proof
    to check against, so a step lost before the first recorded one cannot be
    detected for them; their `validation` says so.
  * the check for solved attempts:
      visual  - every line of the final play_script appears, in order, in the
                replayed command stack (the final script may prune redundant
                steps such as a no-op click_goal, and records
                `refine Exists.intro (x) ?_` as `use x`);
      classic - applying the line edits to initial_script yields lean_script
                exactly. Older clients recorded an empty lean_script; those
                replays are kept (if every edit fits the document) and marked
                "unverified" in their `validation` field.
Attempts that fail a check, are too large or have malformed rows are listed
with the reason in index.json.

Step semantics:
  visual  command  push the command (one interaction; may span several lines
                   when a goal rotation precedes the tactic)
          undo     pop the most recent command. Clients before October 2026
                   also logged a full "reset proof" as a single undo; in that
                   data the two are indistinguishable.
          reset    clear every command (back to the opening position)
          phantom  a `"phantom": true` step was logged but never entered the
                   player's proof (clients before 2026-08-11 logged a click on
                   an already-closed goal this way); it leaves the proof as is
  classic edit     replace `removed_lines` lines starting at `from_line` with
                   the lines of `command` (empty command = pure deletion).
Every step carries `proof_after`, the reconstructed proof after that step
(with --proof-after full).
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_IN = HERE.parent.parent / 'userdata' / 'out.csv'
DEFAULT_OUT = HERE.parent.parent / 'userdata' / 'replay_viewer' / 'replays'

csv.field_size_limit(1 << 30)


class MalformedRow(ValueError):
    pass


def opt_int(value):
    return int(value) if value not in ('', None) else None


def opt_str(value):
    return value if value != '' else None


def split_lines(text):
    return text.split('\n') if text else []


def normalize_visual(line):
    return re.sub(r'^refine Exists\.intro \((.*)\) \?_$', r'use \1', line)


def is_subsequence(needle, haystack):
    it = iter(haystack)
    return all(any(n == h for h in it) for n in needle)


def replay_visual(steps, phantom=frozenset()):
    """Return the command stack after each step, and the final stack as
    (step index, command) pairs. Phantom steps leave the stack unchanged."""
    stack = []
    out = []
    for i, s in enumerate(steps):
        if i in phantom:
            pass
        elif s['type'] == 'undo':
            if stack:
                stack.pop()
        elif s['type'] == 'reset':
            stack.clear()
        else:
            stack.append((i, s['command']))
        out.append([command for _, command in stack])
    return out, stack


def phantom_steps(stack, final):
    """Steps left on the replayed stack that the final proof does not contain.

    Clients before 2026-08-11 logged a click on a goal Lean had already closed
    without adding it to the proof, so the log holds a step the player's proof
    never had. Returns their step indices if skipping them reproduces `final`
    exactly, else None."""
    phantom = set()
    position = 0
    for i, command in stack:
        lines = [normalize_visual(l) for l in command.split('\n')]
        if final[position:position + len(lines)] == lines:
            position += len(lines)
        else:
            phantom.add(i)
    return phantom if position == len(final) else None


def replay_classic(initial, steps):
    """Return the document after each edit, or None if an edit falls outside
    the document (an earlier edit was not recorded)."""
    lines = split_lines(initial)
    out = []
    for s in steps:
        start, removed = s['from_line'], s['removed_lines']
        if start + removed > len(lines):
            return None
        lines[start:start + removed] = split_lines(s['command'])
        out.append('\n'.join(lines))
    return out


def check(attempt, steps):
    """Return (proof_after list, validation, phantom step indices) or
    (None, skip reason, None)."""
    if not steps:
        return None, 'no recorded steps', None
    seqs = [s['sequence'] for s in steps]
    if seqs != list(range(seqs[0], seqs[0] + len(seqs))):
        return None, 'gap in step sequence', None
    if attempt['attempt_completed'] != 't':
        after = replay_visual(steps)[0] if attempt['mode'] == 'visual' \
            else replay_classic(attempt['initial_script'], steps)
        if after is None:
            return None, 'edit outside document (missing earlier edits)', None
        return after, 'unsolved: no final proof to verify against', set()
    if attempt['mode'] == 'visual':
        after, stack = replay_visual(steps)
        replayed = [normalize_visual(l) for cmd in after[-1] for l in cmd.split('\n')]
        final = [normalize_visual(l) for l in split_lines(attempt['play_script'])]
        if not is_subsequence(final, replayed):
            return None, 'replay does not contain final play_script (missing earlier steps)', None
        if final == replayed:
            return after, 'final play_script matches replay', set()
        phantom = phantom_steps(stack, final)
        if phantom:
            return replay_visual(steps, phantom)[0], \
                'final play_script matches replay once phantom steps are skipped', phantom
        return after, 'final play_script is a subsequence of replay', set()
    after = replay_classic(attempt['initial_script'], steps)
    if after is None:
        return None, 'edit outside document (missing earlier edits)', None
    if attempt['lean_script'] == '':
        # Older clients sent an empty lean_script on completion.
        return after, 'unverified: final lean_script not recorded', set()
    if after[-1] != attempt['lean_script']:
        return None, 'replay does not reproduce final lean_script', None
    return after, 'final lean_script matches replay', set()


def step_record(r):
    try:
        return {
            'sequence': int(r['step_sequence']),
            'ts': r['record_ts'],
            'elapsed_ms': opt_int(r['step_elapsed_ms']),
            'type': r['step_type'],
            'command': r['step_command'],
            'from_line': opt_int(r['step_from_line']),
            'removed_lines': opt_int(r['step_removed_lines']),
        }
    except (TypeError, ValueError) as error:
        raise MalformedRow(f'malformed step row: {error}') from None


def proof_size(proof):
    return sum(len(command) for command in proof) if isinstance(proof, list) else len(proof)


class Extractor:
    def __init__(self, src, out_dir, options):
        self.src = src
        self.out_dir = out_dir
        self.options = options
        self.reasons = defaultdict(int)
        self.attempt_total = 0
        self.written = 0
        self.unchanged = 0
        self.finished_users = set()
        self.manifest_path = out_dir / 'manifest.jsonl'
        self.manifest = open(self.manifest_path.with_suffix('.jsonl.partial'), 'w', encoding='utf-8')

    def record(self, entry):
        self.manifest.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def write_atomic(self, path, text):
        data = text.encode('utf-8')
        if self.options.resume and path.exists():
            if hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(data).digest():
                self.unchanged += 1
                return
        temporary = path.with_name(path.name + f'.partial-{os.getpid()}')
        temporary.write_bytes(data)
        os.replace(temporary, path)

    def skip(self, attempt, reason):
        self.reasons[reason] += 1
        self.record({'skipped': {'attempt_id': attempt['attempt_id'], 'game_id': attempt['game_id'],
                                 'world_id': attempt['world_id'], 'level_id': int(attempt['level_id']),
                                 'mode': attempt['mode'], 'reason': reason}})

    def process_user(self, rows):
        """All rows of one user (or the user-less rows): build that user's replays."""
        attempts = {}
        steps = defaultdict(list)
        malformed = {}
        feedback = defaultdict(list)
        users = {}
        for r in rows:
            if r['user_id']:
                users[r['user_id']] = (r['user_first_seen'], r['user_last_seen'])
            kind = r['record_type']
            if kind == 'attempt':
                attempts[r['attempt_id']] = r
            elif kind == 'step':
                if r['attempt_id'] in malformed:
                    continue
                try:
                    steps[r['attempt_id']].append(step_record(r))
                except MalformedRow as error:
                    malformed[r['attempt_id']] = str(error)
                    steps.pop(r['attempt_id'], None)
                    continue
                if len(steps[r['attempt_id']]) > self.options.max_steps:
                    malformed[r['attempt_id']] = f'more than {self.options.max_steps} steps (--max-steps)'
                    steps.pop(r['attempt_id'], None)
            elif kind == 'feedback' and r['user_id']:
                key = (r['user_id'], r['game_id'], r['world_id'], r['level_id'])
                try:
                    feedback[key].append({
                        'report_id': r['record_id'],
                        'ts': r['record_ts'],
                        'mode': r['mode'],
                        'message': r['feedback_message'],
                        'proof_state': json.loads(r['feedback_proof_state']),
                        'attributes': json.loads(r['attributes'] or '{}'),
                    })
                except ValueError:
                    # Malformed historic feedback is reported, never fatal.
                    self.reasons['malformed feedback row (ignored)'] += 1
        for s in steps.values():
            s.sort(key=lambda x: x['sequence'])

        # Number each user's attempts per level and mode chronologically (1 = first try).
        attempt_number = {}
        by_level = defaultdict(list)
        for a in attempts.values():
            by_level[(a['user_id'], a['game_id'], a['world_id'], a['level_id'], a['mode'])].append(a)
        for group in by_level.values():
            group.sort(key=lambda a: a['attempt_started_at'])
            for i, a in enumerate(group, 1):
                attempt_number[a['attempt_id']] = (i, len(group))

        for aid, a in sorted(attempts.items(), key=lambda kv: kv[1]['attempt_started_at']):
            self.attempt_total += 1
            try:
                self.process_attempt(aid, a, steps, malformed, feedback, users, attempt_number)
            except (KeyError, TypeError, ValueError) as error:
                self.skip(a, f'malformed attempt row: {type(error).__name__}')

    def process_attempt(self, aid, a, steps, malformed, feedback, users, attempt_number):
        if aid in malformed:
            self.skip(a, malformed[aid])
            return
        s = steps[aid]
        after, note, phantom = check(a, s)
        if after is None:
            self.skip(a, note)
            return
        size = sum(proof_size(proof) for proof in after)
        mode = self.options.proof_after
        oversize = size > self.options.max_replay_bytes
        if oversize:
            if self.options.oversize != 'checkpoints':
                self.skip(a, 'replay exceeds --max-replay-bytes')
                return
            mode = 'checkpoints'
        visual = a['mode'] == 'visual'
        replay_steps = []
        last = len(s) - 1
        for i, (step, proof) in enumerate(zip(s, after)):
            entry = {'index': i, **step}
            if mode == 'full' or (mode == 'checkpoints' and (i % self.options.checkpoint_every == 0 or i == last)):
                entry['proof_after'] = proof
            if visual:
                del entry['from_line'], entry['removed_lines']
            if i in phantom:
                entry['phantom'] = True
            replay_steps.append(entry)
        number, total = attempt_number[aid]
        first_seen, last_seen = users.get(a['user_id'], (None, None))
        replay = {
            'format': 'lean-game-replay/1',
            'attempt_id': aid,
            'source_attempt_id': opt_str(a['source_attempt_id']),
            'user': {'user_id': a['user_id'], 'first_seen': first_seen, 'last_seen': last_seen},
            'game_id': a['game_id'],
            'world_id': a['world_id'],
            'level_id': int(a['level_id']),
            'mode': a['mode'],
            'solved': a['attempt_completed'] == 't',
            'attempt_number': number,
            'attempts_on_level': total,
            'started_at': a['attempt_started_at'],
            'completed_at': a['attempt_completed_at'],
            'duration_ms': opt_int(a['attempt_duration_ms']),
            'initial_script': a['initial_script'],
            'final_play_script': opt_str(a['play_script']),
            'final_lean_script': a['lean_script'],
            'validation': note,
            'step_counts': {t: sum(1 for x in s if x['type'] == t) for t in sorted({x['type'] for x in s})},
            'steps': replay_steps,
            'feedback': feedback.get((a['user_id'], a['game_id'], a['world_id'], a['level_id']), []),
            'attributes': json.loads(a['attributes'] or '{}'),
        }
        if mode != 'full':
            # Marked so a consumer never mistakes a missing proof_after for an empty proof.
            replay['proof_after_mode'] = mode if mode == 'none' else f'checkpoints every {self.options.checkpoint_every} steps'
        if oversize:
            replay['oversize'] = True
        game = a['game_id'].rsplit('/', 1)[-1]
        name = f"{game}_{a['world_id']}_L{int(a['level_id']):02d}_{a['mode']}_{aid}.json"
        self.write_atomic(self.out_dir / name, json.dumps(replay, indent=2, ensure_ascii=False))
        self.written += 1
        self.record({'written': name})

    def run(self):
        group = []
        current = None
        with open(self.src, encoding='utf-8', newline='') as f:
            for r in csv.DictReader(f):
                user = r.get('user_id') or ''
                if user != current:
                    if group:
                        self.finish_group(current, group)
                    if user in self.finished_users:
                        raise SystemExit(f'error: {self.src} is not grouped by user (user rows reappear); '
                                         'export it with export-telemetry.sh')
                    current, group = user, []
                group.append(r)
            if group:
                self.finish_group(current, group)
        self.manifest.close()
        os.replace(self.manifest_path.with_suffix('.jsonl.partial'), self.manifest_path)
        self.write_index()

    def finish_group(self, user, rows):
        self.process_user(rows)
        # A fixed-size record per finished user, to detect ungrouped input.
        self.finished_users.add(user)

    def write_index(self):
        """index.json in the established format, streamed from manifest.jsonl."""
        index_path = self.out_dir / 'index.json'
        temporary = index_path.with_name('index.json.partial')
        with open(temporary, 'w', encoding='utf-8') as out:
            out.write('{\n  "source": ' + json.dumps(str(self.src), ensure_ascii=False) + ',\n  "written": [')
            first = True
            for line in open(self.manifest_path, encoding='utf-8'):
                entry = json.loads(line)
                if 'written' in entry:
                    out.write(('' if first else ',') + '\n    ' + json.dumps(entry['written'], ensure_ascii=False))
                    first = False
            out.write(('\n  ' if not first else '') + '],\n  "skipped": [')
            first = True
            for line in open(self.manifest_path, encoding='utf-8'):
                entry = json.loads(line)
                if 'skipped' in entry:
                    text = json.dumps(entry['skipped'], indent=2, ensure_ascii=False).replace('\n', '\n    ')
                    out.write(('' if first else ',') + '\n    ' + text)
                    first = False
            summary = {'attempts': self.attempt_total, 'written': self.written, 'skipped': dict(self.reasons)}
            summary_text = json.dumps(summary, indent=2, ensure_ascii=False).replace('\n', '\n  ')
            out.write(('\n  ' if not first else '') + '],\n  "summary": ' + summary_text + '\n}')
        os.replace(temporary, index_path)
        print(json.dumps(summary, indent=2))
        unchanged = f' ({self.unchanged} unchanged)' if self.options.resume else ''
        print(f'Wrote {self.written} replays to {self.out_dir}{unchanged}')


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description='Extract per-attempt replays from a telemetry export.')
    parser.add_argument('input', nargs='?', default=str(DEFAULT_IN))
    parser.add_argument('output', nargs='?', default=str(DEFAULT_OUT))
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--proof-after', choices=['full', 'checkpoints', 'none'], default='full')
    parser.add_argument('--checkpoint-every', type=int, default=50)
    parser.add_argument('--max-steps', type=int, default=20000)
    parser.add_argument('--max-replay-bytes', type=int, default=64 * 1024 * 1024)
    parser.add_argument('--oversize', choices=['skip', 'checkpoints'], default='skip')
    options = parser.parse_args(argv)
    if options.checkpoint_every < 1 or options.max_steps < 1 or options.max_replay_bytes < 1:
        parser.error('limits must be positive')
    return options


def main(argv=None):
    options = parse_arguments(sys.argv[1:] if argv is None else argv)
    src = Path(options.input)
    out_dir = Path(options.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    Extractor(src, out_dir, options).run()


if __name__ == '__main__':
    main()
