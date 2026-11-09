import {getReviewMeta, getPackage, putPackage, listPackages, listReviews, deletePackage} from './db.js';
import {validatePackage, pageURL, samePage, MAX_PACKAGE_BYTES} from './core.mjs';
import {request, subscribe} from './client.mjs';
import {sidePanelRegistered, RELOAD_GUIDANCE} from './extension-state.mjs';

export async function createReviewView() {
    const $ = id => document.getElementById(id);
    const devtoolsTab = chrome.devtools?.inspectedWindow?.tabId;
    const fixedTab = Number.isInteger(devtoolsTab) ? devtoolsTab : Number(new URL(location.href).searchParams.get('tab')) || null;
    const windowId = (await chrome.windows.getCurrent()).id;
    const manifest = chrome.runtime.getManifest();
    let tabId = fixedTab, bound, tools, toolKey, managing = false, generation = 0, selected;
    let reviews = new Map(), toolbarState;
    function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
    function action(operation) {
        return async event => {
            const button = event.currentTarget;
            if (button.tagName === 'BUTTON') button.disabled = true;
            try { await operation(event); } catch (error) { message(error.message, true); }
            finally { if (button.tagName === 'BUTTON') button.disabled = false; }
        };
    }
    async function selectPackage() {
        const sequence = ++generation, id = $('reviews').value;
        const group = id ? await getPackage(id) : null;
        if (sequence !== generation) return;
        selected = group;
        const targets = group ? group.reviewIds.map(id => reviews.get(id)).filter(Boolean) : [];
        $('review-info').textContent = group ? [group.url, ...targets.map(t => `${(t.device || (t.viewportWidth < 1024 ? 'mo' : 'pc')).toUpperCase()} · 검수 폭 ${t.viewportWidth}px · 차이 ${t.findings.length}개`)].join('\n') : '';
        $('connect').disabled = $('open-page').disabled = $('delete-review').disabled = !group;
    }
    async function loadPackages(preferred) {
        const [saved, metadata] = await Promise.all([listPackages(), listReviews()]);
        reviews = new Map(metadata.map(review => [review.id, review]));
        $('reviews').replaceChildren();
        for (const group of saved) {
            const option = document.createElement('option'); option.value = group.id;
            option.textContent = `${group.legacy ? '이전 개별 파일' : '통합 검수'} · ${group.name}`;
            $('reviews').append(option);
        }
        if (!saved.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '파일을 불러오세요'; $('reviews').append(option); }
        if (preferred && saved.some(group => group.id === preferred)) $('reviews').value = preferred;
        await selectPackage();
    }
    function showTools(connected) {
        $('tools').hidden = !connected || managing;
        $('connection').hidden = connected && !managing;
        $('back').hidden = !connected;
    }
    async function refresh() {
        const sequence = ++generation;
        if (!fixedTab) tabId = (await chrome.tabs.query({active: true, windowId}))[0]?.id;
        if (sequence !== generation) return;
        if (!Number.isInteger(tabId)) { showTools(false); return; }
        const result = await request('status', {tabId});
        if (sequence !== generation) return;
        bound = result.binding;
        const reviewId = bound?.activeReviewId || bound?.reviewId;
        const review = reviews.get(reviewId) || (reviewId && await getReviewMeta(reviewId));
        if (sequence !== generation) return;
        const connected = result.overlay?.connected && review?.version === 2;
        if (connected) {
            const nextKey = `${tabId}:${reviewId}:${bound.device}:${bound.activeReviewId || ''}:${reviews.get(reviewId)?.importedAt}`;
            if (toolKey !== nextKey) {
                toolbarState = tools?.viewState() || toolbarState; tools?.destroy(); tools = null;
                const target = tabId, packageId = bound.packageId;
                const variants = {};
                for (const device of ['pc', 'mo']) variants[device] = reviews.get(bound.variants[device])?.name || null;
                const meta = {...review, width: review.image.width, height: review.image.height, packageId, legacy: bound.legacy, device: bound.device,
                    findings: bound.activeReviewId ? review.findings : [], availableVariants: variants,
                    availableReviews: [...reviews.values()].filter(item => samePage(item.url, review.url)).map(item => ({id: item.id, name: item.name, viewportWidth: item.viewportWidth}))};
                tools = VisualQAToolbar.create(meta, bound.settings, async (type, payload = {}) => {
                    if (type === 'manage') { managing = true; await loadPackages(packageId); showTools(true); return {managed: true}; }
                    if (!fixedTab && (await chrome.tabs.query({active: true, windowId}))[0]?.id !== target) throw new Error('검수 탭이 바뀌었습니다. 현재 탭의 도구를 선택하세요.');
                    if (tabId !== target || bound?.packageId !== packageId) throw new Error('검수 연결이 바뀌었습니다. 현재 도구를 확인하세요.');
                    const value = await request(type, {tabId: target, ...payload, reviewId: bound.activeReviewId});
                    if (type === 'remove') { managing = false; }
                    await refresh();
                    return value;
                }, toolbarState);
                toolKey = nextKey;
            }
            tools.update(bound.settings, {...result.overlay, binding: bound, error: result.error, devtoolsReady: result.devtoolsReady});
        } else { tools?.destroy(); tools = null; toolKey = null; }
        if (result.error) message(result.error, true);
        showTools(connected);
    }
    function permission(group) {
        const url = pageURL(group.url);
        return chrome.permissions.request({origins: [`${url.protocol}//${url.hostname}/*`]});
    }
    $('extension-info').textContent = `Chrome에 적용된 확장 v${manifest.version}`;
    $('reload-extension').hidden = sidePanelRegistered(manifest);
    $('reload-extension').addEventListener('click', action(() => chrome.tabs.create({url: `chrome://extensions/?id=${chrome.runtime.id}`})));
    $('open-sidepanel').addEventListener('click', action(async () => {
        if (!sidePanelRegistered(manifest)) { $('reload-extension').hidden = false; throw new Error(RELOAD_GUIDANCE); }
        await request('open-sidepanel', {tabId});
    }));
    $('import').addEventListener('change', action(async event => {
        const file = event.target.files[0]; if (!file) return;
        if (file.size > MAX_PACKAGE_BYTES) throw new Error('검수 파일이 너무 큽니다.');
        message('PC·MO 시안과 검수 정보를 확인하고 있습니다.');
        const group = await validatePackage(JSON.parse(await file.text()));
        await putPackage(group); await loadPackages(group.id);
        await request('imported', {tabId, packageId: group.id}); event.target.value = '';
        message('파일을 불러왔습니다. PC·MO 등록 상태를 확인하고 현재 페이지에 연결하세요.' +
            (group.captureOptions?.removeHidden ? '\n연결하면 앱의 hidden 속성 제거 설정이 적용됩니다.' : ''));
    }));
    $('reviews').addEventListener('change', action(selectPackage));
    for (const [id, type] of [['connect', 'connect'], ['open-page', 'open']]) $(id).addEventListener('click', action(async () => {
        const group = selected;
        if (!group) throw new Error('검수 파일을 먼저 불러오세요.');
        if (!await permission(group)) throw new Error('이 페이지 접근을 허용하세요.');
        await request(type, {tabId, packageId: group.id}); managing = false; await refresh();
    }));
    $('delete-review').addEventListener('click', action(async () => {
        if (!selected) return;
        await request('forget-package', {tabId, packageId: selected.id});
        await deletePackage(selected.id);
        await request('imported', {tabId, packageId: selected.id}); await loadPackages(); await refresh();
        message('확장에 불러온 묶음을 제거했습니다. 앱의 검수 이력은 보존됩니다.');
    }));
    $('back').addEventListener('click', action(async () => { managing = false; await refresh(); }));
    chrome.tabs.onActivated.addListener(info => { if (!fixedTab && info.windowId === windowId) { managing = false; refresh().catch(error => message(error.message, true)); } });
    chrome.tabs.onUpdated.addListener(id => { if (id === tabId) refresh().catch(error => message(error.message, true)); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh().catch(error => message(error.message, true)); });
    await loadPackages(); await refresh();
    const unsubscribe = subscribe((id, reason) => {
        if (id !== undefined && id !== tabId) return;
        (async () => { if (reason === 'packages') await loadPackages(selected?.id); await refresh(); })().catch(error => message(error.message, true));
    }, text => message(text, true));
    addEventListener('pagehide', unsubscribe, {once: true});
}
