#!/usr/bin/env python3
"""One-to-one anchor scoring plus explicitly recorded manual semantic review."""
import json
import re
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent
cases = {c['id']: c for c in json.loads((ROOT / 'cases.json').read_text())}
runs = [json.loads(line) for line in (ROOT / 'out/runs.jsonl').read_text().splitlines()]
manual_path = ROOT / 'manual-review.json'
manual = json.loads(manual_path.read_text()) if manual_path.exists() else {}

def norm(text):
    return re.sub(r'\s+', ' ', text.translate(str.maketrans('“”‘’', '\"\"\'\''))).strip()

def span(source, quote):
    start = source.find(quote)
    return (start, start + len(quote)) if start >= 0 and quote else None

def overlap(a, b):
    return a is not None and b is not None and a[0] < b[1] and b[0] < a[1]

report = []
for run in runs:
    case = cases[run['case']]
    source = norm(case['text'])
    result_path = ROOT / 'out' / (run['id'] + '.json')
    asks = json.loads(result_path.read_text())['asks'] if result_path.exists() else []
    targets = case['expected']
    matched = set()
    details = []
    for index, ask in enumerate(asks):
        location = span(source, norm(ask['quote']))
        candidates = [target['id'] for target in targets
                      if overlap(location, span(source, norm(target['anchor'])))]
        match = next((candidate for candidate in candidates if candidate not in matched), None)
        review = manual.get(run['id'], {}).get(str(index), {})
        if 'target' in review:
            match = review['target']
            if match is not None and match not in {target['id'] for target in targets}:
                raise ValueError(f'Unknown manually assigned target: {match}')
            if match in matched:
                match = None
        if match:
            matched.add(match)
        details.append(dict(**ask, target=match, candidate_targets=candidates,
                            exact_verbatim=bool(ask['quote']) and ask['quote'] in case['text'],
                            normalized_verbatim=location is not None,
                            question_words=len(ask['question'].split()), manual_review=review))
    report.append(dict(**run, expected=len(targets), hits=len(matched),
                       misses=[target['id'] for target in targets if target['id'] not in matched],
                       extras=len(asks)-len(matched), rows=details))

(ROOT / 'scored.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
summary = {}
for variant in ('baseline', 'revised'):
    rows = [r for r in report if r['variant'] == variant]
    seconds = [r['seconds'] for r in rows]
    hits = sum(r['hits'] for r in rows)
    expected = sum(r['expected'] for r in rows)
    returned = sum(len(r['rows']) for r in rows)
    summary[variant] = dict(calls=len(rows), hits=hits, expected=expected,
        extras=sum(r['extras'] for r in rows), misses=expected-hits,
        precision=hits/returned if returned else 1, recall=hits/expected if expected else 1,
        exact_set=sum(not r['misses'] and not r['extras'] for r in rows),
        invalid_quotes=sum(not ask['normalized_verbatim'] for r in rows for ask in r['rows']),
        median=statistics.median(seconds) if seconds else None,
        mean=statistics.mean(seconds) if seconds else None,
        max=max(seconds) if seconds else None,
        failures=sum(r['exit'] != 0 or r['asks'] is None for r in rows))
by_key = {(r['case'], r['repeat'], r['variant']): r for r in report}
pairs = []
for r in report:
    if r['variant'] != 'baseline':
        continue
    revised = by_key.get((r['case'], r['repeat'], 'revised'))
    if revised:
        pairs.append(dict(case=r['case'], repeat=r['repeat'], baseline=r['seconds'],
                          revised=revised['seconds'], delta=revised['seconds']-r['seconds']))
summary['pairs'] = pairs
if pairs:
    summary['paired_mean_delta'] = statistics.mean(p['delta'] for p in pairs)
    summary['paired_median_delta'] = statistics.median(p['delta'] for p in pairs)
    summary['revised_faster_pairs'] = sum(p['delta'] < 0 for p in pairs)
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k:v for k,v in summary.items() if k != 'pairs'}, indent=2))
for r in report:
    if r['extras'] or r['misses']:
        print(r['id'], 'extras', r['extras'], 'misses', r['misses'])
