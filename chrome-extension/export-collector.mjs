import {samePage} from './core.mjs';
import {snapshotPage} from './snapshot.mjs';
import {stripTooling} from './sanitize.mjs';

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
