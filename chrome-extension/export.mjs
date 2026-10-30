import {safeFilename, samePage} from './core.mjs';
import {rebaseCSS, rebaseSrcset} from './css.mjs';
import {snapshotPage} from './snapshot.mjs';
import {zipFiles} from './zip.mjs';
import {stripTooling} from './sanitize.mjs';
import {originalFilename, stylesheetPaths, relativePath} from './export-paths.mjs';
import {mergeStylesheet} from './css-source.mjs';

export function evaluate(expression) {
    return new Promise((resolve, reject) => chrome.devtools.inspectedWindow.eval(expression, (value, error) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (error) reject(new Error(error.description || error.value || '페이지 정보를 읽지 못했습니다.'));
        else resolve(value);
    }));
}
function resources() {
    return new Promise(resolve => chrome.devtools.inspectedWindow.getResources(resolve));
}
function networkStyles() {
    return new Promise(resolve => chrome.devtools.network.getHAR(har => resolve(new Set(
        (har?.entries || []).filter(entry => /^text\/css\b/i.test(entry.response?.content?.mimeType || '')).map(entry => entry.request.url)))));
}
function resourceContent(resource) {
    return new Promise(resolve => resource.getContent((content, encoding) => {
        const error = chrome.runtime.lastError;
        resolve(error || encoding ? null : content);
    }));
}
export async function collectExport() {
    if (!Number.isInteger(chrome.devtools?.inspectedWindow?.tabId)) throw new Error('Chrome 개발자도구의 시안 검수 탭에서 내보내세요.');
    const options = {extensionOrigin: chrome.runtime.getURL('')};
    const snapshot = await evaluate(`(${snapshotPage.toString()})(${JSON.stringify(options)}, ${stripTooling.toString()})`);
    const known = new Set(snapshot.sheets.map(sheet => sheet.url));
    const network = await networkStyles();
    const excluded = new Set(snapshot.excludedStyles);
    const list = (await resources()).filter(resource => !excluded.has(resource.url) && (known.has(resource.url) || network.has(resource.url) || /\.css(?:[?#]|$)/i.test(resource.url)));
    const contents = new Map();
    // Bound simultaneous requests for pages with many stylesheets.
    for (let start = 0; start < list.length; start += 8) {
        await Promise.all(list.slice(start, start + 8).map(async resource => contents.set(resource.url, await resourceContent(resource))));
    }
    const current = await evaluate('location.href');
    if (!samePage(current, snapshot.url)) throw new Error('페이지가 이동했습니다. 현재 페이지에서 다시 내보내세요.');
    return {snapshot, contents};
}
function compactCSS(text, removeWhitespace = true) {
    let result = '', quote = '';
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '\\') { result += text.slice(index, index + 2); index++; continue; }
        if (quote) { result += character; if (character === quote) quote = ''; continue; }
        if (character === '"' || character === "'") { quote = character; result += character; continue; }
        if (text.startsWith('/*', index)) { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 1; continue; }
        if (!removeWhitespace || !/\s/.test(character)) result += character;
    }
    return result;
}
function ruleNormalizer(base) {
    const parser = new CSSStyleSheet(), cache = new Map();
    return text => {
        if (cache.has(text)) return cache.get(text);
        let result = null;
        if (/^\s*@(?:import|namespace)\b/i.test(text)) {
            const clean = compactCSS(rebaseCSS(text, base), false);
            const rebased = clean.replace(/^(@(?:import|namespace)\s*(?:[\w-]+\s+)?)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/i, '$1url($2)');
            result = compactCSS(rebased);
        } else {
            try { parser.replaceSync(text); result = parser.cssRules.length === 1 ? rebaseCSS(parser.cssRules[0].cssText, base) : null; } catch { /* Preserve unsupported source text. */ }
        }
        cache.set(text, result); return result;
    };
}
export function buildExport(snapshot, contents, review, settings) {
    const documentCopy = new DOMParser().parseFromString(snapshot.html, 'text/html');
    const warnings = [...snapshot.warnings], records = [], files = [], sources = new Map(), exported = new Set(), processedStyles = new Set();
    stripTooling(documentCopy, {extensionOrigin: chrome.runtime.getURL(''), base: snapshot.base, preserveSheetMarkers: true});
    const basename = originalFilename(snapshot.url, 'index.html');
    const htmlPath = 'html/' + basename;
    const entries = [...snapshot.sheets];
    for (const [url, css] of contents) if (!entries.some(entry => entry.url === url)) entries.push({id: `resource-${entries.length}`, url, owner: null, css: null});
    for (const entry of entries) {
        const resource = entry.url ? contents.get(entry.url) : entry.raw;
        let css = typeof resource === 'string' ? mergeStylesheet(resource, entry.rules, ruleNormalizer(entry.url || snapshot.base)) : entry.css;
        if (typeof css === 'string') {
            sources.set(entry.id, css);
            if (typeof resource !== 'string') warnings.push(`원본 텍스트가 없어 동적 CSS를 저장했습니다: ${entry.url || '인라인 스타일'}`);
        }
    }
    const paths = stylesheetPaths(entries.filter(entry => entry.url && /^(https?:)/i.test(entry.url) && sources.has(entry.id)).map(entry => entry.url));
    for (const entry of entries) {
        const owner = documentCopy.querySelector(`[data-visualqa-export-sheet="${entry.id}"]`);
        const path = paths.get(entry.url), css = sources.get(entry.id);
        if (path && !exported.has(path)) {
            exported.add(path);
            files.push({name: path, content: rebaseCSS(css, entry.url, url => paths.has(url) ? relativePath(path, paths.get(url)) : url, true)});
            records.push({url: entry.url, file: path, source: typeof contents.get(entry.url) === 'string' ? 'devtools-source' : 'dynamic-css', disabled: entry.disabled || false});
        }
        if (owner?.tagName === 'LINK' && path) {
            owner.setAttribute('href', relativePath(htmlPath, path)); owner.removeAttribute('integrity'); owner.removeAttribute('crossorigin');
            owner.setAttribute('data-visualqa-export-link', 'true');
        } else if (owner?.tagName === 'STYLE' && typeof css === 'string') {
            owner.textContent = rebaseCSS(css, snapshot.base, url => paths.has(url) ? relativePath(htmlPath, paths.get(url)) : url, true);
            processedStyles.add(owner);
        } else if (!owner && !path && typeof css === 'string') {
            const style = documentCopy.createElement('style'); style.textContent = rebaseCSS(css, snapshot.base, undefined, true);
            documentCopy.head.append(style); processedStyles.add(style);
        }
        if (entry.unreadable && typeof css !== 'string') warnings.push(`CSS를 읽지 못해 원본 주소를 유지했습니다: ${entry.url}`);
    }
    documentCopy.querySelectorAll('base').forEach(node => node.remove());
    for (const node of documentCopy.querySelectorAll('*')) {
        for (const attribute of ['href', 'src', 'poster', 'action', 'formaction', 'data', 'background', 'cite', 'xlink:href']) {
            if (!node.hasAttribute(attribute) || (attribute === 'href' && node.hasAttribute('data-visualqa-export-link'))) continue;
            const value = node.getAttribute(attribute);
            if (!value || value.startsWith('#')) continue;
            try { node.setAttribute(attribute, new URL(value, snapshot.base).href); } catch { /* Keep invalid source values. */ }
        }
        for (const attribute of ['srcset', 'imagesrcset']) if (node.hasAttribute(attribute)) node.setAttribute(attribute, rebaseSrcset(node.getAttribute(attribute), snapshot.base));
        if (node.hasAttribute('style')) node.setAttribute('style', rebaseCSS(node.getAttribute('style'), snapshot.base, undefined, true));
        node.removeAttribute('data-visualqa-export-sheet'); node.removeAttribute('data-visualqa-export-link');
    }
    // Readable inline sheets were replaced above. Also rebase inline blocks not represented in CSSOM.
    for (const style of documentCopy.querySelectorAll('style')) if (!processedStyles.has(style)) style.textContent = rebaseCSS(style.textContent, snapshot.base, url => paths.has(url) ? relativePath(htmlPath, paths.get(url)) : url, true);
    const charset = documentCopy.querySelector('meta[charset]');
    if (charset) charset.setAttribute('charset', 'utf-8');
    else { const meta = documentCopy.createElement('meta'); meta.setAttribute('charset', 'utf-8'); documentCopy.head.prepend(meta); }
    documentCopy.querySelectorAll('meta[http-equiv="content-type" i]').forEach(meta => meta.setAttribute('content', 'text/html; charset=utf-8'));
    files.unshift({name: htmlPath, content: snapshot.doctype + '\n' + documentCopy.documentElement.outerHTML + '\n'});
    const manifest = {format: 'visualqa.edited-page', version: 2, exportedAt: new Date().toISOString(), url: snapshot.url,
        html: htmlPath, stylesheets: records, review: review ? {name: review.name, runId: review.runId, revisionId: review.revisionId} : null,
        overlay: settings || null, warnings: [...new Set(warnings)],
        notes: ['HTML은 현재 DOM 사본입니다. 원본 소스 파일과 구조·서식이 다를 수 있습니다.',
            'CSS는 개발자도구의 수정된 소스 텍스트를 사용해 기존 주석·들여쓰기·줄바꿈을 보존합니다. URL 값은 저장 위치에 맞춥니다.',
            '소스에 없는 런타임 규칙은 원본 줄바꿈·들여쓰기를 참고해 추가합니다. 원본이 없는 동적 CSS는 알림에 기록합니다.',
            '이미지·폰트·JavaScript는 원래 주소를 참조합니다. 오프라인 완성본이 아닙니다.',
            'CSS 경로 대응은 manifest.json을 확인하세요. 원본 파일에는 자동으로 덮어쓰지 않습니다.']};
    files.push({name: 'manifest.json', content: JSON.stringify(manifest, null, 4) + '\n'});
    files.push({name: '읽어주세요.txt', content: manifest.notes.join('\n') + '\n\n' + manifest.warnings.join('\n') + '\n'});
    return {blob: zipFiles(files), files, manifest, filename: `${safeFilename(basename.replace(/\.html?$/i, ''))}.zip`};
}
