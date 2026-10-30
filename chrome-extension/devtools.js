import {collectExport, buildExport, evaluate} from './export.mjs';
import {inspectSelector} from './snapshot.mjs';
import {samePage} from './core.mjs';

chrome.devtools.panels.create('시안 검수', '', 'workspace.html', () => {});
let connection, reconnect;
const objectURLs = new Set();
async function execute(message) {
    if (!samePage(await evaluate('location.href'), message.url)) throw new Error('검수 페이지가 이동했습니다. 원래 페이지에서 다시 연결하세요.');
    if (message.type === 'inspect') {
        if (!await evaluate(inspectSelector(message.selector))) throw new Error('현재 페이지에서 요소를 찾지 못했습니다.');
        return {selected: true};
    }
    if (message.type === 'export') {
        const {snapshot, contents} = await collectExport();
        const result = buildExport(snapshot, contents, message.review, message.settings);
        const url = URL.createObjectURL(result.blob); objectURLs.add(url);
        return {url, filename: result.filename, warnings: result.manifest.warnings};
    }
    throw new Error('지원하지 않는 개발자도구 요청입니다.');
}
function connect() {
    connection = chrome.runtime.connect({name: 'visualqa-devtools'});
    connection.postMessage({type: 'hello', tabId: chrome.devtools.inspectedWindow.tabId});
    connection.onMessage.addListener(message => {
        if (message.type === 'release-url') { URL.revokeObjectURL(message.url); objectURLs.delete(message.url); return; }
        const port = connection;
        execute(message).then(value => port.postMessage({requestId: message.requestId, ok: true, value}))
            .catch(error => { try { port.postMessage({requestId: message.requestId, ok: false, error: error.message}); } catch { /* Closed. */ } });
    });
    connection.onDisconnect.addListener(() => { clearTimeout(reconnect); reconnect = setTimeout(connect, 500); });
}
connect();
setInterval(() => { try { connection.postMessage({type: 'ping'}); } catch { /* Reconnect listener handles closure. */ } }, 20000);
