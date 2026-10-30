import {getReview, putReview, listReviews, deleteReview} from './db.js';
import {validateReview, pageURL, overlaySettings, MAX_IMAGE_BYTES} from './core.mjs';
import {collectExport, buildExport, evaluate} from './export.mjs';
import {inspectSelector} from './snapshot.mjs';
import {sidePanelRegistered, RELOAD_GUIDANCE} from './extension-state.mjs';

const $ = id => document.getElementById(id);
const devtools = Number.isInteger(chrome.devtools?.inspectedWindow?.tabId);
let tabId = devtools ? chrome.devtools.inspectedWindow.tabId : Number(new URL(location.href).searchParams.get('tab')) || null;
let selected, bound, downloadURL, timer, settingsDirty = false, settingsSequence = 0;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({type, tabId, ...payload});
    if (!result?.ok || result.value?.error) throw new Error(result?.error || result?.value?.error || '확장 도구 연결을 확인하세요.');
    return result.value;
}
function action(operation) {
    return async event => {
        const button = event?.currentTarget;
        if (button?.tagName === 'BUTTON') button.disabled = true;
        try { await operation(event); } catch (error) { message(error.message, true); }
        finally { if (button?.tagName === 'BUTTON') button.disabled = false; }
    };
}
async function loadReviews(preferred) {
    const reviews = await listReviews();
    $('reviews').replaceChildren();
    for (const review of reviews) {
        const option = document.createElement('option'); option.value = review.id;
        option.textContent = `${review.version === 2 ? '시안 원본' : '이전 파일 · 다시 저장 필요'} · ${review.name} · ${review.viewportWidth}px`; $('reviews').append(option);
    }
    if (!reviews.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '파일을 불러오세요'; $('reviews').append(option); }
    if (preferred && reviews.some(review => review.id === preferred)) $('reviews').value = preferred;
    await selectReview();
}
async function selectReview() {
    selected = $('reviews').value ? await getReview($('reviews').value) : null;
    $('review-info').textContent = selected ? `${selected.url}\n차이 ${selected.findings.length}개 · 검수 폭 ${selected.viewportWidth}px · 저장된 위치 X ${selected.placement.x}, Y ${selected.placement.y}` : '';
    $('open-page').disabled = $('connect').disabled = $('delete-review').disabled = !selected;
    renderFindings();
}
function renderFindings() {
    $('findings').replaceChildren();
    for (const finding of selected?.findings || []) {
        const item = document.createElement('div'); item.className = 'finding';
        const title = document.createElement('strong'); title.textContent = finding.title;
        const caption = document.createElement('p'); caption.className = 'muted'; caption.textContent = `Y ${finding.rect.y}px · ${finding.rect.width} × ${finding.rect.height}px`;
        const buttons = document.createElement('div'); buttons.className = 'row';
        const jump = document.createElement('button'); jump.textContent = '이 위치로 이동'; jump.type = 'button';
        jump.addEventListener('click', action(async () => {
            if (bound?.activeReviewId !== selected.id) throw new Error('선택한 검수 파일을 현재 탭에 먼저 겹치세요.');
            await request('jump', {findingId: finding.id}); message('실제 페이지의 차이 위치로 이동했습니다.');
        }));
        buttons.append(jump);
        for (const selector of finding.selectors) {
            const inspect = document.createElement('button'); inspect.type = 'button'; inspect.textContent = selector;
            inspect.title = 'Elements에서 이 요소 선택'; inspect.disabled = !devtools;
            inspect.addEventListener('click', action(async () => {
                if (bound?.activeReviewId !== selected.id) throw new Error('선택한 검수 파일을 현재 탭에 먼저 겹치세요.');
                if (!await evaluate(inspectSelector(selector))) throw new Error('현재 페이지에 해당 요소가 없습니다. Elements에서 직접 선택하세요.');
                message('Elements에서 요소를 선택했습니다.');
            }));
            buttons.append(inspect);
        }
        item.append(title, caption, buttons); $('findings').append(item);
    }
    if (!selected?.findings.length) { const paragraph = document.createElement('p'); paragraph.className = 'muted'; paragraph.textContent = selected ? '검출된 차이 항목이 없습니다.' : '검수 파일을 불러오세요.'; $('findings').append(paragraph); }
}
function readSettings() {
    return overlaySettings({...bound?.settings, opacity: Number($('opacity').value) / 100, dx: Number($('dx').value), dy: Number($('dy').value),
        scale: Number($('scale').value) / 100, visible: $('visible').checked});
}
function setSettings(settings) {
    $('opacity').value = settings.opacity * 100; $('opacity-value').textContent = `${Math.round(settings.opacity * 100)}%`;
    $('dx').value = settings.dx; $('dy').value = settings.dy; $('scale').value = settings.scale * 100; $('visible').checked = settings.visible;
}
async function refreshStatus(restoreControls = false) {
    if (!tabId) return;
    const sequence = settingsSequence;
    const result = await request('status'); bound = result.binding;
    const overlay = result.overlay;
    if (bound && !settingsDirty && sequence === settingsSequence && (restoreControls || !['opacity', 'dx', 'dy', 'scale', 'visible'].includes(document.activeElement?.id))) setSettings(bound.settings);
    if (overlay?.connected) {
        $('viewport').textContent = `연결됨 · 현재 화면 ${overlay.viewportWidth} × ${overlay.viewportHeight}px · 페이지 스크롤 Y ${Math.round(overlay.scrollY)}px`;
        $('mismatch').hidden = !overlay.widthMismatch;
        if (overlay.widthMismatch) {
            const review = await getReview(bound.activeReviewId || bound.reviewId);
            $('mismatch').textContent = `검수 폭 ${review.viewportWidth}px와 현재 화면 폭 ${overlay.viewportWidth}px가 다릅니다. 개발자도구의 기기 도구 모음(⌘⇧M)에서 검수 폭을 맞추세요. 이미지 배율 변경은 페이지의 반응형 배치를 바꾸지 않습니다.`;
        }
    } else { $('viewport').textContent = '오버레이가 연결되지 않았습니다. 현재 검수 탭에 겹치기를 누르세요.'; $('mismatch').hidden = true; }
}
function permission(review) {
    // Call directly inside the click handler, before awaiting other work.
    const url = pageURL(review.url);
    return chrome.permissions.request({origins: [`${url.protocol}//${url.hostname}/*`]});
}
$('import').addEventListener('change', action(async event => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > MAX_IMAGE_BYTES * 1.4 + 8 * 1024 * 1024) throw new Error('검수 파일이 너무 큽니다.');
    message('검수 파일과 시안 원본을 확인하고 있습니다.');
    const review = await validateReview(JSON.parse(await file.text()));
    await putReview(review); await loadReviews(review.id); event.target.value = '';
    message('검수 파일을 불러왔습니다. 실제 페이지를 열거나 현재 검수 탭에 겹치세요.');
}));
$('reviews').addEventListener('change', action(selectReview));
$('open-page').addEventListener('click', action(async () => {
    if (!selected) throw new Error('검수 파일을 먼저 불러오세요.');
    if (!await permission(selected)) throw new Error('이 페이지 접근을 허용해야 오버레이를 표시할 수 있습니다.');
    const result = await request('open', {reviewId: selected.id});
    if (!devtools) tabId = result.tabId;
    message('Chrome에서 실제 페이지를 열었습니다. 확장 도구 아이콘을 누르면 사이드패널이 열립니다.');
}));
$('open-sidepanel').addEventListener('click', action(async () => {
    if (!Number.isInteger(tabId)) throw new Error('검수할 실제 페이지를 먼저 여세요.');
    if (!sidePanelRegistered(chrome.runtime.getManifest())) {
        $('reload-extension').hidden = false;
        throw new Error(RELOAD_GUIDANCE);
    }
    await request('open-sidepanel');
}));
$('reload-extension').addEventListener('click', action(async () => {
    if (typeof chrome.tabs?.create !== 'function') throw new Error('Chrome 주소창에 chrome://extensions를 입력하고 시안 검수의 새로고침 버튼을 누르세요.');
    await chrome.tabs.create({url: `chrome://extensions/?id=${chrome.runtime.id}`});
}));
$('connect').addEventListener('click', action(async () => {
    if (!selected) throw new Error('검수 파일을 먼저 불러오세요.');
    if (!await permission(selected)) throw new Error('이 페이지 접근을 허용해야 오버레이를 표시할 수 있습니다.');
    message('시안 원본을 실제 페이지에 겹치고 있습니다.');
    await request('connect', {reviewId: selected.id, settings: readSettings()});
    await refreshStatus(); message('오버레이가 연결되었습니다. Elements에서 실제 HTML·CSS를 수정하세요.');
}));
$('delete-review').addEventListener('click', action(async () => {
    if (!selected) return;
    if (bound?.reviewId === selected.id) { await request('remove'); bound = null; }
    await deleteReview(selected.id); await loadReviews(); message('확장 도구에 불러온 파일을 제거했습니다. 앱의 검수 이력은 보존됩니다.');
}));
async function updateSettings() {
    const sequence = settingsSequence;
    settingsDirty = true;
    $('opacity-value').textContent = `${$('opacity').value}%`;
    try { if (bound) await request('settings', {settings: readSettings()}); }
    catch (error) { message(error.message, true); }
    finally { if (sequence === settingsSequence) settingsDirty = false; }
}
for (const id of ['opacity', 'dx', 'dy', 'scale', 'visible']) $(id).addEventListener('input', () => {
    $('opacity-value').textContent = `${$('opacity').value}%`;
    settingsDirty = true; settingsSequence++;
    clearTimeout(timer); timer = setTimeout(updateSettings, 80);
});
$('reset').addEventListener('click', action(async () => { settingsSequence++; setSettings({...readSettings(), dx: 0, dy: 0, scale: 1}); await updateSettings(); }));
$('remove').addEventListener('click', action(async () => { await request('remove'); bound = null; await refreshStatus(); message('이 탭의 오버레이 연결을 해제했습니다.'); }));
$('export').disabled = !devtools;
$('export').addEventListener('click', action(async () => {
    message('현재 페이지의 HTML과 CSS를 읽고 있습니다.');
    const {snapshot, contents} = await collectExport();
    const review = bound ? await getReview(bound.activeReviewId || bound.reviewId) : null;
    const result = buildExport(snapshot, contents, review, bound?.settings);
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = URL.createObjectURL(result.blob);
    const link = document.createElement('a'); link.href = downloadURL; link.download = result.filename;
    link.className = 'download'; link.textContent = `수정본 ZIP 저장 · HTML 1개 / CSS ${result.manifest.stylesheets.length}개`;
    const text = document.createElement('p'); text.className = 'muted'; text.textContent = result.manifest.warnings.join('\n');
    $('export-result').replaceChildren(link, text); link.click();
    message('수정본을 만들었습니다. ZIP 안의 manifest.json에서 원래 CSS 주소와 저장 파일을 확인하세요.');
}));
async function startup() {
    const manifest = chrome.runtime.getManifest();
    const ready = sidePanelRegistered(manifest);
    $('extension-info').textContent = `Chrome에 적용된 확장 v${manifest.version}${ready ? '' : ' · 사이드패널 업데이트 미적용'}`;
    $('reload-extension').hidden = ready;
    if (!ready) message(RELOAD_GUIDANCE, true);
    if (devtools) {
        $('export-help').textContent = 'Elements에서 수정한 뒤 이 탭으로 돌아와 내보내세요. 원본 파일은 자동으로 변경하지 않습니다.';
        chrome.devtools.network.onNavigated.addListener(() => { bound = null; $('export-result').replaceChildren(); refreshStatus(true).catch(() => {}); });
    }
    const status = tabId ? await request('status') : {};
    await loadReviews(status.binding?.reviewId);
    await refreshStatus(true);
    setInterval(() => { if (document.visibilityState === 'visible') refreshStatus().catch(() => {}); }, 2000);
}
startup().catch(error => message(error.message, true));
