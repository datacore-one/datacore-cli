#!/usr/bin/env python3
"""Drive `datacore init` through a pty and answer its prompts like a person.

WHY A PTY. The unattended test (--yes) never reaches the questions, so the
naming flow — the whole point of the Chief of Staff step — went unexercised:
the persona file it produced always said "Winston" because that is the
default, not because anything was typed. A pipe will not do either; the CLI
checks process.stdout.isTTY and skips every prompt when it is false, so
piping tests the same silent path again under a different name.

HOW IT ANSWERS. It matches on prompt text rather than replying to a fixed
script of newlines. A positional script silently drifts the moment a question
is added or reordered, and then answers the wrong question confidently —
which is exactly the class of bug this suite exists to catch.

Exit 0 when the typed name and notes reach the persona file on disk.
"""
from __future__ import annotations

import os
import pty
import re
import select
import sys
import time
from pathlib import Path

ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r')

# (pattern to look for, what to type). First match wins; order matters only
# where two prompts could match the same text.
ANSWERS: list[tuple[re.Pattern, str]] = [
    (re.compile(r'Chief of Staff be called', re.I), 'Jarvis'),
    (re.compile(r'^\s*Tone', re.I | re.M),          '2'),
    (re.compile(r'Personality notes', re.I),        'I trade before 10am; never schedule mornings.'),
]
DEFAULT = ''          # Enter — accept whatever the wizard suggests
IDLE_BEFORE_REPLY = 1.2   # seconds of quiet that mean "it is waiting for me"
OVERALL_TIMEOUT = 900


def main() -> int:
    transcript: list[str] = []
    answered: set[int] = set()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp('datacore', ['datacore', 'init'])
        os._exit(127)

    started = time.time()
    pending = ''
    last_output = time.time()
    try:
        while True:
            if time.time() - started > OVERALL_TIMEOUT:
                print('TIMEOUT: init did not finish', file=sys.stderr)
                break
            r, _, _ = select.select([fd], [], [], 0.4)
            if r:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                text = ANSI.sub('', chunk.decode('utf-8', 'replace'))
                transcript.append(text)
                pending += text
                last_output = time.time()
                sys.stdout.write(text)
                sys.stdout.flush()
                continue

            # Quiet for a moment: it is almost certainly waiting on input.
            if time.time() - last_output < IDLE_BEFORE_REPLY:
                continue
            if not pending.strip():
                continue

            reply = DEFAULT
            for i, (pat, value) in enumerate(ANSWERS):
                if i in answered:
                    continue
                if pat.search(pending[-400:]):
                    reply = value
                    answered.add(i)
                    print(f'\n[pty] matched {pat.pattern!r} -> {value!r}\n')
                    break
            try:
                os.write(fd, (reply + '\n').encode())
            except OSError:
                break
            pending = ''
            last_output = time.time()
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    Path('/tmp/init-transcript.txt').write_text(''.join(transcript))

    # ── Assertions: what was TYPED must be what is on disk ──────────────
    persona = Path.home() / 'Data' / '.datacore' / 'personas' / 'winston.md'
    failures = []

    def chk(ok: bool, label: str, detail: str = '') -> None:
        print(f'  {"PASS" if ok else "FAIL"}  {label}' + (f'\n        {detail}' if not ok and detail else ''))
        if not ok:
            failures.append(label)

    print('\n=== ASSERTIONS ===')
    chk(len(answered) == len(ANSWERS), 'every scripted prompt was actually reached',
        f'matched {sorted(answered)} of {len(ANSWERS)} — a prompt was renamed or never shown')
    chk(persona.is_file(), f'persona written at {persona}')
    if persona.is_file():
        body = persona.read_text()
        print(f'--- persona ---\n{body}')
        chk('displayName: Jarvis' in body, 'the TYPED name reached the file, not the default',
            'still the default — the answer never landed')
        chk('Winston' not in body.replace('winston.md', ''), 'no leftover default name in the body')
        chk('trade before 10am' in body, 'the TYPED personality notes reached the file')
        # Menu option "2" is the SECOND entry, i.e. COS_TONES index 1 — "Warm".
        # Asserted against tone 4's wording first and called a correct product
        # wrong; the off-by-one was in the test, which is the easier mistake to
        # make and the harder one to notice when the product output looks fine.
        chk('warm and encouraging' in body.lower(), 'the CHOSEN tone (option 2 = Warm) was applied',
            'got a different tone than the one selected')
        chk('Lead with the answer' not in body, 'tone 1 (the default) was NOT silently used')
        chk(body.lstrip().startswith('---'), 'file still opens with valid frontmatter')
    print(f'---ASSERT-FAIL:{1 if failures else 0}---')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
