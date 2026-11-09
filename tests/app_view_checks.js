// Runs against the actual app in both Chrome and macOS WebKit, using fixture data.
const check = (value, message) => { if (!value) throw new Error(message); };
const wait = async operation => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        if (await operation()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('App view did not reach the expected state');
};
await wait(() => !!state.result && !document.querySelector('#result').hidden);
const types = ['reference', 'actual', 'diff'];
await wait(() => types.every(type => document.getElementById(type+'-image').complete && document.getElementById(type+'-image').naturalWidth));
const panel = type => document.getElementById(type+'-panel');
const tab = type => document.getElementById(type+'-tab');
const scroll = type => document.getElementById(type+'-scroll');
function only(type) {
    check(types.filter(name => panel(name).getClientRects().length).join() === type, 'Only the selected image must be visible');
    check(types.filter(name => tab(name).getAttribute('aria-selected') === 'true').join() === type, 'Tab selection must match its image');
    check(tab(type).getAttribute('aria-controls') === panel(type).id, 'Tabs must identify their panel');
}
only('reference');
for (const type of types) {
    tab(type).click(); only(type);
    const image = document.getElementById(type+'-image');
    check(Math.abs(image.getBoundingClientRect().width-scroll(type).clientWidth) < 2, 'Fit must use the full visible panel width');
}
tab('reference').click(); tab('reference').focus();
tab('reference').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true})); only('actual');
check(document.activeElement === tab('actual'), 'Arrow keys must move focus');
tab('actual').dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true})); only('diff');
tab('diff').dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true})); only('reference');
tab('reference').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true})); only('diff');
const zoom = document.getElementById('zoom');
zoom.value = '2'; zoom.dispatchEvent(new Event('change'));
tab('reference').click(); scroll('reference').scrollLeft = 110;
tab('actual').click(); check(scroll('actual').scrollLeft === 110, 'Linked tabs must retain the same location');
scroll('actual').scrollLeft = 220; tab('diff').click(); check(scroll('diff').scrollLeft === 220, 'Linked location must follow scrolling');
const linked = document.getElementById('sync-scroll'); linked.checked = false;
tab('reference').click(); check(scroll('reference').scrollLeft === 110, 'Unlinked tabs must restore their own location');
tab('actual').click(); scroll('actual').scrollLeft = 330;
tab('reference').click(); tab('actual').click(); check(scroll('actual').scrollLeft === 330, 'Independent locations must survive repeated switching');
linked.checked = true; zoom.value = 'fit'; zoom.dispatchEvent(new Event('change'));
tab('diff').click(); only('diff');
for (const id of ['alignment-section','capture-details']) {
    check(!document.getElementById(id).getClientRects().length, 'Lower details must not be visible');
}
check(document.querySelector('#alignment-form') && document.querySelector('#strip-table table'), 'Hidden calculation tools must remain available in code');
check(document.querySelector('#capture-info').textContent.includes('비교엔진'), 'Capture information must still be generated');
check(!window.SourceEditor, 'Source editing must not initialize while parked');
for (const id of ['open-html-source','edit-finding-source','source-connection']) {
    check(!document.getElementById(id).getClientRects().length, 'Source-editing entries must be hidden');
}
const finding = state.result.findings[0]; check(!!finding, 'Fixture must contain a finding');
const image = document.getElementById('diff-image'), box = image.getBoundingClientRect(), scale = box.width/state.result.metrics.width;
image.dispatchEvent(new MouseEvent('click', {bubbles:true,clientX:box.left+(finding.rect.x+1)*scale,clientY:box.top+(finding.rect.y+1)*scale}));
check(state.finding === finding.id && !document.getElementById('finding-detail').hidden, 'Image selection must still open finding details');
check(document.getElementById('source-workbench').hidden && !document.querySelector('#related-elements button'), 'Finding selection must not open source editing');
document.querySelector('#findings button').click();
check(!document.getElementById('review-form').closest('section').hidden, 'Judgment controls must remain visible');
document.getElementById('review-status').value = 'intentional';
document.getElementById('review-severity').value = 'medium';
document.getElementById('review-note').value = '탭 화면 판단 저장 검증';
document.getElementById('review-form').requestSubmit();
await wait(() => state.result.reviews[finding.id]?.note === '탭 화면 판단 저장 검증');
const saved = await api(`/api/result?run=${state.result.run_id}&target=${state.result.target_id}&revision=${state.result.id}`);
check(saved.reviews[finding.id].status === 'intentional' && saved.reviews[finding.id].note === '탭 화면 판단 저장 검증', 'Judgments must persist on the server');
check(document.getElementById('source-workbench').hidden, 'Saving a judgment must not open the editor');
const complete = state.run.id;
const partial = state.runs.find(run => run.project_id === state.project && run.targets.pc && !run.targets.mo);
check(!!partial, 'Fixture must contain a PC-only history');
const history = document.getElementById('run-select');
history.value = partial.id; history.dispatchEvent(new Event('change'));
await wait(() => state.result?.run_id === partial.id);
const exportButton = document.getElementById('chrome-review');
const incomplete = document.getElementById('chrome-review-incomplete');
exportButton.click();
await wait(() => incomplete.open);
check(document.getElementById('chrome-review-incomplete-message').textContent.includes('MO'), 'Missing MO must be named before download');
const move = document.getElementById('chrome-review-latest');
check(!move.hidden, 'Latest paired history must be offered');
incomplete.querySelector('button[type="submit"]').click();
check(!incomplete.open && state.run.id === partial.id, 'Closing the warning must keep the current history');
exportButton.click();
await wait(() => incomplete.open);
move.click();
await wait(() => state.result?.run_id === complete);
check(history.value === complete && !incomplete.open, 'Move must select the latest paired history without downloading');
return {status:'PASS', checks:['exclusive image tabs','full-width image fit','keyboard navigation','linked and independent positions','hidden lower details retain data','source editing parked','image and list finding navigation','judgment persistence','missing MO warning and navigation to latest paired history']};
