// Uses a disposable Chrome for Testing profile and fixture-only host permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {crc32} from '../chrome-extension/zip.mjs';

const root = path.resolve('.'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'visualqa-extension-test-'));
const extension = path.join(temp, 'extension'); fs.cpSync(path.join(root, 'chrome-extension'), extension, {recursive: true});
const testedFiles = Object.fromEntries(fs.readdirSync(extension).filter(name => /\.(?:js|mjs|json|html|css)$/.test(name)).sort()
    .map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(extension, name))).digest('hex')]));
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*'];
const staleManifest = process.argv.includes('--stale-manifest');
if (staleManifest) {
    manifest.version = '1.1.0';
    manifest.permissions = manifest.permissions.filter(value => value !== 'sidePanel');
    delete manifest.side_panel;
}
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(operation, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try { const value = await operation(); if (value) return value; } catch (error) { lastError = error; }
        await pause(100);
    }
    throw new Error(`Timed out: ${label}${lastError ? ' (' + lastError.message + ')' : ''}`);
}
const foreign = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/css'); response.end('#hero { border-top: 3px solid rgb(1, 2, 3); }'); });
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
const foreignURL = `http://127.0.0.1:${foreign.address().port}/external/main.css`;
const authoredMain = "/* KEEP MAIN COMMENT */\r\n@import  './import.css';\r\n\r\n#hero {\r\n    /* KEEP DECLARATION COMMENT */\r\n    color: rgb(12, 34, 56);\r\n    padding: 12px;\r\n}\r\n";
const authoredImport = "/* KEEP IMPORT COMMENT */\n.imported {\n\tbackground: url(\n\t    '../img/a.png'\n\t);\n}\n";
const server = http.createServer((request, response) => {
    if (request.url === '/css/main.css') { response.setHeader('Content-Type', 'text/css'); response.end(authoredMain); }
    else if (request.url === '/css/import.css') { response.setHeader('Content-Type', 'text/css'); response.end(authoredImport); }
    else if (request.url === '/html/page.html') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'self' 'unsafe-inline' ${foreignURL}; img-src 'none'; script-src 'none'`);
        response.end(`<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><title>확장 도구 검증</title><link rel="stylesheet" href="../css/main.css"><link rel="stylesheet" href="${foreignURL}"><style>body{margin:0;font:16px sans-serif}#hero{height:180px;background:#fff}section{height:1400px;background:#f5f6fa}</style></head><body><header id="hero"><h1 id="title">원래 제목</h1><input id="input" value="before"><textarea>before</textarea></header><section><p>스크롤 위치 검증</p></section></body></html>`);
    } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/html/page.html`;
function png(red = 35, green = 100, blue = 230) {
    function chunk(type, bytes) { const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes]))); return Buffer.concat([length, name, bytes, crc]); }
    const header = Buffer.alloc(13); header.writeUInt32BE(80, 0); header.writeUInt32BE(80, 4); header[8] = 8; header[9] = 6;
    const pixels = Buffer.alloc(80 * (80 * 4 + 1));
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) { const offset = y * 321 + 1 + x * 4; pixels.set([red, green, blue, 255], offset); }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const original = process.argv.find(argument => argument.startsWith('--original='))?.slice('--original='.length);
const image = original ? fs.readFileSync(original) : png();
const imageWidth = image.readUInt32BE(16), imageHeight = image.readUInt32BE(20), displayWidth = original ? 390 : 80;
const review = {format: 'visualqa.chrome-review', version: 2, imageRole: 'reference-original', display: {width: displayWidth, height: Math.round(imageHeight * displayWidth / imageWidth)}, name: '실시간 검수 검증', url, viewportWidth: 780, placement: {x: 20, y: 60}, runId: 'integration-run', revisionId: 'integration-revision',
    image: {mime: 'image/png', width: imageWidth, height: imageHeight, sha256: createHash('sha256').update(image).digest('hex'), base64: image.toString('base64')},
    findings: [{id: 'difference-1', title: '제목 스타일 차이', rect: {x: 0, y: 0, width: 80, height: 80}, selectors: ['#hero']},
        {id: 'difference-2', title: '하단 영역 차이', rect: {x: 0, y: 1000, width: 80, height: 80}, selectors: ['section']} ]};
const chromePath = process.env.VISUAL_QA_TEST_CHROME;
if (!chromePath || !fs.existsSync(chromePath)) throw new Error('VISUAL_QA_TEST_CHROME에 Chrome for Testing 실행 파일을 지정하세요.');
const chrome = spawn(chromePath, [...(process.argv.includes('--headed') ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-size=1200,1000',
    '--auto-open-devtools-for-tabs', `--user-data-dir=${path.join(temp, 'profile')}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
let errors = '', socket, sequence = 0; chrome.stderr.on('data', data => errors = (errors + data).slice(-3000));
const pending = new Map(), events = [];
function send(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
        pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params, sessionId}));
    });
}
async function evaluate(session, expression, userGesture = false) {
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture}, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
}
async function attach(targetId) { return (await send('Target.attachToTarget', {targetId, flatten: true})).sessionId; }
async function targets() { return (await send('Target.getTargets')).targetInfos; }
let receipt, devtoolsParent;
try {
    async function verify() {
    await until(() => fs.existsSync(path.join(temp, 'profile/DevToolsActivePort')), 'Chrome ready');
    const [port, endpoint] = fs.readFileSync(path.join(temp, 'profile/DevToolsActivePort'), 'utf8').trim().split('\n');
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    socket.addEventListener('message', event => {
        const value = JSON.parse(event.data), item = pending.get(value.id);
        if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result || {}); }
        else if (value.method) events.push(value);
    });
    fs.mkdirSync(path.join(temp, 'downloads'));
    await send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: path.join(temp, 'downloads'), eventsEnabled: true});
    const worker = await until(async () => (await targets()).find(target => target.type === 'service_worker' && target.url.endsWith('/background.js')), 'extension worker');
    const extensionOrigin = new URL(worker.url).origin === 'null' ? worker.url.slice(0, worker.url.indexOf('/background.js')) : new URL(worker.url).origin;
    const {targetId} = await send('Target.createTarget', {url});
    const page = await attach(targetId);
    await send('Runtime.enable', {}, page); await send('Page.enable', {}, page); await send('DOM.enable', {}, page); await send('CSS.enable', {}, page);
    await send('Emulation.setDeviceMetricsOverride', {width: 780, height: 600, deviceScaleFactor: 1, mobile: false}, page);
    await until(() => evaluate(page, `document.readyState === 'complete' && !!document.querySelector('#hero')`), 'fixture page');
    const heightBefore = await evaluate(page, 'document.documentElement.scrollHeight');
    if (staleManifest) {
        const workerSession = await attach(worker.targetId); await send('Runtime.enable', {}, workerSession);
        await until(() => evaluate(workerSession, `typeof chrome !== 'undefined' && typeof chrome.tabs?.query === 'function'`), 'worker APIs ready');
        const actualTab = await evaluate(workerSession, `(async()=>(await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(url)}).id)()`);
        const staleTarget = await send('Target.createTarget', {url: extensionOrigin + '/workspace.html?tab=' + actualTab});
        const panel = await attach(staleTarget.targetId); await send('Runtime.enable', {}, panel);
        await until(() => evaluate(panel, `!!document.querySelector('#reload-extension') && !document.querySelector('#reload-extension').hidden`), 'stale manifest update button');
        assert.equal(await evaluate(panel, 'typeof chrome.sidePanel'), 'undefined');
        await evaluate(panel, `document.querySelector('#open-sidepanel').click()`, true);
        const notice = await evaluate(panel, 'document.querySelector("#message").textContent');
        assert.ok(notice.includes('Chrome 확장 관리 열기'));
        assert.ok((await evaluate(panel, 'document.querySelector("#extension-info").textContent')).includes('1.1.0'));
        assert.ok(!notice.includes('undefined'));
        await evaluate(panel, `document.querySelector('#reload-extension').click()`, true);
        await until(async () => (await targets()).some(target => target.url === 'chrome://extensions/?id=' + extensionOrigin.split('://')[1]), 'extension manager opens');
        const version = JSON.parse(fs.readFileSync(path.join(root, 'chrome-extension/manifest.json'))).version;
        const report = {status: 'PASS', extensionVersion: version, browser: (await send('Browser.getVersion')).product,
            user_update_required: true,
            tests: ['missing sidePanel API reproduced', 'update guidance instead of TypeError', 'extension version displayed', 'explicit extension manager button opens own settings']};
        fs.writeFileSync(path.join(root, 'verification/chrome-extension-reload.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    let devtools;
    await until(async () => {
        for (const target of (await targets()).filter(target => target.url === extensionOrigin + '/devtools.html')) {
            const session = await attach(target.targetId);
            await send('Runtime.enable', {}, session); await send('Log.enable', {}, session);
            const inspected = await evaluate(session, `new Promise(resolve=>chrome.devtools.inspectedWindow.eval('location.href',resolve))`);
            if (inspected === url) { devtools = session; devtoolsParent = target.parentId; return true; }
            await send('Target.detachFromTarget', {sessionId: session});
        }
        return false;
    }, 'DevTools extension');
    const frontSession = await attach(devtoolsParent); await send('Runtime.enable', {}, frontSession); await send('Log.enable', {}, frontSession);
    // Chrome's own test hook renders menus inside the temporary frontend rather than macOS menus.
    await evaluate(frontSession, 'InspectorFrontendAPI.setUseSoftMenu(true)');
    await send('Emulation.setDeviceMetricsOverride', {width: 3000, height: 1100, deviceScaleFactor: 1, mobile: false}, frontSession);
    await pause(700);
    const panelTab = await evaluate(frontSession, `(()=>{let found;function visit(root){for(const node of root.querySelectorAll('*')){if(node.getAttribute('role')==='tab'&&node.textContent.includes('시안 검수')&&node.getBoundingClientRect().width)found=node;if(node.shadowRoot)visit(node.shadowRoot);}}visit(document);if(found){const r=found.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}return null;})()`);
    console.log('Panel tab:', JSON.stringify(panelTab));
    if(panelTab){await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...panelTab},frontSession);await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...panelTab},frontSession);}
    const dropdown = !panelTab && await evaluate(frontSession, `(()=>{let found;function visit(root){for(const node of root.querySelectorAll('*')){if(!found&&node.getAttribute('aria-label')==='More tabs'&&node.getBoundingClientRect().width)found=node;if(node.shadowRoot)visit(node.shadowRoot);}}visit(document);if(found){const r=found.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}return null;})()`);
    if (dropdown) {
        await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...dropdown}, frontSession);
        await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...dropdown}, frontSession);
        await pause(500);
        const menu = await evaluate(frontSession, `(()=>{let found;function visit(root){for(const node of root.querySelectorAll('*')){if(node.textContent==='시안 검수' && node.getBoundingClientRect().width)found=node;if(node.shadowRoot)visit(node.shadowRoot);}}visit(document);if(found){const r=found.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}return null;})()`);
        console.log('Menu item:', JSON.stringify(menu));
        if(menu){await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...menu},frontSession);await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...menu},frontSession);}
    }
    const panelTarget = await until(async () => (await targets()).find(target => target.url.startsWith(extensionOrigin + '/workspace.html')), 'review panel');
    const panel = await attach(panelTarget.targetId); await send('Runtime.enable', {}, panel);
    await until(() => evaluate(panel, `document.querySelector('#import') && !document.querySelector('#export').disabled`), 'panel initialized');
    await evaluate(panel, `globalThis.__nativeSidePanel=chrome.sidePanel;Object.defineProperty(chrome,'sidePanel',{value:undefined,configurable:true});`);
    assert.equal(await evaluate(panel, 'typeof chrome.sidePanel'), 'undefined');
    await evaluate(panel, `(() => { const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(review))}], 'review.json', {type:'application/json'})); const input=document.querySelector('#import'); input.files=transfer.files; input.dispatchEvent(new Event('change')); })()`);
    await until(() => evaluate(panel, `document.querySelector('#reviews').value && !document.querySelector('#connect').disabled`), 'review import');
    await evaluate(page, `(()=>{const stale=document.createElement('visualqa-overlay');stale.setAttribute('data-visualqa-extension','overlay');stale.id='stale-overlay';document.documentElement.append(stale);})()`);
    await evaluate(panel, `document.querySelector('#connect').click()`, true);
    await until(() => evaluate(page, `!!document.querySelector('[data-visualqa-extension]') && !document.querySelector('#stale-overlay')`), 'overlay connected');
    assert.equal(await evaluate(page, `document.querySelectorAll('visualqa-overlay').length`), 1);
    assert.equal(await evaluate(page, `!!document.querySelector('#stale-overlay')`), false);
    assert.equal(await evaluate(page, `!!document.querySelector('visualqa-tools')`), false, 'page must contain no tool panel');
    const layoutBefore = await evaluate(page, `({width:innerWidth,bodyStyle:document.body.getAttribute('style'),htmlStyle:document.documentElement.getAttribute('style'),hero:document.querySelector('#hero').getBoundingClientRect().toJSON()})`);
    await evaluate(panel, `document.querySelector('#open-sidepanel').click()`, true);
    const sideTarget = await until(async () => (await targets()).find(target => target.url === extensionOrigin + '/sidepanel.html'), 'native sidepanel target');
    let side = await attach(sideTarget.targetId); await send('Runtime.enable', {}, side); await send('Log.enable', {}, side); await send('DOM.enable', {}, side);
    try {
        await until(() => evaluate(side, `!!document.querySelector('visualqa-tools') && !document.querySelector('#tools').hidden`), 'native sidepanel tools');
    } catch (error) {
        console.error('Sidepanel startup:', JSON.stringify(await evaluate(side, `(async()=>({message:document.querySelector('#message')?.textContent,tools:!!document.querySelector('visualqa-tools'),window:await chrome.windows.getCurrent(),tabs:await chrome.tabs.query({active:true}),toolbar:typeof VisualQAToolbar}))()`)));
        throw error;
    }
    async function tool(selector, operation) {
        const document = await send('DOM.getDocument', {depth: -1, pierce: true}, side);
        function find(node) {
            if (node.nodeName === 'VISUALQA-TOOLS') return node;
            for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const result = find(child); if (result) return result; }
        }
        const host = find(document.root);
        assert.ok(host?.shadowRoots?.length, 'toolbar shadow root exists');
        const element = await send('DOM.querySelector', {nodeId: host.shadowRoots[0].nodeId, selector}, side);
        assert.ok(element.nodeId, selector);
        const object = await send('DOM.resolveNode', {nodeId: element.nodeId}, side);
        const result = await send('Runtime.callFunctionOn', {objectId: object.object.objectId, functionDeclaration: `function(){${operation}}`, returnByValue: true, awaitPromise: true}, side);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    }
    await tool('[data-tool="manage"]', 'this.click();');
    await until(() => evaluate(side, `!document.querySelector('#connection').hidden`), 'sidepanel file manager');
    await evaluate(side, `(() => { const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(review))}],'review.json',{type:'application/json'}));const input=document.querySelector('#import');input.files=transfer.files;input.dispatchEvent(new Event('change')); })()`);
    await until(() => evaluate(side, `document.querySelector('#message').textContent.includes('파일을 불러왔습니다')`), 'sidepanel file import');
    await evaluate(side, `document.querySelector('#connect').click()`, true);
    await until(() => evaluate(side, `!document.querySelector('#tools').hidden`), 'sidepanel connects current page');
    assert.equal(await evaluate(page, 'document.documentElement.scrollHeight'), heightBefore, 'overlay must not change layout');
    assert.deepEqual(await evaluate(page, `({width:innerWidth,bodyStyle:document.body.getAttribute('style'),htmlStyle:document.documentElement.getAttribute('style'),hero:document.querySelector('#hero').getBoundingClientRect().toJSON()})`), layoutBefore, 'tools must not mutate page styles or element layout');
    assert.equal(await evaluate(page, `document.elementFromPoint(30,70).closest('[data-visualqa-extension]') === null`), true, 'overlay must pass pointer events through');
    const settings = await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`);
    assert.equal(settings.value.overlay.widthMismatch, false);
    assert.equal(settings.value.overlay.imageRole, 'reference-original');
    assert.equal(settings.value.overlay.version, manifest.version);
    assert.equal(await tool('[data-tool="extension-version"]', 'return this.textContent;'), `시안 검수 · v${manifest.version}`);
    assert.equal(await evaluate(page, `document.querySelector('visualqa-overlay').getAttribute('data-visualqa-version')`), manifest.version);
    assert.ok(settings.value.overlay.devtoolsReady);
    assert.equal(await tool('[data-tool="options-tab"]', 'return this.getAttribute("aria-selected");'), 'true');
    await tool('[data-tool="findings-tab"]', 'this.click();');
    assert.equal(await tool('[data-tool="findings"]', 'return this.tagName;'), 'UL');
    assert.equal(await tool('[data-tool="findings"]', 'return this.querySelectorAll("li button").length;'), 2);
    await tool('[data-finding-id="difference-2"]', 'this.click();');
    await until(() => evaluate(page, 'scrollY > 700'), 'list finding navigation');
    assert.equal(await tool('[data-tool="selected-finding"]', 'return this.textContent;'), '하단 영역 차이');
    await tool('[data-tool="previous"]', 'this.click();');
    await until(() => evaluate(page, 'scrollY < 100'), 'previous finding navigation');
    await tool('[data-tool="next"]', 'this.click();');
    await until(() => evaluate(page, 'scrollY > 700'), 'next finding navigation');
    await tool('[data-finding-id="difference-1"]', 'this.click();');
    await tool('[data-tool="inspect"]', 'this.click();');
    await until(() => evaluate(devtools, `new Promise(resolve=>chrome.devtools.inspectedWindow.eval('$0?.id',resolve))`).then(value => value === 'hero'), 'on-page element selection');
    const findingsShot = await send('Page.captureScreenshot', {format: 'png'}, side);
    fs.writeFileSync(path.join(root, 'verification/chrome-findings.png'), Buffer.from(findingsShot.data, 'base64'));
    await tool('[data-tool="findings-tab"]', 'this.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));');
    assert.equal(await tool('[data-tool="options-tab"]', 'return this.getAttribute("aria-selected");'), 'true');
    assert.equal(await tool('[data-tool="findings"]', 'return this.closest("section").hidden;'), true);
    await tool('[data-tool="opacity"]', `this.value='65';this.dispatchEvent(new Event('input'));`);
    await until(async () => (await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`)).value.overlay.settings.opacity === .65, 'on-page opacity');
    const originalTab = await evaluate(panel, 'chrome.devtools.inspectedWindow.tabId');
    const otherTab = await evaluate(side, `chrome.tabs.create({url:'about:blank'})`);
    await until(() => evaluate(side, `!document.querySelector('#connection').hidden && !document.querySelector('visualqa-tools')`), 'sidepanel follows active unbound tab');
    await evaluate(side, `chrome.tabs.update(${originalTab},{active:true})`);
    await until(() => evaluate(side, `!document.querySelector('#tools').hidden && !!document.querySelector('visualqa-tools')`), 'sidepanel returns to bound tab');
    assert.equal(await tool('[data-tool="opacity"]', 'return Number(this.value);'), 65);
    await evaluate(side, `chrome.tabs.remove(${otherTab.id})`);
    const nativeWindow = await evaluate(side, '(async()=>(await chrome.windows.getCurrent()).id)()');
    await evaluate(panel, `__nativeSidePanel.close({windowId:${nativeWindow}})`);
    await until(async () => !(await targets()).some(target => target.url === extensionOrigin + '/sidepanel.html'), 'native sidepanel closes');
    assert.equal((await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`)).value.overlay.settings.opacity, .65);
    await evaluate(panel, `document.querySelector('#open-sidepanel').click()`, true);
    const reopenedSide = await until(async () => (await targets()).find(target => target.url === extensionOrigin + '/sidepanel.html'), 'native sidepanel reopens');
    side = await attach(reopenedSide.targetId); await send('Runtime.enable', {}, side); await send('DOM.enable', {}, side);
    await until(() => evaluate(side, `!!document.querySelector('visualqa-tools') && !document.querySelector('#tools').hidden`), 'reopened sidepanel tools');
    assert.equal(await tool('[data-tool="opacity"]', 'return Number(this.value);'), 65);
    await tool('[data-tool="opacity"]', `this.value='40';this.dispatchEvent(new Event('input'));`);
    await pause(200);
    await evaluate(panel, `document.querySelector('.finding button').click()`);
    await until(() => evaluate(panel, `document.querySelector('#message').textContent.includes('이동했습니다')`), 'finding jump');
    await evaluate(panel, `document.querySelectorAll('.finding button')[1].click()`);
    await until(() => evaluate(devtools, `new Promise(resolve=>chrome.devtools.inspectedWindow.eval('$0?.id',resolve))`).then(value => value === 'hero'), 'native Elements inspection');
    const overlayShot = await send('Page.captureScreenshot', {format: 'png'}, page);
    fs.writeFileSync(path.join(root, 'verification/chrome-overlay.png'), Buffer.from(overlayShot.data, 'base64'));
    // Apply the same protocol mutations used by the native Elements panel.
    const dom = await send('DOM.getDocument', {depth: 0}, page);
    const title = await send('DOM.querySelector', {nodeId: dom.root.nodeId, selector: '#title'}, page);
    await send('DOM.setOuterHTML', {nodeId: title.nodeId, outerHTML: '<h1 id="title">개발자도구에서 수정한 제목</h1>'}, page);
    const hero = await send('DOM.querySelector', {nodeId: dom.root.nodeId, selector: '#hero'}, page);
    const matched = await send('CSS.getMatchedStylesForNode', {nodeId: hero.nodeId}, page);
    const localHeader = events.find(event => event.sessionId === page && event.method === 'CSS.styleSheetAdded' && event.params.header.sourceURL.endsWith('/css/main.css')).params.header;
    const foreignHeader = events.find(event => event.sessionId === page && event.method === 'CSS.styleSheetAdded' && event.params.header.sourceURL === foreignURL).params.header;
    const localRule = matched.matchedCSSRules.find(item => item.rule.styleSheetId === localHeader.styleSheetId).rule;
    await send('CSS.setStyleTexts', {edits: [{styleSheetId: localHeader.styleSheetId, range: localRule.style.range, text: localRule.style.cssText.replace('padding: 12px;', 'padding: 22px;')}]}, page);
    await send('CSS.setStyleSheetText', {styleSheetId: foreignHeader.styleSheetId, text: '#hero { border-top: 7px solid rgb(100, 20, 30); }'}, page);
    await evaluate(page, `document.querySelector('#input').value='after'; document.querySelector('textarea').value='after'; document.styleSheets[0].insertRule('.runtime-added { margin: 17px; }', document.styleSheets[0].cssRules.length);`);
    assert.equal(await evaluate(page, `getComputedStyle(document.querySelector('#hero')).paddingTop`), '22px');
    assert.equal(await evaluate(page, `getComputedStyle(document.querySelector('#hero')).borderTopWidth`), '7px');
    await evaluate(page, String.raw`(()=>{
        const comment=document.createComment(' Code injected by Five-server ');document.head.append(comment);
        const script=document.createElement('script');script.dataset.id='five-server';script.dataset.file='/example/private/page.html';script.src=location.origin+'/fiveserver.js';document.head.append(script);
        const style=document.createElement('style');style.textContent='@keyframes fiveserverInfoPopup {0%{top:-40px}100%{top:4px}} #fiveserver-info-wrapper{max-width:98%}';document.head.append(style);
        const popup=document.createElement('div');popup.id='fiveserver-info-wrapper';popup.textContent='development popup';document.body.append(popup);
        for(const tag of ['script','style','aside']){const node=document.createElement(tag);node.dataset.visualqaExtension='test';node.textContent=tag==='style'?'.visualqa-fixture {color:red}':'visualqa fixture';document.body.append(node);}
        const legitimate=document.createElement('script');legitimate.id='application-data';legitimate.type='application/ld+json';legitimate.textContent=JSON.stringify({name:'original application data'});document.head.append(legitimate);
        const legitimateStyle=document.createElement('style');legitimateStyle.id='application-style';legitimateStyle.textContent='/* KEEP INLINE COMMENT */\n.application {\n    color: red;\n}\n';document.head.append(legitimateStyle);
        const adopted=new CSSStyleSheet();adopted.replaceSync('@keyframes fiveserverInfoPopup {0%{top:0}} #fiveserver-info {color:red}');document.adoptedStyleSheets=[...document.adoptedStyleSheets,adopted];
    })()`);
    await tool('[data-tool="save-as"]', `this.checked=false;this.dispatchEvent(new Event('input'));`);
    await pause(200);
    await tool('[data-tool="export"]', 'this.click();');
    await until(() => tool('[data-tool="status"]', 'return this.textContent;').then(value => value.includes('ZIP 저장을 시작했습니다')), 'on-page export');
    const downloaded = await until(() => fs.readdirSync(path.join(temp, 'downloads')).find(name => name.endsWith('.zip')), 'toolbar ZIP download');
    fs.copyFileSync(path.join(temp, 'downloads', downloaded), path.join(root, 'verification/chrome-toolbar-edited.zip'));
    const toolbarShot = await send('Page.captureScreenshot', {format: 'png'}, side);
    fs.writeFileSync(path.join(root, 'verification/chrome-toolbar.png'), Buffer.from(toolbarShot.data, 'base64'));
    // Exercise the actual export button and its DOM/CSS collection, not a mocked API.
    await evaluate(panel, `document.querySelector('#export').click()`);
    await until(() => evaluate(panel, `!!document.querySelector('#export-result a') || document.querySelector('#message').classList.contains('error')`), 'export');
    const exportError = await evaluate(panel, `document.querySelector('#message').classList.contains('error') ? document.querySelector('#message').textContent : ''`);
    assert.equal(exportError, '');
    const output = await evaluate(panel, `(async()=>{const href=document.querySelector('#export-result a').href;const bytes=new Uint8Array(await (await fetch(href)).arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);})()`);
    const zipPath = path.join(root, 'verification/chrome-edited-page.zip'); fs.writeFileSync(zipPath, Buffer.from(output, 'base64'));
    const detail = await evaluate(panel, `(async()=>{const {collectExport,buildExport}=await import('./export.mjs');const {snapshot,contents}=await collectExport();const result=buildExport(snapshot,contents,null,null);return {filename:result.filename,files:result.files,manifest:result.manifest,resourceUrls:[...contents.keys()]};})()`);
    const html = detail.files.find(file => file.name.startsWith('html/')).content;
    assert.ok(html.includes('개발자도구에서 수정한 제목')); assert.ok(html.includes('value="after"')); assert.ok(html.includes('>after</textarea>'));
    assert.ok(!html.includes('visualqa-overlay')); assert.ok(!html.includes('visualqa-tools')); assert.ok(!html.includes('data-visualqa-export-'));
    assert.ok(detail.files.some(file => file.name.startsWith('css/') && file.content.includes('padding: 22px')));
    assert.ok(detail.files.some(file => file.name.startsWith('css/') && file.content.includes('.runtime-added')));
    assert.ok(detail.files.some(file => file.name.startsWith('css/') && file.content.includes('7px solid')), 'cross-origin DevTools CSS edits must be exported');
    assert.ok(detail.files.some(file => file.name.startsWith('css/') && file.content.includes("'http://127.0.0.1:")));
    assert.equal(detail.manifest.html, 'html/page.html');
    assert.ok(detail.files.some(file => file.name === 'css/main.css'));
    assert.ok(detail.files.some(file => file.name === 'css/source-2/main.css'));
    assert.ok(detail.files.some(file => file.name === 'css/import.css'));
    const mainExport = detail.files.find(file => file.name === 'css/main.css').content;
    assert.ok(mainExport.includes(authoredMain.replace('./import.css', 'import.css').replace('padding: 12px;', 'padding: 22px;')));
    const importExport = detail.files.find(file => file.name === 'css/import.css').content;
    assert.equal(importExport, authoredImport.replace('../img/a.png', new URL('../img/a.png', url.replace('/html/page.html','/css/import.css')).href));
    assert.ok(html.includes('../css/main.css') && html.includes('../css/source-2/main.css'));
    assert.ok(!/fiveserver|five-server|visualqa fixture|visualqa-fixture|data-visualqa|private\/page/i.test(html));
    assert.ok(html.includes('application-data') && html.includes('original application data'));
    assert.ok(html.includes('/* KEEP INLINE COMMENT */\n.application {\n    color: red;\n}\n'));
    assert.ok(!detail.files.some(file => file.content.includes('fiveserverInfoPopup')));
    assert.equal(detail.filename, 'page.zip');
    let cssBenchmark;
    if (process.argv.includes('--benchmark-css')) {
        cssBenchmark = await evaluate(panel, `(async()=>{const {buildExport}=await import('./export.mjs');
            const source=Array.from({length:16000},(_,i)=>'/* keep '+i+' */\\r\\n.bulk-'+i+' {\\r\\n    color: #abcdef;\\r\\n    margin: 0;\\r\\n}\\r\\n').join('');
            const parsed=new CSSStyleSheet();parsed.replaceSync(source);const rules=[...parsed.cssRules].map(rule=>rule.cssText);
            const snapshot={url:'https://fixture.test/html/page.html',base:'https://fixture.test/html/page.html',html:'<html><head><link data-visualqa-export-sheet="bulk" href="/css/original.css"></head><body></body></html>',doctype:'<!doctype html>',warnings:[],sheets:[{id:'bulk',url:'https://fixture.test/css/original.css',rules,css:rules.join('\\n')}]};
            const start=performance.now(),result=buildExport(snapshot,new Map([['https://fixture.test/css/original.css',source]]),null,null);
            return {rules:rules.length,characters:source.length,milliseconds:Math.round(performance.now()-start),exact:result.files.find(file=>file.name==='css/original.css').content===source};})()`);
        assert.equal(cssBenchmark.rules, 16000); assert.equal(cssBenchmark.exact, true);
    }
    const responsiveHeight = await evaluate(page, 'document.documentElement.scrollHeight');
    // Responsive overlay behavior is exercised in the real content script and native sidepanel.
    async function state() { return (await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`)).value; }
    async function resize(width) {
        await send('Emulation.setDeviceMetricsOverride', {width, height: 600, deviceScaleFactor: 1, mobile: false}, page);
        await pause(150);
    }
    async function canvasState(sampleX, sampleY) {
        const tree = await send('DOM.getDocument', {depth: -1, pierce: true}, page);
        function find(node) {
            if (node.nodeName === 'VISUALQA-OVERLAY') return node;
            for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = find(child); if (found) return found; }
        }
        const host = find(tree.root);
        const found = await send('DOM.querySelector', {nodeId: host.shadowRoots[0].nodeId, selector: 'canvas'}, page);
        const object = await send('DOM.resolveNode', {nodeId: found.nodeId}, page);
        const result = await send('Runtime.callFunctionOn', {objectId: object.object.objectId,
            functionDeclaration: `function(x,y){const rect=this.getBoundingClientRect(), style=getComputedStyle(this);const pixel=[...this.getContext('2d').getImageData(Math.floor((x??rect.width/2)*this.width/rect.width),Math.floor((y??10)*this.height/rect.height),1,1).data];return {width:rect.width,left:rect.left,top:rect.top,minWidth:style.minWidth,flexShrink:style.flexShrink,alpha:pixel[3],pixel};}`, arguments:[{value:sampleX??null},{value:sampleY??null}], returnByValue: true}, page);
        return result.result.value;
    }
    async function bitmapMatches(channel, minimum, other, maximum) {
        const layout = (await state()).overlay.geometry;
        const pixel = (await canvasState(layout.x + layout.imageWidth / 2, Math.max(0, layout.y) + 10)).pixel;
        return pixel[channel] > minimum && pixel[other] < maximum && pixel[3] > 0;
    }
    await resize(1200);
    await until(async () => (await state()).binding.device === 'pc' && (await state()).overlay.missingVariant, 'missing PC hides MO overlay');
    await until(() => tool('[data-tool="missing-variant"]', 'return !this.hidden;'), 'missing variant notice');
    assert.equal((await canvasState()).alpha, 0);
    const pcImage = png(230, 55, 75);
    const pcReview = {...review, name: 'PC 시안', targetId: 'pc', device: 'pc', viewportWidth: 1920, placement: {x: 0, y: 0},
        display: {width: 1920, height: 1920}, revisionId: 'pc-revision',
        image: {mime: 'image/png', width: 80, height: 80, sha256: createHash('sha256').update(pcImage).digest('hex'), base64: pcImage.toString('base64')},
        findings: [{id:'pc-difference', title:'PC 전용 차이', rect:{x:0,y:400,width:100,height:100},selectors:['#hero']}]};
    await tool('[data-tool="manage"]', 'this.click();');
    await evaluate(side, `(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(pcReview))}],'pc.json',{type:'application/json'}));const input=document.querySelector('#import');input.files=transfer.files;input.dispatchEvent(new Event('change'));})()`);
    await until(() => evaluate(side, `document.querySelector('#review-info').textContent.includes('1920px')`), 'PC file import');
    await evaluate(side, `document.querySelector('#connect').click()`, true);
    await until(async () => (await state()).overlay.reviewId && (await state()).binding.device === 'pc' && !(await state()).overlay.missingVariant, 'PC auto pairing');
    await until(() => tool('[data-tool="variant-mo"]', 'return !!this.value;'), 'MO paired in options');
    assert.equal((await state()).overlay.geometry.imageWidth, 1920);
    await until(() => bitmapMatches(0, 200, 2, 100), 'PC bitmap pixels painted');
    const pcCanvas = await canvasState();
    assert.deepEqual({width:pcCanvas.width,left:pcCanvas.left,minWidth:pcCanvas.minWidth,flexShrink:pcCanvas.flexShrink}, {width:1920,left:-360,minWidth:'1920px',flexShrink:'0'});
    assert.ok(pcCanvas.alpha > 0, 'PC image pixels are painted');
    assert.ok(pcCanvas.pixel[0] > 200 && pcCanvas.pixel[2] < 100, 'PC bitmap must be red, not the mobile bitmap');
    assert.equal(await evaluate(page, `document.querySelector('visualqa-overlay').getAttribute('data-visualqa-device')`), 'pc');
    fs.writeFileSync(path.join(root, 'verification/pc-centered-1200.png'), Buffer.from((await send('Page.captureScreenshot', {format:'png'}, page)).data, 'base64'));
    fs.writeFileSync(path.join(root, 'verification/pc-panel.png'), Buffer.from((await send('Page.captureScreenshot', {format:'png'}, side)).data, 'base64'));
    assert.deepEqual(await evaluate(page, `(()=>{const s=getComputedStyle(document.querySelector('visualqa-overlay'));return [s.display,s.justifyContent,s.alignItems];})()`), ['flex','center','flex-start']);
    await tool('[data-tool="dx"]', `this.value='17';this.dispatchEvent(new Event('input'));`);
    await until(async () => (await state()).overlay.settings.dx === 17, 'PC adjustment');
    await resize(1023);
    await until(async () => (await state()).binding.device === 'mo' && (await state()).overlay.reviewId && !(await state()).overlay.missingVariant, '1023 selects only MO');
    assert.equal((await state()).overlay.settings.dx, 0);
    if (!original) {
        await until(() => bitmapMatches(2, 200, 0, 100), 'MO bitmap returns to blue');
    }
    await until(() => tool('[data-tool="findings"]', 'return this.querySelectorAll("li button").length;').then(count => count === 2), 'MO findings replace PC findings');
    await resize(1024);
    await until(async () => (await state()).binding.device === 'pc' && (await state()).overlay.reviewId, '1024 selects only PC');
    assert.equal((await state()).overlay.settings.dx, 17);
    await until(() => bitmapMatches(0, 200, 2, 100), 'PC bitmap replaces the mobile bitmap');
    const restoredPCPixel = (await canvasState()).pixel;
    assert.ok(restoredPCPixel[0] > 200 && restoredPCPixel[2] < 100, 'PC width must replace MO with the PC bitmap');
    await until(() => tool('[data-tool="findings"]', 'return this.querySelectorAll("li button").length;').then(count => count === 1), 'PC findings replace MO findings');
    await resize(2560);
    await until(async () => (await canvasState()).left === 0 && (await canvasState()).width === 2560, 'wide canvas plane');
    assert.equal((await state()).overlay.geometry.imageScreenX, 337);
    await resize(320);
    await until(async () => (await state()).binding.device === 'mo' && (await state()).overlay.reviewId, 'narrow MO selection');
    const moCanvas = await canvasState();
    assert.equal(moCanvas.width, 780); assert.equal(moCanvas.left, -230); assert.equal(moCanvas.minWidth, '780px');
    assert.equal((await state()).overlay.geometry.imageWidth, displayWidth);
    fs.writeFileSync(path.join(root, 'verification/mo-centered-320.png'), Buffer.from((await send('Page.captureScreenshot', {format:'png'}, page)).data, 'base64'));
    assert.equal(await evaluate(page, `document.querySelectorAll('visualqa-overlay').length`), 1);
    // Apply a custom breakpoint and verify both sides of its boundary.
    await tool('[data-tool="breakpoint"]', `this.value='769';this.dispatchEvent(new Event('input'));`);
    await tool('[data-tool="apply-variants"]', 'this.click();');
    await until(async () => (await state()).binding.breakpoint === 769, 'custom breakpoint saved');
    await resize(768);
    await until(async () => (await state()).binding.device === 'mo', 'custom MO boundary');
    await resize(769);
    await until(async () => (await state()).binding.device === 'pc' && (await state()).overlay.reviewId, 'custom PC boundary');
    await until(() => tool('[data-tool="breakpoint"]', 'return Number(this.value);').then(value => value === 769), 'PC toolbar ready');
    await tool('[data-tool="breakpoint"]', `this.value='1024';this.dispatchEvent(new Event('input'));`);
    await tool('[data-tool="apply-variants"]', 'this.click();');
    await until(async () => (await state()).binding.breakpoint === 1024 && (await state()).binding.device === 'mo', 'default breakpoint restored');
    // Resize repeatedly while original image decoding and chunk transfer can still be in flight.
    for (const width of [1400, 390, 1200, 320, 1920, 780]) {
        await send('Emulation.setDeviceMetricsOverride', {width, height:600,deviceScaleFactor:1,mobile:false}, page);
    }
    await until(async () => (await state()).binding.device === 'mo' && (await state()).overlay.reviewId && !(await state()).overlay.missingVariant, 'rapid resize converges');
    await until(() => tool('[data-tool="findings"]', 'return this.querySelectorAll("li button").length;').then(count => count === 2), 'MO tools restored');
    assert.equal(await evaluate(page, `document.querySelectorAll('visualqa-overlay').length`), 1);
    assert.equal(await evaluate(page, 'document.documentElement.scrollHeight'), responsiveHeight);
    // Reconnect the original anchor for the remaining workspace regression checks.
    await evaluate(panel, `(async()=>{const {getReview}=await import('./db.js');const {validateReview}=await import('./core.mjs');const r=await validateReview(${JSON.stringify(review)});return chrome.runtime.sendMessage({type:'connect',tabId:chrome.devtools.inspectedWindow.tabId,reviewId:r.id});})()`);
    await until(() => tool('[data-tool="visible"]', 'return this.checked;'), 'original anchor restored');
    // Controls and reapplication across reloads.
    await tool('[data-tool="visible"]', `this.checked=false;this.dispatchEvent(new Event('input'));`);
    await until(async () => !(await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`)).value.overlay.settings.visible, 'on-page visibility');
    const hidden = await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`);
    assert.equal(hidden.value.overlay.settings.visible, false);
    await send('Page.reload', {}, page);
    await until(() => evaluate(page, `!!document.querySelector('[data-visualqa-extension]')`), 'overlay after reload');
    const restored = await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`);
    assert.equal(restored.value.overlay.settings.visible, false);
    await send('Emulation.setDeviceMetricsOverride', {width: 600, height: 600, deviceScaleFactor: 1, mobile: false}, page);
    const mismatch = await evaluate(panel, `chrome.runtime.sendMessage({type:'status',tabId:chrome.devtools.inspectedWindow.tabId})`);
    assert.equal(mismatch.value.overlay.widthMismatch, true);
    const inspectedTabId = await evaluate(panel, 'chrome.devtools.inspectedWindow.tabId');
    const workspaceTarget = await send('Target.createTarget', {url: extensionOrigin + '/workspace.html?tab=' + inspectedTabId});
    const workspace = await attach(workspaceTarget.targetId); await send('Runtime.enable', {}, workspace);
    await until(() => evaluate(workspace, `document.querySelector('#reviews')?.value && !document.querySelector('#open-page').disabled`), 'standalone workspace');
    console.log('Standalone state:', JSON.stringify(await evaluate(workspace, `({message:document.querySelector('#message').textContent,tabId:chrome.devtools?.inspectedWindow?.tabId,query:location.search})`)));
    assert.equal(await evaluate(workspace, `document.querySelector('#message').classList.contains('error')`), false);
    await send('Emulation.setDeviceMetricsOverride', {width: 1100, height: 1600, deviceScaleFactor: 1, mobile: false}, workspace);
    const workspaceShot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true}, workspace);
    fs.writeFileSync(path.join(root, 'verification/chrome-workspace.png'), Buffer.from(workspaceShot.data, 'base64'));
    await evaluate(workspace, `document.querySelector('#open-page').click()`, true);
    const openedTarget = await until(async () => (await targets()).find(target => target.type === 'page' && target.url === url && target.targetId !== targetId), 'open actual page');
    const openedPage = await attach(openedTarget.targetId);
    await until(() => evaluate(openedPage, `!!document.querySelector('[data-visualqa-extension]')`), 'overlay on opened page');
    await send('Emulation.setDeviceMetricsOverride', {width: 1100, height: 1600, deviceScaleFactor: 1, mobile: false}, frontSession);
    const preview = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true}, frontSession);
    fs.writeFileSync(path.join(root, 'verification/chrome-devtools.png'), Buffer.from(preview.data, 'base64'));
    receipt = {status: 'PASS', extensionVersion: manifest.version, testedFiles, browser: (await send('Browser.getVersion')).product, tests: ['original design import', 'original image overlay', 'registered and renderer versions match', 'sidepanel applied version visible', 'PC and MO distinct bitmap pixels', 'native Chrome sidepanel', 'DevTools without sidePanel namespace', 'no page tool panel', 'unchanged page styles and geometry', 'sidepanel file import and connection', 'options and findings tabs', 'keyboard tab navigation', 'finding list rendering', 'finding list navigation', 'previous and next findings', 'sidepanel opacity', 'active tab isolation', 'native sidepanel close and reopen', 'sidepanel export through native DevTools', 'strict image CSP overlay', 'pointer passthrough', 'unchanged layout height', 'finding navigation', 'native Elements selection', 'DOM edits', 'native Styles edits', 'cross-origin CSS edits', 'runtime CSSOM rules', 'form state', 'ZIP export', 'overlay and tools excluded from HTML', 'relative CSS imports and asset URLs', 'original HTML and CSS filenames', 'duplicate filenames separated by folder', 'authored CSS CRLF and indentation', 'authored CSS comments', 'CSS URL whitespace and quote preservation', 'Five Server scripts styles markup removed', 'review scripts styles markup removed', 'adopted tooling stylesheet removed', 'legitimate scripts and inline style preserved', 'hide toggle', 'reload reapplication', 'viewport mismatch', 'stale overlay cleanup', 'missing variant hides wrong design', 'PC and MO automatic pairing', '1023 and 1024 boundary switching', 'fixed minimum canvas width', 'flex centered canvas', 'PC and MO independent adjustments', 'variant findings switch', 'wide and narrow viewport geometry', 'custom breakpoint', 'rapid resize convergence', 'standalone extension workspace', 'open actual page with overlay'],
        cssBenchmark, originalImage: {width: imageWidth, height: imageHeight, display: review.display},
        cssFiles: detail.manifest.stylesheets.length, cssSources: detail.manifest.stylesheets, warnings: detail.manifest.warnings, zip: zipPath};
    fs.writeFileSync(path.join(root, 'verification/chrome-extension.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
    }
    await verify();
} catch (error) {
    console.error(error.stack, errors); process.exitCode = 1;
    let frontend;
    if (devtoolsParent) {
        const session = await attach(devtoolsParent); await send('Runtime.enable', {}, session);
        frontend = await evaluate(session, `(()=>{const tabs=[],frames=[];function visit(root){for(const node of root.querySelectorAll('*')){if(node.getAttribute('role')==='tab')tabs.push({text:node.textContent,selected:node.getAttribute('aria-selected')});if(node.tagName==='IFRAME')frames.push(node.src);if(node.shadowRoot)visit(node.shadowRoot);}}visit(document);return {tabs,frames};})()`);
    }
    fs.writeFileSync(path.join(root, 'verification/chrome-extension-failure.json'), JSON.stringify({error: error.stack, errors, frontend, targets: await targets().catch(() => []), events: events.filter(event => ['Runtime.exceptionThrown','Runtime.consoleAPICalled','Log.entryAdded'].includes(event.method))}, null, 2));
} finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('test ended')); }
    socket?.close(); chrome.kill('SIGTERM'); await pause(700); if (chrome.exitCode === null) chrome.kill('SIGKILL');
    server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close();
    fs.rmSync(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
