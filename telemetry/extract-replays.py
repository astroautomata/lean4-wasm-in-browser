#!/usr/bin/env python3
"""Split a telemetry export (export-telemetry.sh CSV) into one JSON replay per
completed level attempt.

Usage:
    python extract-replays.py [INPUT_CSV] [OUTPUT_DIR]

Defaults: ../../userdata/out.csv and ../../userdata/replay_viewer/replays
relative to this file.

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
Attempts that fail a check are listed with the reason in index.json.

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
Every step carries `proof_after`, the reconstructed proof after that step.
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_IN = HERE.parent.parent / 'userdata' / 'out.csv'
DEFAULT_OUT = HERE.parent.parent / 'userdata' / 'replay_viewer' / 'replays'

csv.field_size_limit(1 << 30)


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


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IN
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(src, encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))

    attempts = {r['attempt_id']: r for r in rows if r['record_type'] == 'attempt'}
    steps = defaultdict(list)
    feedback = defaultdict(list)
    users = {}
    for r in rows:
        if r['user_id']:
            users[r['user_id']] = (r['user_first_seen'], r['user_last_seen'])
        if r['record_type'] == 'step':
            steps[r['attempt_id']].append({
                'sequence': int(r['step_sequence']),
                'ts': r['record_ts'],
                'elapsed_ms': opt_int(r['step_elapsed_ms']),
                'type': r['step_type'],
                'command': r['step_command'],
                'from_line': opt_int(r['step_from_line']),
                'removed_lines': opt_int(r['step_removed_lines']),
            })
        elif r['record_type'] == 'feedback' and r['user_id']:
            key = (r['user_id'], r['game_id'], r['world_id'], r['level_id'])
            feedback[key].append({
                'report_id': r['record_id'],
                'ts': r['record_ts'],
                'mode': r['mode'],
                'message': r['feedback_message'],
                'proof_state': json.loads(r['feedback_proof_state']),
                'attributes': json.loads(r['attributes'] or '{}'),
            })
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

    index = {'source': str(src), 'written': [], 'skipped': []}
    for aid, a in sorted(attempts.items(), key=lambda kv: kv[1]['attempt_started_at']):
        s = steps[aid]
        after, note, phantom = check(a, s)
        if after is None:
            index['skipped'].append({'attempt_id': aid, 'game_id': a['game_id'], 'world_id': a['world_id'],
                                     'level_id': int(a['level_id']), 'mode': a['mode'], 'reason': note})
            continue
        visual = a['mode'] == 'visual'
        replay_steps = []
        for i, (step, proof) in enumerate(zip(s, after)):
            entry = {'index': i, **step, 'proof_after': proof}
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
        game = a['game_id'].rsplit('/', 1)[-1]
        name = f"{game}_{a['world_id']}_L{int(a['level_id']):02d}_{a['mode']}_{aid}.json"
        (out_dir / name).write_text(json.dumps(replay, indent=2, ensure_ascii=False), encoding='utf-8')
        index['written'].append(name)

    reasons = defaultdict(int)
    for x in index['skipped']:
        reasons[x['reason']] += 1
    index['summary'] = {'attempts': len(attempts), 'written': len(index['written']), 'skipped': dict(reasons)}
    (out_dir / 'index.json').write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(index['summary'], indent=2))
    print(f'Wrote {len(index["written"])} replays to {out_dir}')


if __name__ == '__main__':
    main()
