function stringAt(text, start) {
    const quote = text[start]; let end = start + 1;
    while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end++] === quote) break;
    }
    return end;
}
export function decodeCSS(value) {
    return value.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|[\n\f\r]|([\s\S]))/g, (_, hex, character) => {
        if (hex) { const code = parseInt(hex, 16); return String.fromCodePoint(code && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? code : 0xfffd); }
        return character || '';
    });
}
function quoteCSS(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '\\a ') + '"'; }
export function rebaseCSS(text, base, resolve = value => value) {
    let result = '', position = 0, importNext = false;
    function address(raw) {
        const value = decodeCSS(raw);
        if (!value || value.startsWith('#') || /^(data|blob):/i.test(value)) return value;
        try { return resolve(new URL(value, base).href); } catch { return value; }
    }
    while (position < text.length) {
        if (text.startsWith('/*', position)) {
            const end = text.indexOf('*/', position + 2);
            const next = end < 0 ? text.length : end + 2;
            result += text.slice(position, next); position = next; continue;
        }
        const character = text[position];
        if (character === '"' || character === "'") {
            const end = stringAt(text, position);
            result += importNext ? quoteCSS(address(text.slice(position + 1, end - 1))) : text.slice(position, end);
            importNext = false; position = end; continue;
        }
        const tail = text.slice(position);
        if (/^@import\b/i.test(tail)) { result += tail.slice(0, 7); position += 7; importNext = true; continue; }
        const match = (!position || !/[\w-]/.test(text[position - 1])) && /^url\s*\(/i.exec(tail);
        if (match) {
            let start = position + match[0].length;
            while (/\s/.test(text[start] || '') && start < text.length) start++;
            let end = start, value;
            if (text[start] === '"' || text[start] === "'") {
                end = stringAt(text, start); value = text.slice(start + 1, end - 1);
                while (/\s/.test(text[end] || '') && end < text.length) end++;
            } else {
                while (end < text.length && text[end] !== ')') { if (text[end] === '\\') end++; end++; }
                value = text.slice(start, end).trim();
            }
            if (text[end] === ')') {
                result += `url(${quoteCSS(address(value))})`; position = end + 1; importNext = false; continue;
            }
        }
        if (!/\s/.test(character)) importNext = false;
        result += character; position++;
    }
    return result;
}
export function rebaseSrcset(value, base) {
    const items = []; let position = 0;
    while (position < value.length) {
        while (/[\s,]/.test(value[position] || '') && position < value.length) position++;
        const start = position;
        while (position < value.length && !/\s/.test(value[position])) position++;
        let url = value.slice(start, position), descriptor = '';
        if (!url) break;
        if (url.endsWith(',')) url = url.replace(/,+$/, '');
        else {
            const descriptorStart = position; let depth = 0;
            while (position < value.length) {
                if (value[position] === '(') depth++;
                if (value[position] === ')') depth--;
                if (value[position] === ',' && depth === 0) break;
                position++;
            }
            descriptor = value.slice(descriptorStart, position).trim(); position++;
        }
        try { url = new URL(url, base).href; } catch { /* Preserve invalid URLs without guessing. */ }
        items.push(url + (descriptor ? ` ${descriptor}` : ''));
    }
    return items.join(', ');
}
