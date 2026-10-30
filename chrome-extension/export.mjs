import {safeFilename, hashName, samePage} from './core.mjs';
import {rebaseCSS, rebaseSrcset} from './css.mjs';
import {snapshotPage} from './snapshot.mjs';
import {zipFiles} from './zip.mjs';

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
    const snapshot = await evaluate(`(${snapshotPage.toString()})()`);
    const known = new Set(snapshot.sheets.map(sheet => sheet.url));
    const network = await networkStyles();
    const list = (await resources()).filter(resource => known.has(resource.url) || network.has(resource.url) || /\.css(?:[?#]|$)/i.test(resource.url));
    const contents = new Map();
    // Bound simultaneous requests for pages with many stylesheets.
    for (let start = 0; start < list.length; start += 8) {
        await Promise.all(list.slice(start, start + 8).map(async resource => contents.set(resource.url, await resourceContent(resource))));
    }
    const current = await evaluate('location.href');
    if (!samePage(current, snapshot.url)) throw new Error('페이지가 이동했습니다. 현재 페이지에서 다시 내보내세요.');
    return {snapshot, contents};
}
export function buildExport(snapshot, contents, review, settings) {
    const documentCopy = new DOMParser().parseFromString(snapshot.html, 'text/html');
    const warnings = [...snapshot.warnings], records = [], files = [], paths = new Map(), exported = new Set(), processedStyles = new Set();
    const entries = [...snapshot.sheets];
    for (const [url, css] of contents) if (!entries.some(entry => entry.url === url)) entries.push({id: `resource-${entries.length}`, url, owner: null, css: null});
    for (const entry of entries) {
        if (!entry.url || !/^(https?:)/i.test(entry.url) || paths.has(entry.url)) continue;
        const content = entry.css ?? contents.get(entry.url);
        if (typeof content !== 'string') continue;
        let basename;
        try { basename = decodeURIComponent(new URL(entry.url).pathname.split('/').pop()); } catch { basename = 'style.css'; }
        basename = safeFilename(basename, 'style.css'); if (!basename.endsWith('.css')) basename += '.css';
        paths.set(entry.url, `css/${String(paths.size + 1).padStart(3, '0')}_${hashName(entry.url)}_${basename}`);
    }
    for (const entry of entries) {
        const owner = documentCopy.querySelector(`[data-visualqa-export-sheet="${entry.id}"]`);
        const path = paths.get(entry.url), css = entry.css ?? contents.get(entry.url);
        if (path && !exported.has(path)) {
            exported.add(path);
            files.push({name: path, content: rebaseCSS(css, entry.url, url => paths.has(url) ? './' + paths.get(url).slice(4) : url)});
            records.push({url: entry.url, file: path, source: entry.css !== null ? 'live-cssom' : 'devtools-resource', disabled: entry.disabled || false});
        }
        if (owner?.tagName === 'LINK' && path) {
            owner.setAttribute('href', '../' + path); owner.removeAttribute('integrity'); owner.removeAttribute('crossorigin');
            owner.setAttribute('data-visualqa-export-link', 'true');
        } else if (owner?.tagName === 'STYLE' && typeof css === 'string') {
            owner.textContent = rebaseCSS(css, snapshot.base, url => paths.has(url) ? '../' + paths.get(url) : url);
            processedStyles.add(owner);
        } else if (!owner && !path && typeof css === 'string') {
            const style = documentCopy.createElement('style'); style.textContent = rebaseCSS(css, snapshot.base);
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
        if (node.hasAttribute('style')) node.setAttribute('style', rebaseCSS(node.getAttribute('style'), snapshot.base));
        node.removeAttribute('data-visualqa-export-sheet'); node.removeAttribute('data-visualqa-export-link');
    }
    // Readable inline sheets were replaced above. Also rebase inline blocks not represented in CSSOM.
    for (const style of documentCopy.querySelectorAll('style')) if (!processedStyles.has(style)) style.textContent = rebaseCSS(style.textContent, snapshot.base, url => paths.has(url) ? '../' + paths.get(url) : url);
    const charset = documentCopy.querySelector('meta[charset]');
    if (charset) charset.setAttribute('charset', 'utf-8');
    else { const meta = documentCopy.createElement('meta'); meta.setAttribute('charset', 'utf-8'); documentCopy.head.prepend(meta); }
    documentCopy.querySelectorAll('meta[http-equiv="content-type" i]').forEach(meta => meta.setAttribute('content', 'text/html; charset=utf-8'));
    let basename;
    try { basename = decodeURIComponent(new URL(snapshot.url).pathname.split('/').pop()); } catch { basename = 'page.html'; }
    basename = safeFilename(basename, 'index.html'); if (!/\.html?$/i.test(basename)) basename += '.html';
    const htmlPath = 'html/' + basename;
    files.unshift({name: htmlPath, content: snapshot.doctype + '\n' + documentCopy.documentElement.outerHTML + '\n'});
    const manifest = {format: 'visualqa.edited-page', version: 1, exportedAt: new Date().toISOString(), url: snapshot.url,
        html: htmlPath, stylesheets: records, review: review ? {name: review.name, runId: review.runId, revisionId: review.revisionId} : null,
        overlay: settings || null, warnings: [...new Set(warnings)],
        notes: ['HTML은 현재 DOM 사본입니다. 원본 소스 파일과 구조·서식이 다를 수 있습니다.',
            'CSS는 현재 CSSOM 또는 개발자도구 리소스의 내용입니다. CSSOM 직렬화 시 주석과 서식이 달라질 수 있습니다.',
            '이미지·폰트·JavaScript는 원래 주소를 참조합니다. 오프라인 완성본이 아닙니다.',
            'CSS 경로 대응은 manifest.json을 확인하세요. 원본 파일에는 자동으로 덮어쓰지 않습니다.']};
    files.push({name: 'manifest.json', content: JSON.stringify(manifest, null, 4) + '\n'});
    files.push({name: '읽어주세요.txt', content: manifest.notes.join('\n') + '\n\n' + manifest.warnings.join('\n') + '\n'});
    return {blob: zipFiles(files), files, manifest, filename: `시안검수_수정본_${safeFilename(basename.replace(/\.html?$/i, ''))}.zip`};
}
