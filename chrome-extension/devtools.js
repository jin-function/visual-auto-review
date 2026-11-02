import {collectExport, buildExport, evaluate} from './export.mjs';
import {inspectSelector} from './snapshot.mjs';
import {samePage} from './core.mjs';

const extensionId = chrome.runtime.id;
let connection, reconnect, heartbeat, stopped = false;
const objectURLs = new Set();
function available() {
    try { return !stopped && !!extensionId && chrome.runtime.id === extensionId; } catch { return false; }
}
function stop() {
    stopped = true; clearTimeout(reconnect); clearInterval(heartbeat);
    const port = connection; connection = null;
    try { port?.disconnect(); } catch { /* Context invalidated. */ }
    for (const url of objectURLs) URL.revokeObjectURL(url);
    objectURLs.clear();
}
async function execute(message) {
    if (!available()) throw new Error('확장을 갱신했습니다. 개발자도구를 다시 열어 주세요.');
    if (!samePage(await evaluate('location.href'), message.url)) throw new Error('검수 페이지가 이동했습니다. 원래 페이지에서 다시 연결하세요.');
    if (message.type === 'inspect') {
        if (!await evaluate(inspectSelector(message.selector))) throw new Error('현재 페이지에서 요소를 찾지 못했습니다.');
        return {selected: true};
    }
    if (message.type === 'export') {
        const {snapshot, contents} = await collectExport();
        if (!available()) throw new Error('확장을 갱신했습니다. 개발자도구를 다시 열어 주세요.');
        const result = buildExport(snapshot, contents, message.review, message.settings);
        const url = URL.createObjectURL(result.blob); objectURLs.add(url);
        return {url, filename: result.filename, warnings: result.manifest.warnings};
    }
    throw new Error('지원하지 않는 개발자도구 요청입니다.');
}
function connect() {
    if (!available()) { stop(); return; }
    let port;
    try {
        port = chrome.runtime.connect({name: 'visualqa-devtools'});
        connection = port;
        port.postMessage({type: 'hello', tabId: chrome.devtools.inspectedWindow.tabId});
    } catch (error) {
        if (!available() || error.message.includes('Extension context invalidated')) stop();
        else reconnect = setTimeout(connect, 500);
        return;
    }
    port.onMessage.addListener(message => {
        if (!available()) { stop(); return; }
        if (message.type === 'release-url') { URL.revokeObjectURL(message.url); objectURLs.delete(message.url); return; }
        execute(message).then(value => port.postMessage({requestId: message.requestId, ok: true, value}))
            .catch(error => { try { port.postMessage({requestId: message.requestId, ok: false, error: error.message}); } catch { /* Closed. */ } });
    });
    port.onDisconnect.addListener(() => {
        if (connection !== port) return;
        connection = null;
        if (!available()) { stop(); return; }
        clearTimeout(reconnect); reconnect = setTimeout(connect, 500);
    });
}
if (available()) {
    chrome.devtools.panels.create('시안 검수', '', 'workspace.html', () => {});
    connect();
    heartbeat = setInterval(() => {
        if (!available()) { stop(); return; }
        try { connection?.postMessage({type: 'ping'}); } catch { /* Reconnect listener handles closure. */ }
    }, 20000);
    addEventListener('pagehide', stop, {once: true});
}
