import {getReview, getReviewMeta, getPackage, listReviews} from './db.js';
import {DEFAULT_BREAKPOINT, deviceForWidth, initialVariants} from './responsive.mjs';
import {pageURL, samePage, overlaySettings} from './core.mjs';
import {requireSidePanel} from './extension-state.mjs';

import {binding, preferences, storeBinding, removeBinding} from './session.mjs';
const uiPorts = new Set(), errors = new Map();
function changed(tabId, reason) { for (const port of uiPorts) { try { port.postMessage({type: 'changed', tabId, reason}); } catch { uiPorts.delete(port); } } }
function failed(tabId, error) { errors.set(tabId, error.message); changed(tabId); }
const running = new Map(), pendingApplies = new Map();
const devtoolsPorts = new Map(), devtoolsRequests = new Map(), downloads = new Map();
async function send(tabId, message) { return chrome.tabs.sendMessage(tabId, message, {frameId: 0}); }
function originalReview(review) {
    if (!review || review.version !== 2 || review.imageRole !== 'reference-original') throw new Error('시안 원본이 포함된 새 검수 파일을 앱에서 다시 저장해 불러오세요.');
    return review;
}
function fromDevtools(tabId, command) {
    const port = devtoolsPorts.get(tabId);
    if (!port) throw new Error('Chrome 개발자도구를 먼저 열어 주세요. (⌘⌥I)');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { devtoolsRequests.delete(requestId); reject(new Error('개발자도구 응답이 지연됩니다. 다시 시도하세요.')); }, 30000);
        devtoolsRequests.set(requestId, {port, resolve, reject, timer});
        port.postMessage({requestId, ...command});
    });
}

