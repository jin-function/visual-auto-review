// Keep original text between changed CSS rules. A browser parser is supplied by the exporter.
export function cssRuleRanges(text) {
    const rules = [];
    let position = 0;
    while (position < text.length) {
        if (/\s/.test(text[position])) { position++; continue; }
        if (text.startsWith('/*', position)) { const end = text.indexOf('*/', position + 2); position = end < 0 ? text.length : end + 2; continue; }
        const start = position;
        let braces = 0, parentheses = 0, brackets = 0, quote = '';
        for (; position < text.length; position++) {
            const character = text[position];
            if (character === '\\') { position++; continue; }
            if (quote) { if (character === quote) quote = ''; continue; }
            if (character === '"' || character === "'") { quote = character; continue; }
            if (text.startsWith('/*', position)) { const end = text.indexOf('*/', position + 2); position = end < 0 ? text.length : end + 1; continue; }
            if (character === '(') parentheses++; else if (character === ')') parentheses--;
            if (character === '[') brackets++; else if (character === ']') brackets--;
            if (parentheses || brackets) continue;
            if (character === '{') braces++;
            if (character === '}' && --braces === 0) { position++; break; }
            if (character === ';' && braces === 0) { position++; break; }
        }
        if (position > start) rules.push({start, end: position, text: text.slice(start, position)});
    }
    return rules;
}
function orderedMatches(source, target) {
    const positions = new Map();
    target.forEach((rule, index) => { if (!positions.has(rule)) positions.set(rule, []); positions.get(rule).push(index); });
    const cursors = new Map(), candidates = [];
    source.forEach((rule, index) => {
        if (!rule) return;
        const count = cursors.get(rule) || 0, to = positions.get(rule)?.[count];
        cursors.set(rule, count + 1);
        if (to !== undefined) candidates.push({from: index, to});
    });
    const tails = [], previous = [];
    for (let index = 0; index < candidates.length; index++) {
        let left = 0, right = tails.length;
        while (left < right) { const middle = (left + right) >> 1; if (candidates[tails[middle]].to < candidates[index].to) left = middle + 1; else right = middle; }
        previous[index] = left ? tails[left - 1] : -1; tails[left] = index;
    }
    const matches = [];
    for (let index = tails.at(-1); index !== undefined && index >= 0; index = previous[index]) matches.push(candidates[index]);
    return matches.reverse();
}
function formattedRule(text, source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const indent = /\n([\t ]+)\S/.exec(source)?.[1] || '    ';
    if (!source.includes('\n')) return text;
    let result = '', depth = 0, quote = '', parentheses = 0;
    function line() { result = result.trimEnd() + newline + indent.repeat(depth); }
    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (character === '\\') { result += text.slice(i, i + 2); i++; continue; }
        if (quote) { result += character; if (character === quote) quote = ''; continue; }
        if (character === '"' || character === "'") { quote = character; result += character; continue; }
        if (character === '(') parentheses++; else if (character === ')') parentheses--;
        if (!parentheses && character === '{') { result = result.trimEnd() + ' {'; depth++; line(); }
        else if (!parentheses && character === '}') { depth = Math.max(0, depth - 1); line(); result += '}'; }
        else if (!parentheses && character === ';') { result += ';'; line(); }
        else if (/\s/.test(character) && /[\t \r\n]$/.test(result)) continue;
        else result += character;
    }
    return result.trim();
}
export function mergeStylesheet(source, liveRules, normalize) {
    if (typeof source !== 'string') throw new Error('CSS 원본 소스를 읽지 못했습니다.');
    if (!Array.isArray(liveRules)) return source;
    const ranges = cssRuleRanges(source).map(range => ({...range, key: normalize(range.text)}));
    const valid = ranges.filter(range => range.key);
    const live = liveRules.map(text => ({text, key: normalize(text)})).filter(rule => rule.key);
    const matches = orderedMatches(valid.map(range => range.key), live.map(rule => rule.key));
    const edits = [];
    let before = {from: -1, to: -1};
    for (const after of [...matches, {from: valid.length, to: live.length}]) {
        const removed = valid.slice(before.from + 1, after.from), added = live.slice(before.to + 1, after.to);
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        // Only changed/inserted runtime rules need formatting; authored rules and comments are untouched.
        const replacements = added.map(rule => formattedRule(rule.text, source));
        removed.forEach((range, index) => edits.push({start: range.start, end: range.end, text: replacements[index] || ''}));
        const extra = replacements.slice(removed.length);
        if (extra.length) {
            const at = removed.at(-1)?.end ?? (before.from >= 0 ? valid[before.from].end : valid[after.from]?.start ?? source.length);
            edits.push({start: at, end: at, text: newline + extra.join(newline + newline) + newline});
        }
        before = after;
    }
    let result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    const actual = cssRuleRanges(result).map(range => normalize(range.text)).filter(Boolean);
    if (actual.length !== live.length || actual.some((rule, index) => rule !== live[index].key)) {
        throw new Error('현재 CSS 수정 내용을 원본 서식에 반영하지 못했습니다. 페이지를 유지하고 다시 저장하세요.');
    }
    return result;
}
