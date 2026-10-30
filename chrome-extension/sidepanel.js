import {getReview, putReview, listReviews} from './db.js';
import {validateReview, pageURL, samePage, MAX_IMAGE_BYTES} from './core.mjs';

const $ = id => document.getElementById(id);
let windowId, tabId, bound, selected, tools, toolKey, managing = false, refreshSequence = 0;
const reviews = new Map();
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function request(type, payload = {}, target = tabId) {
    const result = await chrome.runtime.sendMessage({type, tabId: target, ...payload});
    if (!result?.ok || result.value?.error) throw new Error(result?.error || result?.value?.error || '확장 도구 연결을 확인하세요.');
    return result.value;
}
function action(operation) {
    return async event => {
        const button = event.currentTarget;
        if (button.tagName === 'BUTTON') button.disabled = true;
        try { await operation(event); } catch (error) { message(error.message, true); }
        finally { if (button.tagName === 'BUTTON') button.disabled = false; }
    };
}
async function loadReviews(preferred) {
    const saved = await listReviews();
    $('reviews').replaceChildren();
    for (const review of saved) {
        reviews.set(review.id, {...reviews.get(review.id), ...review});
        const option = document.createElement('option'); option.value = review.id;
        option.textContent = `${review.version === 2 ? '시안 원본' : '이전 파일 · 다시 저장 필요'} · ${review.name}`;
        $('reviews').append(option);
    }
    if (!saved.length) {
        const option = document.createElement('option'); option.value = ''; option.textContent = '파일을 불러오세요'; $('reviews').append(option);
    }
    if (preferred && saved.some(review => review.id === preferred)) $('reviews').value = preferred;
    selectReview();
}
function selectReview() {
    selected = reviews.get($('reviews').value);
    $('review-info').textContent = selected ? `${selected.url}\n차이 ${selected.findings.length}개 · 검수 폭 ${selected.viewportWidth}px` : '';
    $('connect').disabled = $('open-page').disabled = !selected;
}
function showTools(connected) {
    $('tools').hidden = !connected || managing;
    $('connection').hidden = connected && !managing;
    $('back').hidden = !connected;
}
async function refresh() {
    const sequence = ++refreshSequence;
    const [tab] = await chrome.tabs.query({active: true, windowId});
    if (sequence !== refreshSequence) return;
    tabId = tab?.id;
    if (!Number.isInteger(tabId)) { showTools(false); return; }
    const result = await request('status', {}, tabId);
    const reviewId = result.binding?.activeReviewId || result.binding?.reviewId;
    let review = reviews.get(reviewId);
    if (!review?.image && reviewId) { review = await getReview(reviewId); if (review) reviews.set(reviewId, review); }
    if (sequence !== refreshSequence) return;
    bound = result.binding;
    const connected = result.overlay?.connected && review?.version === 2;
    if (connected) {
        const nextKey = `${tabId}:${reviewId}:${bound.device}:${!!bound.activeReviewId}`;
        if (toolKey !== nextKey) {
            tools?.destroy(); tools = null; toolKey = null;
            const target = tabId;
            const {image, ...details} = review;
            const meta = {...details, width: image.width, height: image.height, device: bound.device,
                findings: bound.activeReviewId ? details.findings : [],
                availableReviews: [...reviews.values()].filter(item => item.version === 2 && samePage(item.url, review.url)).map(item => ({id: item.id, name: item.name, viewportWidth: item.viewportWidth}))};
            tools = VisualQAToolbar.create(meta, bound.settings, async (type, payload = {}) => {
                if (type === 'manage') { managing = true; await loadReviews(review.id); showTools(true); return {managed: true}; }
                const [active] = await chrome.tabs.query({active: true, windowId});
                if (active?.id !== target || tabId !== target || (bound?.activeReviewId || bound?.reviewId) !== review.id) throw new Error('검수 탭이 바뀌었습니다. 현재 탭의 도구를 다시 선택하세요.');
                const value = await request(type, {...payload, reviewId: bound.activeReviewId}, target);
                if (type === 'remove') { managing = false; await refresh(); }
                return value;
            });
            toolKey = nextKey;
        }
        tools.update(bound.settings, {...result.overlay, binding: bound, devtoolsReady: result.devtoolsReady});
    } else {
        tools?.destroy(); tools = null; toolKey = null;
    }
    showTools(connected);
}
function permission(review) {
    const url = pageURL(review.url);
    return chrome.permissions.request({origins: [`${url.protocol}//${url.hostname}/*`]});
}
$('import').addEventListener('change', action(async event => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > MAX_IMAGE_BYTES * 1.4 + 8 * 1024 * 1024) throw new Error('검수 파일이 너무 큽니다.');
    message('검수 파일과 시안 원본을 확인하고 있습니다.');
    const review = await validateReview(JSON.parse(await file.text()));
    await putReview(review); await loadReviews(review.id); event.target.value = '';
    message('파일을 불러왔습니다. 현재 페이지에 연결하거나 실제 페이지를 여세요.');
}));
$('reviews').addEventListener('change', selectReview);
$('connect').addEventListener('click', action(async () => {
    const review = selected;
    if (!review) throw new Error('검수 파일을 먼저 불러오세요.');
    if (!await permission(review)) throw new Error('이 페이지 접근을 허용하세요.');
    await request('connect', {reviewId: review.id});
    managing = false; await refresh();
}));
$('open-page').addEventListener('click', action(async () => {
    const review = selected;
    if (!review) throw new Error('검수 파일을 먼저 불러오세요.');
    if (!await permission(review)) throw new Error('이 페이지 접근을 허용하세요.');
    await request('open', {reviewId: review.id});
    managing = false; await refresh();
}));
$('back').addEventListener('click', () => { managing = false; refresh().catch(error => message(error.message, true)); });
chrome.tabs.onActivated.addListener(info => {
    if (info.windowId !== windowId) return;
    managing = false; refresh().catch(() => {});
});
chrome.tabs.onUpdated.addListener(id => { if (id === tabId) refresh().catch(() => {}); });
async function startup() {
    windowId = (await chrome.windows.getCurrent()).id;
    await loadReviews(); await refresh();
    setInterval(() => { if (document.visibilityState === 'visible') refresh().catch(() => {}); }, 800);
}
startup().catch(error => message(error.message, true));
