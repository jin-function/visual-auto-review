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
function escapeValue(value, quote) {
    return value.replace(/\\/g, '\\\\').replace(/["'()\s]/g, character => {
        if (/^[\n\r\f]$/.test(character)) return '\\' + character.charCodeAt(0).toString(16) + ' ';
        return quote ? (character === quote ? '\\' + character : character) : '\\' + character;
    });
}
export function rebaseCSS(text, base, resolve = value => value, preserveSyntax = false) {
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
            const raw = text.slice(position + 1, end - 1), next = importNext ? address(raw) : decodeCSS(raw);
            if (!importNext || (preserveSyntax && next === decodeCSS(raw))) result += text.slice(position, end);
            else if (preserveSyntax) result += character + escapeValue(next, character) + character;
            else result += quoteCSS(next);
            importNext = false; position = end; continue;
        }
        const tail = text.slice(position);
        if (/^@import\b/i.test(tail)) { result += tail.slice(0, 7); position += 7; importNext = true; continue; }
        const match = (!position || !/[\w-]/.test(text[position - 1])) && /^url\s*\(/i.exec(tail);
        if (match) {
            let start = position + match[0].length;
            while (/\s/.test(text[start] || '') && start < text.length) start++;
            let end = start, value, valueStart = start, valueEnd, quote = '';
            if (text[start] === '"' || text[start] === "'") {
                quote = text[start]; end = stringAt(text, start); valueStart = start + 1; valueEnd = end - 1; value = text.slice(valueStart, valueEnd);
                while (/\s/.test(text[end] || '') && end < text.length) end++;
            } else {
                while (end < text.length && text[end] !== ')') { if (text[end] === '\\') end++; end++; }
                valueEnd = end; while (valueEnd > start && /\s/.test(text[valueEnd - 1])) valueEnd--;
                value = text.slice(start, valueEnd);
            }
            if (text[end] === ')') {
                const next = address(value);
                if (preserveSyntax) {
                    result += next === decodeCSS(value) ? text.slice(position, end + 1)
                        : text.slice(position, valueStart) + escapeValue(next, quote) + text.slice(valueEnd, end + 1);
                } else result += `url(${quoteCSS(next)})`;
                position = end + 1; importNext = false; continue;
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
