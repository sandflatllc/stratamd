#!/usr/bin/env python3
"""Paired, sequential Luna low-fast prompt comparison; resume skips recorded jobs."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import random
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parent
CASES = json.loads((ROOT / 'cases.json').read_text())
OUT = ROOT / 'out'
OUT.mkdir(exist_ok=True)
LOG = OUT / 'runs.jsonl'
completed = {r['id'] for r in map(json.loads, LOG.read_text().splitlines())} if LOG.exists() else set()
order = list(range(len(CASES)))
random.Random(907).shuffle(order)
jobs = []
for repeat in (1, 2):
    for position, index in enumerate(order):
        variants = ['baseline', 'revised']
        if (position + repeat) % 2:
            variants.reverse()
        for variant in variants:
            jobs.append((repeat, CASES[index], variant))

for number, (repeat, case, variant) in enumerate(jobs, 1):
    job_id = f'{case["id"]}-{variant}-{repeat}'
    if job_id in completed:
        continue
    prompt = (ROOT / f'{variant}.txt').read_text() + '\n' + case['text']
    result_path = OUT / f'{job_id}.json'
    args = ['codex', 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
            '--model', 'gpt-5.6-luna', '--config', 'model_reasoning_effort="low"',
            '--config', 'service_tier="fast"', '--json',
            '--output-schema', str(ROOT / 'schema.json'),
            '--output-last-message', str(result_path), '-']
    start = time.perf_counter()
    with (OUT / f'{job_id}.stdout.jsonl').open('w') as stdout, (OUT / f'{job_id}.stderr').open('w') as stderr:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                text=True, cwd=ROOT.parent.parent, start_new_session=True)
        timed_out = False
        try:
            proc.communicate(prompt, timeout=60)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
    seconds = time.perf_counter() - start
    record = dict(id=job_id, case=case['id'], variant=variant, repeat=repeat,
                  seconds=seconds, exit=proc.returncode, timed_out=timed_out,
                  at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
                  args=args, cwd=str(ROOT.parent.parent))
    events = []
    for line in (OUT / f'{job_id}.stdout.jsonl').read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    record['usage'] = [e.get('usage') for e in events if e.get('type') == 'turn.completed']
    record['tool_items'] = [e.get('item', {}).get('type') for e in events
                           if e.get('type') == 'item.completed'
                           and e.get('item', {}).get('type') not in ('agent_message', 'reasoning')]
    try:
        result = json.loads(result_path.read_text())
        record['asks'] = len(result['asks'])
    except (OSError, ValueError, KeyError):
        record['asks'] = None
    with LOG.open('a') as log:
        log.write(json.dumps(record) + '\n')
    print(f'{number}/{len(jobs)} {job_id}: {seconds:.2f}s, asks={record["asks"]}, exit={proc.returncode}, tools={record["tool_items"]}', flush=True)
    if proc.returncode != 0:
        print('Stopping on failure; diagnose before continuing.', flush=True)
        break