function exclusive(tabId, operation) {
    const task = (running.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    running.set(tabId, task);
    task.finally(() => { if (running.get(tabId) === task) running.delete(tabId); }).catch(() => {});
    return task;
}
async function newBinding(review, settings) {
    const group = await getPackage(review.packageId), saved = await preferences(review.packageId);
    const variants = initialVariants(review, await listReviews(), samePage);
    const restored = saved.customVariants;
    if (group?.legacy && restored) {
        for (const device of ['pc', 'mo']) if (!restored[device] || (await getReviewMeta(restored[device]))?.packageId === review.packageId) variants[device] = restored[device] || null;
    }
    return {reviewId: review.id, packageId: review.packageId, packageVersion: group?.version || 2, legacy: group?.legacy !== false,
        activeReviewId: null, breakpoint: saved.breakpoint || group?.breakpoint || DEFAULT_BREAKPOINT,
        variants, customVariants: !!restored, settings: overlaySettings(settings || saved.settings),
        adjustments: saved.adjustments || {[review.id]: {dx: settings?.dx || 0, dy: settings?.dy || 0, scale: settings?.scale || 1}}};
}
async function selectedReview(message) {
    const group = message.packageId && await getPackage(message.packageId);
    return originalReview(await getReviewMeta(group?.reviewIds[0] || message.reviewId));
}
async function reconcile(tabId) {
    for (let attempt = 0; attempt < 4; attempt++) {
        let config = await binding(tabId);
        if (!config) throw new Error('이 탭에 검수 파일을 연결하세요.');
        const anchor = originalReview(await getReviewMeta(config.reviewId));
        if (!config.variants || !config.packageId) {
            const upgraded = await newBinding(anchor, config.settings);
            config = {...upgraded, adjustments: config.adjustments || upgraded.adjustments,
                breakpoint: config.breakpoint || upgraded.breakpoint};
        }
        const tab = await chrome.tabs.get(tabId);
        if (!samePage(tab.url, anchor.url)) throw new Error('검수 파일에 기록된 실제 페이지에서 사용하세요.');
        await chrome.scripting.executeScript({target: {tabId}, files: ['overlay-layout.js', 'content.js']});
        const state = await send(tabId, {type: 'status'});
        const device = deviceForWidth(state.viewportWidth, config.breakpoint);
        const nextId = config.variants[device];
        const candidate = nextId ? await getReviewMeta(nextId) : null;
        const review = candidate ? originalReview(candidate) : null;
        if (!review) config.variants[device] = null;
        if (review && !samePage(review.url, anchor.url)) throw new Error('같은 페이지의 PC·MO 시안을 선택하세요.');
        if (config.activeReviewId !== (review?.id || null)) {
            config.settings = overlaySettings({...config.settings, dx: 0, dy: 0, scale: 1, ...config.adjustments[review?.id]});
        }
        config.activeReviewId = review?.id || null; config.device = device;
        const base = review || anchor;
        const meta = {name: base.name, url: base.url, packageId: config.packageId, reviewId: review?.id || null, device, breakpoint: config.breakpoint,
            placement: base.placement, width: base.image.width, height: base.image.height, display: base.display,
            imageRole: base.imageRole, viewportWidth: base.viewportWidth, settings: config.settings, devtoolsReady: devtoolsPorts.has(tabId)};
        let result;
        if (!review) result = await send(tabId, {type: 'empty', meta});
        else if (state.reviewId === review.id && state.connected && !state.switching) result = await send(tabId, {type: 'settings', settings: config.settings});
        else if (state.cachedReviewIds?.includes(review.id)) result = await send(tabId, {type: 'reuse', transferId: crypto.randomUUID(), meta});
        else {
            const image = (await getReview(review.id)).image;
            const transferId = crypto.randomUUID();
            const beginning = await send(tabId, {type: 'begin', transferId, meta});
            if (beginning?.error) throw new Error(beginning.error);
            for (let start = 0, index = 0; start < image.base64.length; start += 524288, index++) {
                const chunk = await send(tabId, {type: 'chunk', transferId, index, data: image.base64.slice(start, start + 524288)});
                if (chunk?.error) throw new Error(chunk.error);
            }
            result = await send(tabId, {type: 'finish', transferId});
        }
        if (result?.error) throw new Error(result.error);
        if (result?.stale || deviceForWidth(result.viewportWidth, config.breakpoint) !== device) continue;
        await storeBinding(tabId, config, true);
        errors.delete(tabId); changed(tabId);
        return result;
    }
    // A continuously resized window should converge to its final width without painting the wrong device.
    setTimeout(() => apply(tabId).catch(error => failed(tabId, error)), 100);
    return send(tabId, {type: 'status'});
}
function apply(tabId) {
    if (pendingApplies.has(tabId)) return pendingApplies.get(tabId);
    const task = exclusive(tabId, () => reconcile(tabId));
    pendingApplies.set(tabId, task);
    task.finally(() => { if (pendingApplies.get(tabId) === task) pendingApplies.delete(tabId); }).catch(() => {});
    return task;
}

async function handle(message) {
    const tabId = message.tabId;
    if (message.type === 'open') {
        const review = await selectedReview(message);
        const tab = await chrome.tabs.create({url: pageURL(review.url).href});
        await storeBinding(tab.id, await newBinding(review));
        if ((await chrome.tabs.get(tab.id)).status === 'complete') await apply(tab.id);
        return {tabId: tab.id};
    }
    if (!Number.isInteger(tabId) && !['imported', 'forget-package'].includes(message.type)) throw new Error('검수할 Chrome 탭을 선택하세요.');
    if (message.type === 'open-sidepanel') {
        requireSidePanel(chrome.runtime.getManifest(), chrome.sidePanel);
        // Keep this call before any await so the click remains a user gesture.
        await chrome.sidePanel.open({tabId});
        await chrome.tabs.update(tabId, {active: true});
        return {opened: true};
    }
    if (message.type === 'connect') {
        const review = await selectedReview(message);
        const tab = await chrome.tabs.get(tabId);
        if (!samePage(tab.url, review.url)) throw new Error('현재 탭과 검수 파일의 페이지 주소가 다릅니다. 실제 페이지 열기를 사용하세요.');
        return exclusive(tabId, async () => {
            await storeBinding(tabId, await newBinding(review, message.settings));
            return reconcile(tabId);
        });
    }
    if (message.type === 'status') {
        const config = await binding(tabId);
        let overlay;
        try { overlay = await send(tabId, {type: 'status'}); } catch { /* Not connected yet. */ }
        return {binding: config, overlay, error: errors.get(tabId) || null, devtoolsReady: devtoolsPorts.has(tabId)};
    }
    if (message.type === 'rendered') { changed(tabId); return {updated: true}; }
    if (message.type === 'viewport') {
        const config = await binding(tabId);
        if (!config) return {ignored: true};
        if (deviceForWidth(message.width, config.breakpoint) === config.device) return {unchanged: true};
        return apply(tabId);
    }
    if (message.type === 'imported') {
        const saved = await chrome.storage.session.get(null);
        for (const [key, config] of Object.entries(saved)) {
            if (!key.startsWith('tab:')) continue;
            const anchorMeta = await getReviewMeta(config.reviewId);
            if ((config.packageId || anchorMeta?.packageId) !== message.packageId) continue;
            const id = Number(key.slice(4));
            await exclusive(id, async () => {
                const anchor = await getReviewMeta(config.reviewId);
                if (!anchor) return;
                if (!config.customVariants) config.variants = initialVariants(anchor, await listReviews(), samePage);
                await storeBinding(id, config);
                try { await reconcile(id); } catch (error) { failed(id, error); }
            });
        }
        changed(undefined, 'packages'); return {imported: true};
    }
    if (message.type === 'forget-package') {
        const saved = await chrome.storage.session.get(null);
        for (const [key, config] of Object.entries(saved)) {
            if (!key.startsWith('tab:') || config.packageId !== message.packageId) continue;
            const id = Number(key.slice(4));
            await exclusive(id, async () => {
                await removeBinding(id); errors.delete(id);
                try { await send(id, {type: 'remove'}); } catch { /* Navigated pages have no overlay. */ }
                changed(id);
            });
        }
        return {removed: true};
    }
    if (message.type === 'responsive') {
        return exclusive(tabId, async () => {
            const config = await binding(tabId);
            if (!config) throw new Error('먼저 오버레이를 연결하세요.');
            const anchor = originalReview(await getReviewMeta(config.reviewId));
            const breakpoint = Number(message.breakpoint);
            if (!Number.isInteger(breakpoint) || breakpoint < 320 || breakpoint > 4096) throw new Error('PC 전환 폭은 320~4096px 정수로 입력하세요.');
            const variants = config.legacy ? {pc: null, mo: null} : {...config.variants};
            for (const device of config.legacy ? ['pc', 'mo'] : []) {
                const id = message.variants?.[device];
                if (!id) continue;
                const candidate = originalReview(await getReviewMeta(id));
                if (!samePage(anchor.url, candidate.url)) throw new Error('같은 페이지의 PC·MO 시안을 선택하세요.');
                variants[device] = id;
            }
            if (variants.pc && variants.pc === variants.mo) throw new Error('PC와 MO에 서로 다른 시안을 선택하세요.');
            config.variants = variants; config.breakpoint = breakpoint; config.customVariants = config.legacy;
            await storeBinding(tabId, config, true);
            return reconcile(tabId);
        });
    }
    if (message.type === 'settings') {
        return exclusive(tabId, async () => {
            const config = await binding(tabId);
            if (!config) throw new Error('먼저 오버레이를 연결하세요.');
            if (message.reviewId && message.reviewId !== config.activeReviewId) throw new Error('화면 크기가 바뀌었습니다. 현재 시안의 옵션을 다시 조정하세요.');
            config.settings = overlaySettings(message.settings);
            if (config.activeReviewId) config.adjustments[config.activeReviewId] = {dx: config.settings.dx, dy: config.settings.dy, scale: config.settings.scale};
            await storeBinding(tabId, config, true);
            const result = await send(tabId, {type: 'settings', settings: config.settings});
            changed(tabId); return result;
        });
    }
    if (message.type === 'jump') {
        const config = await binding(tabId), review = config && await getReviewMeta(config.activeReviewId);
        if (message.reviewId && message.reviewId !== config?.activeReviewId) throw new Error('화면 크기가 바뀌었습니다. 현재 시안의 차이 항목을 선택하세요.');
        const finding = review?.findings.find(item => item.id === message.findingId);
        if (!finding) throw new Error('차이 항목을 찾을 수 없습니다.');
        return send(tabId, {type: 'jump', rect: finding.rect});
    }
    if (message.type === 'export-request' || message.type === 'inspect-request') {
        const config = await binding(tabId), review = originalReview(config && await getReviewMeta(config.activeReviewId || config.reviewId));
        const tab = await chrome.tabs.get(tabId);
        if (!samePage(tab.url, review.url)) throw new Error('검수 페이지 주소가 바뀌었습니다. 원래 페이지에서 다시 연결하세요.');
        if (message.type === 'inspect-request') {
            if (!config.activeReviewId || (message.reviewId && message.reviewId !== config.activeReviewId)) throw new Error('현재 화면에 맞는 시안의 차이 항목을 선택하세요.');
            const selector = review.findings.find(finding => finding.id === message.findingId)?.selectors[message.selectorIndex];
            if (typeof selector !== 'string') throw new Error('선택할 관련 요소가 없습니다.');
            return fromDevtools(tabId, {type: 'inspect', url: review.url, selector});
        }
        const prepared = await fromDevtools(tabId, {type: 'export', url: review.url,
            review: {name: review.name, runId: review.runId, revisionId: review.revisionId, packageId: config.packageId, targetId: review.targetId, device: config.device, appVersion: review.appVersion}, settings: config.settings});
        const expected = 'blob:' + chrome.runtime.getURL('');
        if (!prepared.url?.startsWith(expected)) throw new Error('내보내기 파일 주소가 올바르지 않습니다.');
        const id = await chrome.downloads.download({url: prepared.url, filename: prepared.filename, saveAs: config.settings.saveAs !== false});
        downloads.set(id, {port: devtoolsPorts.get(tabId), url: prepared.url});
        return {downloadId: id, warnings: prepared.warnings};
    }
    if (message.type === 'remove') {
        return exclusive(tabId, async () => {
            await removeBinding(tabId); errors.delete(tabId); changed(tabId);
            try { await send(tabId, {type: 'remove'}); } catch { /* Page may have navigated. */ }
            return {removed: true};
        });
    }
    throw new Error('지원하지 않는 요청입니다.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
    const content = !extensionPage && sender.tab && sender.frameId === 0 && ['viewport', 'rendered'].includes(message.type);
    if (!extensionPage && !content) return false;
    (async () => {
        if (content) {
            const config = await binding(sender.tab.id), review = config && await getReviewMeta(config.reviewId);
            if (!review || !samePage(sender.url, review.url)) throw new Error('현재 검수 페이지에 연결된 도구만 사용할 수 있습니다.');
        }
        return handle(content ? {...message, tabId: sender.tab.id} : message);
    })().then(value => respond({ok: true, value})).catch(error => respond({ok: false, error: error.message}));
    return true;
});
chrome.runtime.onConnect.addListener(port => {
    if (port.name === 'visualqa-ui' && port.sender?.id === chrome.runtime.id && port.sender.url?.startsWith(chrome.runtime.getURL(''))) {
        uiPorts.add(port); port.onDisconnect.addListener(() => uiPorts.delete(port)); return;
    }
    if (port.name !== 'visualqa-devtools' || port.sender?.id !== chrome.runtime.id || port.sender.url !== chrome.runtime.getURL('devtools.html')) return;
    let tabId;
    port.onMessage.addListener(message => {
        if (message.type === 'hello' && Number.isInteger(message.tabId)) {
            tabId = message.tabId; devtoolsPorts.set(tabId, port); changed(tabId);
            send(tabId, {type: 'devtools-state', ready: true}).catch(() => {});
        }
        const item = devtoolsRequests.get(message.requestId);
        if (item?.port === port) {
            clearTimeout(item.timer); devtoolsRequests.delete(message.requestId);
            message.ok ? item.resolve(message.value) : item.reject(new Error(message.error));
        }
    });
    port.onDisconnect.addListener(() => {
        if (devtoolsPorts.get(tabId) === port) { devtoolsPorts.delete(tabId); changed(tabId); send(tabId, {type: 'devtools-state', ready: false}).catch(() => {}); }
        for (const [id, item] of devtoolsRequests) if (item.port === port) {
            clearTimeout(item.timer); devtoolsRequests.delete(id); item.reject(new Error('개발자도구 연결이 닫혔습니다.'));
        }
    });
});
chrome.downloads.onChanged.addListener(delta => {
    if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
    const item = downloads.get(delta.id); if (!item) return;
    try { item.port?.postMessage({type: 'release-url', url: item.url}); } catch { /* DevTools may have closed. */ }
    downloads.delete(delta.id);
});
if (typeof chrome.sidePanel?.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);
} else {
    chrome.action.onClicked.addListener(tab => {
        chrome.tabs.create({url: chrome.runtime.getURL(`workspace.html?tab=${tab.id}`)});
    });
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'complete') binding(tabId).then(config => config && apply(tabId)).catch(error => failed(tabId, error));
});
chrome.tabs.onRemoved.addListener(tabId => { removeBinding(tabId); errors.delete(tabId); });
