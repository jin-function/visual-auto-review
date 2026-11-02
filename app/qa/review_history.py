"""Suggest shifted findings without automatically carrying human approval."""


def moved_candidates(findings, previous):
    matched = {finding['id'] for finding in findings}
    used = set()
    result = []
    for finding in findings:
        if any(old['id'] == finding['id'] for old in previous['findings']):
            continue
        selectors = {item['selector'] for item in finding.get('elements', [])}
        if not selectors:
            continue
        candidates = []
        for old in previous['findings']:
            if old['id'] in matched or old['id'] in used or old['kind'] != finding['kind']:
                continue
            if selectors.intersection(item['selector'] for item in old.get('elements', [])):
                distance = abs(old['rect']['y'] - finding['rect']['y']) + abs(old['rect']['x'] - finding['rect']['x'])
                if distance <= 300:
                    candidates.append((distance, old))
        candidates.sort(key=lambda item: item[0])
        if candidates and (len(candidates) == 1 or candidates[0][0] < candidates[1][0]):
            old = candidates[0][1]
            used.add(old['id'])
            result.append({'id': finding['id'], 'previous_id': old['id'], 'previous_review': previous.get('reviews', {}).get(old['id']), 'automatic': False})
    return result
