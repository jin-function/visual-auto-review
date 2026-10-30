#!/usr/bin/env node
// Browser transport and capture. Site rules live in profiles.json/page_state.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { openAccordions } = require('./page_state');
const { inspectSource } = require('./inspect_source');
const [chromePath, url, widthText, heightText, outputPath, configPath, inspectSelector] = process.argv.slice(2);
const width = Number(widthText), height = Number(heightText);
if (!chromePath || !url || !Number.isInteger(width) || !Number.isInteger(height) || !outputPath || !configPath) {
    console.error('캡처 실행 인수가 올바르지 않습니다.');
    process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-qa-v3-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
let browserError = '', socket, cleaned = false;
chrome.stderr.on('data', data => { browserError = (browserError + data).slice(-3000); });
chrome.on('error', error => { browserError = error.message; });
const pending = new Map();
async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (socket) socket.close();
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(800)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('캡처가 종료되었습니다.')); }
    pending.clear();
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await cleanup(); process.exit(1); });

async function main() {
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
        const file = path.join(directory, 'DevToolsActivePort');
        if (fs.existsSync(file)) { port = fs.readFileSync(file, 'utf8').trim().split('\n')[0]; break; }
        if (chrome.exitCode !== null || browserError.includes('ENOENT')) break;
        await delay(100);
    }
    if (!port) throw new Error(`Chrome을 시작하지 못했습니다. ${browserError.slice(-500)}`);
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
    const page = pages.find(p => p.type === 'page');
    if (!page) throw new Error('Chrome 페이지를 찾을 수 없습니다.');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chrome 연결 시간이 초과되었습니다.')), 5000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome 연결에 실패했습니다.')); }, { once: true });
    });
    let nextId = 0;
    const resourceFailures = [], consoleErrors = [], responses = [], sheets = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'CSS.styleSheetAdded') sheets.set(message.params.header.styleSheetId, message.params.header);
        if (message.method === 'Network.loadingFailed') resourceFailures.push({ ...message.params });
        if (message.method === 'Network.responseReceived' && message.params.response.status >= 400)
            responses.push({ url: message.params.response.url, status: message.params.response.status });
        if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result || {});
    });
    socket.addEventListener('close', () => {
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Chrome 연결이 끊어졌습니다.')); }
        pending.clear();
    });
    function send(method, params = {}) {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: 응답 시간이 초과되었습니다.`)); }, profile.timeoutMs);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async function evaluate(expression, awaitPromise = false) {
        const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 600, screenWidth: width, screenHeight: height });
    const browser = await send('Browser.getVersion');
    const navigation = await send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(`페이지 이동 실패: ${navigation.errorText}`);
    await evaluate(`(async () => {
        const deadline = Date.now() + ${Number(profile.timeoutMs)};
        while (location.href === 'about:blank' || document.readyState !== 'complete' || !document.querySelector(${JSON.stringify(profile.readySelector)})) {
            if (Date.now() > deadline) throw new Error('페이지 준비 시간이 초과되었습니다.');
            await new Promise(r => setTimeout(r, 100));
        }
        if (location.href.startsWith('chrome-error://')) throw new Error('페이지를 불러오지 못했습니다.');
        await document.fonts.ready;
        return true;
    })()`, true);
    // This is the original accordion operation, including attribute/style changes.
    const toggles = await openAccordions(send, profile, delay);
    await evaluate(`(async () => {
        const deadline = Date.now() + ${Number(profile.timeoutMs)};
        const step = Math.max(200, Math.floor(innerHeight * .8));
        let y = 0;
        while (y < Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)) {
            scrollTo(0, y);
            await new Promise(r => setTimeout(r, 50));
            y += step;
            if (Date.now() > deadline) throw new Error('지연 로딩 확인 시간이 초과되었습니다.');
        }
        scrollTo(0, 0);
        await Promise.all(Array.from(document.images).map(image => {
            if (image.complete) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('이미지 로딩 시간이 초과되었습니다.')), 10000);
                const done = () => { clearTimeout(timer); resolve(); };
                image.addEventListener('load', done, {once:true});
                image.addEventListener('error', done, {once:true});
            });
        }));
        await document.fonts.ready;
        const style = document.createElement('style');
        style.dataset.visualQa = 'capture-stability';
        style.textContent = '*,*::before,*::after { animation-play-state: paused !important; caret-color: transparent !important; }';
        document.head.appendChild(style);
        return true;
    })()`, true);
    let last = '', stable = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
        const layout = await evaluate('JSON.stringify([document.documentElement.scrollWidth, document.documentElement.scrollHeight, document.body.scrollHeight])');
        stable = layout === last ? stable + 1 : 0; last = layout;
        if (stable >= 3) break;
        await delay(profile.settleMs);
    }
    if (stable < 3) throw new Error('페이지 높이가 안정되지 않았습니다. 움직이는 콘텐츠와 캡처 범위를 확인하세요.');
    if (inspectSelector) {
        const result = await inspectSource(send, evaluate, inspectSelector, sheets);
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        return;
    }
    const measured = await evaluate(`(() => {
        const captureElement = ${JSON.stringify(profile.captureSelector)} ? document.querySelector(${JSON.stringify(profile.captureSelector)}) : null;
        if (${JSON.stringify(profile.captureSelector)} && !captureElement) throw new Error('캡처 범위 선택자를 찾을 수 없습니다.');
        const captureRect = captureElement?.getBoundingClientRect();
        const clip = captureRect ? {x:Math.round(captureRect.left+scrollX),y:Math.round(captureRect.top+scrollY),width:Math.round(captureRect.width),height:Math.round(captureRect.height)} :
            {x:0,y:0,width:innerWidth,height:Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)};
        function selectorFor(element) {
            if (element.id) return '#' + CSS.escape(element.id);
            const parts = [];
            for (let node = element; node && node !== document.body; node = node.parentElement) {
                let part = node.tagName.toLowerCase();
                const classes = Array.from(node.classList).filter(s => !/^(active|open|on|is-)/.test(s)).slice(0,2);
                if (classes.length) part += '.' + classes.map(CSS.escape).join('.');
                const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(e => e.tagName === node.tagName) : [];
                if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node)+1) + ')';
                parts.unshift(part);
                if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
            }
            return parts.join(' > ');
        }
        function rectFor(rect) {return {x:Math.round(rect.left+scrollX-clip.x),y:Math.round(rect.top+scrollY-clip.y),width:Math.round(rect.width),height:Math.round(rect.height)};}
        const preferred = ${JSON.stringify(profile.diagnosticRoots)}.flatMap(s => Array.from(document.querySelectorAll(s)));
        const roots = captureElement ? [captureElement] : preferred.length ? preferred : [document.querySelector('main') || document.body];
        const elements = Array.from(new Set(roots.flatMap(root => [root,...root.querySelectorAll(${JSON.stringify(profile.elementSelector)})])));
        const visible = elements.filter(e => {const r=e.getBoundingClientRect();return r.width>2 && r.height>2 && getComputedStyle(e).visibility!=='hidden';});
        const domElements = visible.slice(0,3000).map(element => {
            const style=getComputedStyle(element);
            return {selector:selectorFor(element), tag:element.tagName.toLowerCase(),text:(element.innerText||element.alt||'').replace(/\\s+/g,' ').trim().slice(0,240),
                rect:rectFor(element.getBoundingClientRect()),styles:Object.fromEntries(['display','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','wordSpacing','color','backgroundColor','margin','padding','gap','width','height'].map(key=>[key,style[key]]))};
        });
        const textRects=[];
        for (const root of roots) {
            const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
            while(walker.nextNode()) {
                const node=walker.currentNode;
                if (!node.textContent.trim() || ['SCRIPT','STYLE','NOSCRIPT'].includes(node.parentElement.tagName)) continue;
                const range=document.createRange();range.selectNodeContents(node);
                for(const rect of range.getClientRects()) if(rect.width && rect.height) textRects.push(rectFor(rect));
            }
        }
        return {innerWidth,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clip,domElements,textRects,
            diagnosticsTruncated:visible.length>3000,
            brokenImages:Array.from(document.images).filter(i=>i.complete&&!i.naturalWidth).map(i=>i.currentSrc||i.src),
            fonts:Array.from(document.fonts).map(f=>({family:f.family,status:f.status,weight:f.weight})),url:location.href,userAgent:navigator.userAgent,capturedAt:new Date().toISOString()};
    })()`);
    if (measured.innerWidth !== width || measured.clientWidth !== width) throw new Error('요청한 뷰포트 폭과 렌더링 폭이 다릅니다.');
    if (measured.clip.width * measured.clip.height > 100000000 || measured.clip.width <= 0 || measured.clip.height <= 0) throw new Error('캡처 영역은 1억 픽셀 이하여야 합니다.');
    const screenshot = await send('Page.captureScreenshot', { format:'png', fromSurface:true,captureBeyondViewport:true,clip:{...measured.clip,scale:1} });
    fs.writeFileSync(outputPath,Buffer.from(screenshot.data,'base64'));
    fs.writeFileSync(`${outputPath}.json`,JSON.stringify({...measured,...toggles,browser,resourceFailures,httpErrors:responses,consoleErrors,profile},null,2));
}
main().catch(error => {console.error(error.stack||String(error));process.exitCode=1;}).finally(cleanup);
