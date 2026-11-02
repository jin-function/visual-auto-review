'use strict';
// Preserve the app editor for later reuse; live source edits currently use Chrome.
window.VisualQAFeatures = Object.freeze({sourceEditing: false});
const $ = id => document.getElementById(id);
for (const entry of document.querySelectorAll('[data-app-feature]')) entry.hidden = !VisualQAFeatures[entry.dataset.appFeature];
const token = new URL(location.href).searchParams.get('token') || sessionStorage.getItem('visualqa-session');
if (token) sessionStorage.setItem('visualqa-session', token);
history.replaceState(null, '', '/');
const state = { projects: [], runs: [], profile: null, project: null, run: null, target: null, result: null, finding: null, edit: null, uploading: 0 };
const labels = { queued:'대기', running:'진행 중', capturing:'캡처 중', comparing:'비교 중', complete:'완료', partial:'일부 완료', failed:'실패', interrupted:'중단', pending:'확인 필요', fix:'수정 필요', intentional:'의도된 차이', resolved:'해결' };
let toastTimer, pollBusy = false;
const imageViews = ['reference', 'actual', 'diff'];
let activeImageView = 'reference';
const imagePositions = new Map();

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function toast(message) {
    $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function action(fn) { return async event => { try { await fn(event); } catch (error) { toast(error.message); } }; }
async function api(path, body) {
    const response = await fetch(path, { headers: { 'X-VisualQA': token, ...(body ? {'Content-Type':'application/json'} : {}) },
        method:body ? 'POST':'GET', body:body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '처리하지 못했습니다.');
    return value;
}
function date(value) { return new Date(value).toLocaleString('ko-KR', {hour12:false}); }
function percent(value) { return `${(value * 100).toFixed(2)}%`; }
function badge(text, key) { return element('span', text, `badge ${key || ''}`); }
function currentProject() { return state.projects.find(p => p.id === state.project); }
function currentTarget() { return state.run?.targets[state.target]; }
function currentFinding() { return state.result?.findings.find(f => f.id === state.finding); }

async function refresh(initial = false) {
    const value = await api('/api/state');
    Object.assign(state, {projects:value.projects, runs:value.runs, profile:value.profile});
    $('storage-label').textContent = `저장 위치: ${value.data_root}`;
    $('app-version').textContent = `로컬 저장 · v${value.version}`;
    renderProjects();
    if (initial && state.projects.length) await selectProject(state.projects[0].id);
}
function renderProjects() {
    $('project-list').replaceChildren(...state.projects.map(project => {
        const button = element('button', project.name, `project-button${state.project === project.id ? ' active' : ''}`);
        button.type = 'button'; button.addEventListener('click', action(() => selectProject(project.id))); return button;
    }));
}
async function selectProject(projectId) {
    if (window.SourceEditor && !SourceEditor.canLeave()) return;
    window.SourceEditor?.reset();
    VisualQARequests.begin('run', 'result');
    state.project = projectId; state.run = null; state.result = null; state.target = null; state.finding = null;
    renderProjects();
    const project = currentProject();
    $('project-title').textContent = project.name; $('project-url').textContent = project.url;
    $('edit-project').hidden = false; $('start-run').hidden = false;
    const runs = state.runs.filter(r => r.project_id === projectId);
    $('welcome').hidden = !!runs.length; $('workspace').hidden = !runs.length;
    if (!runs.length) {
        $('welcome').querySelector('h2').textContent = '등록한 조건으로 검수를 시작하세요.';
        $('welcome').querySelector('p').textContent = '새 검수 시작을 누르면 시안을 캡처와 비교합니다. 기존 결과는 실행별로 보존됩니다.';
        $('welcome-new').textContent = '새 검수 시작';
    }
    if (runs.length) await selectRun(runs[0].id);
}
async function selectRun(runId, targetId, revisionId) {
    if (window.SourceEditor && !SourceEditor.canLeave()) return;
    window.SourceEditor?.reset();
    const current = VisualQARequests.begin('run', 'result'), projectId = state.project;
    const run = await api(`/api/run?id=${encodeURIComponent(runId)}`);
    if (!current() || state.project !== projectId) return;
    state.run = run;
    state.target = targetId && state.run.targets[targetId] ? targetId : Object.keys(state.run.targets)[0];
    state.result = null; state.finding = null;
    $('welcome').hidden = true; $('workspace').hidden = false;
    renderRun(); await loadResult(revisionId);
}
function renderRun() {
    const run = state.run;
    const runs = state.runs.filter(r => r.project_id === state.project);
    $('run-select').replaceChildren(...runs.map(r => { const option=element('option', `${date(r.created_at)} · ${labels[r.status]}`); option.value=r.id; return option; }));
    $('run-select').value = run.id;
    $('run-status').textContent = labels[run.status]; $('run-status').className = `badge ${run.status}`;
    $('retry-run').hidden = !Object.values(run.targets).some(t => ['failed','interrupted'].includes(t.status));
    $('retry-run').disabled = ['queued','running'].includes(run.status);
    $('start-run').disabled = state.runs.some(r => r.project_id === state.project && ['queued','running'].includes(r.status)) || Object.values(run.targets).some(t => ['capturing','comparing'].includes(t.status));
    $('export-run').disabled = !Object.values(run.targets).some(t => t.current_revision);
    $('target-tabs').replaceChildren(...Object.entries(run.targets).map(([id,target]) => {
        const button=element('button', `${target.name} · ${labels[target.status]}`, state.target === id ? 'active' : '');
        button.type='button'; button.setAttribute('role','tab'); button.setAttribute('aria-selected',String(state.target===id));
        button.addEventListener('click',action(async()=>{if(window.SourceEditor&&!SourceEditor.canLeave())return;VisualQARequests.begin('result');state.target=id;state.result=null;state.finding=null;renderRun();await loadResult();})); return button;
    }));
    const target = currentTarget();
    $('processing').hidden = target.status === 'complete' && !target.error;
    $('processing').textContent = target.error || ({queued:'캡처를 기다리고 있습니다.',capturing:'페이지와 지연 로딩 이미지를 준비한 뒤 캡처하고 있습니다.',comparing:'비교 결과와 모든 관련 데이터를 생성하고 있습니다.'}[target.status] || labels[target.status]);
    const revisions = target.revisions || [];
    $('revision-select').replaceChildren(...revisions.map((revision,index) => {
        const option=element('option', `${index+1}. Y ${revision.y_offset}px · ${revision.reason}`); option.value=revision.id; return option;
    }));
    $('alignment-form').querySelector('button').disabled = target.status !== 'complete';
    $('review-form').querySelector('button').disabled = target.status !== 'complete';
}
async function loadResult(revisionId) {
    if (window.SourceEditor && !SourceEditor.canLeave()) return;
    window.SourceEditor?.reset();
    const target = currentTarget();
    if (!target?.current_revision) { $('result').hidden=true; return; }
    const id = revisionId || target.current_revision;
    const current = VisualQARequests.begin('result');
    const requestedRun = state.run.id, requestedTarget = state.target;
    const result = await api(`/api/result?run=${requestedRun}&target=${requestedTarget}&revision=${id}`);
    if (!current() || state.run?.id !== requestedRun || state.target !== requestedTarget) return;
    state.result=result; state.finding=null; $('result').hidden=false; $('revision-select').value=id;
    renderResult();
}
function renderResult() {
    const result=state.result, m=result.metrics;
    const reviews=Object.values(result.reviews), done=reviews.filter(r=>r.status!=='pending').length;
    const metrics=[['자동 판정',m.verdict,'항목별 판단을 함께 확인하세요.'],['전체 차이율',percent(m.changed_ratio),'픽셀 비율은 참고 지표입니다.'],['높이 차이',`${m.height_delta > 0 ? '+' : ''}${m.height_delta}px`,`시안 ${m.reference_height}px / 캡처 ${m.actual_height}px`],['판단 기록',`${done} / ${result.findings.length}`,'확인·수정·의도된 차이·해결']];
    $('metrics').replaceChildren(...metrics.map(([title,value,caption])=>{const card=element('div',undefined,'metric');card.append(element('p',title),element('strong',value),element('small',caption));return card;}));
    const capture=result.capture;
    const warnings=[];
    if(capture.brokenImages?.length)warnings.push(`불러오지 못한 이미지 ${capture.brokenImages.length}개가 있습니다.`);
    if(capture.httpErrors?.length)warnings.push(`리소스 응답 오류 ${capture.httpErrors.length}개가 있습니다.`);
    if(capture.resourceFailures?.length)warnings.push(`리소스 로딩 실패 ${capture.resourceFailures.length}개가 있습니다.`);
    if(capture.consoleErrors?.length)warnings.push(`페이지 실행 오류 ${capture.consoleErrors.length}개가 있습니다.`);
    if(capture.scrollWidth>capture.innerWidth)warnings.push(`가로 넘침 ${capture.scrollWidth-capture.innerWidth}px가 있습니다.`);
    if(capture.diagnosticsTruncated)warnings.push('진단 요소가 많아 처음 3000개만 수집했습니다. 캡처 범위를 나누면 더 정확히 연결할 수 있습니다.');
    $('capture-warnings').hidden=!warnings.length;$('capture-warnings').textContent=warnings.join('\n');
    const h=result.history;
    if(h.moved_candidates?.length)warnings.push(`위치가 바뀐 이전 차이 후보 ${h.moved_candidates.length}개가 있습니다. 이전 판단은 자동 적용하지 않았습니다.`);
    $('capture-warnings').hidden=!warnings.length;$('capture-warnings').textContent=warnings.join('\n');
    $('history-summary').replaceChildren();
    if(h.previous_run){
        $('history-summary').append(element('span',h.compatible?`이전 비교 대비 신규 ${h.new.length}개 · 같은 위치 ${h.persisting.length}개 · 이번에 검출되지 않음 ${h.not_detected.length}개. `:'시안 또는 비교 조건이 변경되어 이전 판단을 자동으로 이어받지 않았습니다. '));
        const link=element('a','이전 결과 보기');link.href='#';link.addEventListener('click',action(async e=>{e.preventDefault();await selectRun(h.previous_run,state.target,h.previous_revision);}));$('history-summary').append(link);
    }else $('history-summary').textContent='이 프로젝트의 첫 비교입니다. 판단을 기록하면 다음 검수에서 확인할 수 있습니다.';
    const base=`/files/${result.run_id}/${result.target_id}/${result.id}`;
    for(const type of ['reference','actual','diff'])$(type+'-image').src=`${base}/${type}.png`;
    $('alignment-y').value=result.y_offset;$('alignment-reason').value='';
    $('finding-detail').hidden=true;
    renderFindings();
    imagePositions.clear();
    selectImageView(activeImageView, false, true);
    const table=element('table');const head=element('thead'),row=element('tr');
    for(const title of ['범위','차이 픽셀','차이율','평균 색상 차이'])row.append(element('th',title));head.append(row);table.append(head);
    const body=element('tbody');for(const s of result.strips){const r=element('tr');for(const v of [`${s.top}~${s.bottom}px`,s.changed_pixels.toLocaleString(),percent(s.changed_ratio),s.mean_delta.toFixed(2)])r.append(element('td',v));body.append(r);}table.append(body);$('strip-table').replaceChildren(table);
    $('capture-info').textContent=JSON.stringify({캡처일시:capture.capturedAt,브라우저:capture.browser,시안:result.asset,시안배율:result.reference_scale,비교엔진:m.engine_version,뷰포트:{폭:capture.innerWidth,스크롤폭:capture.scrollWidth},비교범위:capture.clip,보정값:result.y_offset,보정이유:result.reason,아코디언:{전체:capture.toggleCount,열림:capture.openedToggleCount},폰트:capture.fonts,리소스오류:capture.httpErrors,실행오류:capture.consoleErrors},null,2);
    $('previous-items').hidden=!h.not_detected.length;
    $('previous-item-list').replaceChildren(...h.not_detected.map(item=>{const p=element('p',`${item.title} · Y ${item.rect.y}px · 이전 상태 ${labels[item.previous_review?.status||'pending']}`);return p;}));
}
function renderFindings(){
    const result=state.result, filter=$('finding-filter').value;
    const findings=result.findings.filter(f=>filter==='all'||(result.reviews[f.id]?.status||'pending')===filter);
    $('finding-count').textContent=`차이 항목 ${result.findings.length}개`;
    $('findings').replaceChildren(...findings.map((finding,index)=>{
        const review=result.reviews[finding.id];const button=element('button',undefined,`finding${state.finding===finding.id?' active':''}`);button.type='button';button.dataset.id=finding.id;
        button.append(badge(labels[review?.status||'pending'],review?.status),element('strong',`${index+1}. ${finding.title}`),element('small',`Y ${finding.rect.y}px · ${finding.changed_pixels.toLocaleString()} 픽셀`));
        button.addEventListener('click',()=>selectFinding(finding.id));return button;
    }));
    if(!findings.length)$('findings').append(element('p',result.findings.length?'이 상태의 항목이 없습니다.':'검출된 차이가 없습니다. 캡처 조건과 콘텐츠도 확인하세요.','empty'));
}
function selectFinding(findingId, openSource=true){
    const changed = state.finding !== findingId;
    if (changed && window.SourceEditor && !SourceEditor.canLeave()) return;
    state.finding=findingId;renderFindings();const finding=currentFinding(),review=state.result.reviews[findingId]||{};
    $('finding-detail').hidden=false;$('finding-title').textContent=finding.title;
    const r=finding.rect;$('finding-location').textContent=`X ${r.x} · Y ${r.y} · ${r.width} × ${r.height}px`;
    $('review-status').value=review.status||'pending';$('review-severity').value=review.severity||finding.suggested_severity;$('review-note').value=review.note||'';
    $('previous-review').textContent=finding.previous_review&&!review.updated_at?`이전 메모: ${finding.previous_review.note||'(메모 없음)'} · 증거가 변경되어 다시 확인해야 합니다.`:review.updated_at?`마지막 저장 ${date(review.updated_at)}`:'';
    $('related-elements').replaceChildren(...finding.elements.map(item=>{const box=element('div',undefined,'element');box.append(element('code',item.selector),element('p',item.text||'(텍스트 없음)'),element('p',Object.entries(item.styles).map(([k,v])=>`${k}: ${v}`).join(' · ')));if(VisualQAFeatures.sourceEditing){const edit=element('button','이 요소 수정');edit.type='button';edit.addEventListener('click',()=>window.SourceEditor?.select([item]));box.append(edit);}return box;}));
    if(!finding.elements.length)$('related-elements').append(element('p','연결된 요소가 없습니다. 누락·추가 영역 또는 수집 범위 밖의 차이일 수 있습니다.','muted'));
    markRegion(true);
    if(changed&&openSource)window.SourceEditor?.select(finding.elements);
}
function applyZoom(){
    if(!state.result)return;
    const width=state.result.metrics.width;
    const choice=$('zoom').value;
    const fitWidth = Math.max(1, $(activeImageView+'-scroll').clientWidth);
    for(const scroll of document.querySelectorAll('.image-scroll')){
        const image=scroll.querySelector('img'),stage=scroll.querySelector('.image-stage');
        const display=choice==='fit'?fitWidth:width*Number(choice);
        image.style.width=`${display}px`;stage.style.width=`${display}px`;
    }
    markRegion(false);
}
function markRegion(scrollToRegion){
    const finding=currentFinding();
    for(const scroll of document.querySelectorAll('.image-scroll')){
        const marker=scroll.querySelector('.region-marker');marker.hidden=!finding;if(!finding)continue;
        if(scroll.closest('[role="tabpanel"]').hidden)continue;
        const scale=scroll.querySelector('img').getBoundingClientRect().width/state.result.metrics.width;
        const r=finding.rect;Object.assign(marker.style,{left:`${r.x*scale}px`,top:`${r.y*scale}px`,width:`${Math.max(3,r.width*scale)}px`,height:`${Math.max(3,r.height*scale)}px`});
        if(scrollToRegion){scroll.scrollTop=Math.max(0,r.y*scale-60);scroll.scrollLeft=Math.max(0,r.x*scale-20);}
    }
}
function selectImageView(type, focus = false, reset = false) {
    if (!imageViews.includes(type)) return;
    const previous = $(activeImageView+'-scroll');
    const position = {top:previous.scrollTop, left:previous.scrollLeft};
    if (!reset) imagePositions.set(activeImageView, position);
    activeImageView = type;
    for (const view of imageViews) {
        const selected = view === type, tab = $(view+'-tab');
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        $(view+'-panel').hidden = !selected;
    }
    applyZoom();
    const next = $(type+'-scroll');
    const target = reset ? {top:0,left:0} : $('sync-scroll').checked ? position : imagePositions.get(type) || {top:0,left:0};
    next.scrollTop = target.top; next.scrollLeft = target.left;
    if (focus) $(type+'-tab').focus();
}
for (const type of imageViews) {
    $(type+'-tab').addEventListener('click', () => selectImageView(type));
    $(type+'-scroll').addEventListener('scroll', () => {
        if (type === activeImageView) imagePositions.set(type, {top:$(type+'-scroll').scrollTop,left:$(type+'-scroll').scrollLeft});
    });
    if (!VisualQAFeatures.sourceEditing) $(type+'-image').addEventListener('click', event => {
        if (!state.result) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (!box.width) return;
        const x = (event.clientX-box.left)*state.result.metrics.width/box.width;
        const y = (event.clientY-box.top)*state.result.metrics.width/box.width;
        const finding = state.result.findings.filter(f=>x>=f.rect.x&&x<f.rect.x+f.rect.width&&y>=f.rect.y&&y<f.rect.y+f.rect.height)
            .sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height)[0];
        if (finding) selectFinding(finding.id, false);
    });
}
$('image-tabs').addEventListener('keydown', event => {
    const tab = event.target.closest('[data-image-view]');
    if (!tab) return;
    const index = imageViews.indexOf(tab.dataset.imageView);
    const next = event.key === 'ArrowRight' ? (index+1)%imageViews.length : event.key === 'ArrowLeft' ? (index+imageViews.length-1)%imageViews.length : event.key === 'Home' ? 0 : event.key === 'End' ? imageViews.length-1 : null;
    if (next === null) return;
    event.preventDefault(); selectImageView(imageViews[next], true);
});

function editProject(project){
    if(window.SourceEditor&&!SourceEditor.canLeave())return;
    window.SourceEditor?.reset();
    state.edit=project?structuredClone(project):{name:'',url:'',targets:[{id:'mobile',name:'모바일',enabled:true,width:390,viewport_height:844,normalize:true},{id:'pc',name:'PC',enabled:false,width:1920,viewport_height:844,normalize:true}],settings:{pixel_threshold:24,font_tolerance:1,strip_height:600},profile:structuredClone(state.profile)};
    $('dialog-title').textContent=project?'프로젝트 설정':'새 프로젝트';$('project-name-input').value=state.edit.name;$('project-url-input').value=state.edit.url;
    $('threshold-input').value=state.edit.settings.pixel_threshold;$('tolerance-input').value=state.edit.settings.font_tolerance;$('strip-input').value=state.edit.settings.strip_height;$('profile-input').value=JSON.stringify(state.edit.profile,null,4);
    state.edit.responsive ||= {breakpoint:1024};
    $('breakpoint-input').value=state.edit.responsive.breakpoint;
    $('project-error').textContent='';renderTargetFields();$('project-dialog').showModal();
    $('source-root-input').value=state.edit.source?.root||'';
    $('source-html-input').value=state.edit.source?.html||'';
    $('source-prefix-input').value=state.edit.source?.url_prefix||'';
}
function renderTargetFields(){
    $('target-fields').replaceChildren(...state.edit.targets.map(target=>{
        const box=element('div',undefined,'target-field'),heading=element('div',undefined,'target-heading'),check=element('label');
        const enabled=element('input');enabled.type='checkbox';enabled.checked=target.enabled;enabled.setAttribute('aria-label',`${target.name} 검수 사용`);enabled.addEventListener('change',()=>{target.enabled=enabled.checked;renderResponsiveFields();});
        const name=element('input');name.type='text';name.value=target.name;name.maxLength=80;name.setAttribute('aria-label','검수 대상 이름');name.addEventListener('input',()=>{target.name=name.value;});check.append(enabled,name);heading.append(check);box.append(heading);
        target.device ||= /^(mobile|mo)$/.test(target.id)?'mo':/^(pc|desktop)$/.test(target.id)?'pc':target.width<1024?'mo':'pc';
        const deviceLabel=element('label','검수 대상 종류'),device=element('select');
        for(const [value,title] of [['pc','PC'],['mo','MO']]){const option=element('option',title);option.value=value;device.append(option);}
        device.value=target.device;device.addEventListener('change',()=>{target.device=device.value;renderResponsiveFields();});deviceLabel.append(device);box.append(deviceLabel);
        const file=element('input',undefined,'asset-file');file.type='file';file.accept='image/png,image/jpeg';file.setAttribute('aria-label',`${target.name} 시안 파일`);
        const info=element('p',target.asset_name?`${target.asset_name} · ${target.asset_width} × ${target.asset_height}px`:'JPG 또는 PNG 시안을 선택하세요.','asset-label');
        file.addEventListener('change',action(async()=>{
            if(!file.files[0])return;state.uploading++;$('save-project').disabled=true;info.textContent='시안을 저장하고 있습니다.';
            try{
                const selected=file.files[0];
                if(selected.size>80*1024*1024)throw new Error('시안 파일은 80MB 이하여야 합니다.');
                const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('시안을 읽지 못했습니다.'));reader.readAsDataURL(selected);});
                const asset=await api('/api/assets',{name:selected.name,content:data});
                Object.assign(target,{asset_id:asset.id,asset_name:asset.name,asset_width:asset.width,asset_height:asset.height});info.textContent=`${asset.name} · ${asset.width} × ${asset.height}px`;
            }catch(error){info.textContent=target.asset_name?`${target.asset_name} · 기존 시안 유지`:'시안 파일을 선택하세요.';throw error;}
            finally{state.uploading--;$('save-project').disabled=state.uploading>0;}
        }));box.append(file,info);
        const grid=element('div',undefined,'field-grid');
        for(const [key,title] of [['width','뷰포트 폭 (px)'],['viewport_height','뷰포트 높이 (px)']]){const label=element('label',title),input=element('input');input.type='number';input.value=target[key];input.min=key==='width'?'240':'320';input.max=key==='width'?'3840':'2160';input.required=true;input.addEventListener('input',()=>{target[key]=Number(input.value);});label.append(input);grid.append(label);}box.append(grid);
        const normal=element('label',undefined,'check'),toggle=element('input');toggle.type='checkbox';toggle.checked=target.normalize;toggle.addEventListener('change',()=>{target.normalize=toggle.checked;});normal.append(toggle,document.createTextNode('시안을 캡처 폭에 맞춰 배율 조정'));box.append(normal);return box;
    }));
    renderResponsiveFields();
}
function renderResponsiveFields(){
    for(const device of ['pc','mo']){
        const field=$(device+'-overlay-target');field.replaceChildren();
        const candidates=state.edit.targets.filter(t=>t.enabled&&t.device===device);
        const blank=element('option','해당 대상 없음');blank.value='';field.append(blank);
        for(const target of candidates){const option=element('option',`${target.name} · ${target.width}px`);option.value=target.id;field.append(option);}
        const saved=state.edit.responsive[device];field.value=candidates.some(t=>t.id===saved)?saved:(candidates.find(t=>/^(pc|desktop|mobile|mo)$/.test(t.id))||candidates[0])?.id||'';
        state.edit.responsive[device]=field.value||null;
    }
}
for(const device of ['pc','mo'])$(device+'-overlay-target').addEventListener('change',event=>{state.edit.responsive[device]=event.target.value||null;});
$('new-project').addEventListener('click',()=>editProject());
$('edit-project').addEventListener('click',()=>editProject(currentProject()));
$('welcome-new').addEventListener('click',action(async()=>{if(state.project)await startRun();else editProject();}));
for(const id of ['close-dialog','cancel-project'])$(id).addEventListener('click',()=>{if(!state.uploading)$('project-dialog').close();});
$('project-dialog').addEventListener('cancel',event=>{if(state.uploading)event.preventDefault();});
$('add-target').addEventListener('click',()=>{if(state.edit.targets.length>=8){toast('검수 대상은 최대 8개입니다.');return;}state.edit.targets.push({id:`size_${Date.now()}`,name:'추가 크기',enabled:false,width:768,viewport_height:1024,normalize:true});renderTargetFields();});
$('project-form').addEventListener('submit',async event=>{
    event.preventDefault();$('project-error').textContent='';if(state.uploading)return;
    $('save-project').disabled=true;
    try{
        state.edit.name=$('project-name-input').value;state.edit.url=$('project-url-input').value;state.edit.profile=JSON.parse($('profile-input').value);
        if($('source-html-input').value.trim()&&!$('source-root-input').value.trim())throw new Error('HTML 파일과 함께 소스 폴더도 지정하세요.');
        state.edit.source=$('source-root-input').value.trim()?{root:$('source-root-input').value.trim(),html:$('source-html-input').value.trim(),url_prefix:$('source-prefix-input').value.trim()}:null;
        state.edit.responsive.breakpoint=Number($('breakpoint-input').value);
        state.edit.settings={pixel_threshold:Number($('threshold-input').value),font_tolerance:Number($('tolerance-input').value),strip_height:Number($('strip-input').value)};
        const saved=await api('/api/projects',state.edit);$('project-dialog').close();await refresh();await selectProject(saved.id);toast('프로젝트 설정을 저장했습니다.');
    }catch(error){$('project-error').textContent=error.message;}finally{$('save-project').disabled=false;}
});
async function startRun(){const run=await api('/api/start',{project_id:state.project});await refresh();await selectRun(run.id);}
$('start-run').addEventListener('click',action(startRun));
$('run-select').addEventListener('change',action(()=>selectRun($('run-select').value)));
$('revision-select').addEventListener('change',action(()=>loadResult($('revision-select').value)));
$('finding-filter').addEventListener('change',()=>{if(state.result)renderFindings();});
$('zoom').addEventListener('change',applyZoom);window.addEventListener('resize',applyZoom);
for(const type of ['reference','actual','diff'])$(type+'-image').addEventListener('load',applyZoom);
$('retry-run').addEventListener('click',action(async()=>{await api('/api/retry',{run_id:state.run.id});await refresh();await selectRun(state.run.id,state.target);}));
$('alignment-form').addEventListener('submit',action(async event=>{
    event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;
    try{state.run=await api('/api/recalculate',{run_id:state.run.id,target_id:state.target,y_offset:Number($('alignment-y').value),reason:$('alignment-reason').value});renderRun();toast('새 비교 버전을 만들고 있습니다.');}finally{button.disabled=currentTarget().status!=='complete';}
}));
$('review-form').addEventListener('submit',action(async event=>{
    event.preventDefault();if(!state.finding)return;const button=event.currentTarget.querySelector('button');button.disabled=true;
    try{
        const review=await api('/api/review',{run_id:state.run.id,target_id:state.target,revision_id:state.result.id,finding_id:state.finding,status:$('review-status').value,severity:$('review-severity').value,note:$('review-note').value});
        state.result.reviews[state.finding]=review;const finding=state.finding;renderFindings();selectFinding(finding);
        const done=Object.values(state.result.reviews).filter(r=>r.status!=='pending').length;$('metrics').children[3].querySelector('strong').textContent=`${done} / ${state.result.findings.length}`;toast('검수 판단을 저장했습니다.');
    }finally{button.disabled=false;}
}));
$('export-run').addEventListener('click',()=>{const a=element('a');a.href=`/api/export?run=${state.run.id}`;a.download='visual-qa-report.zip';document.body.append(a);a.click();a.remove();});
$('chrome-review').addEventListener('click',action(async()=>{
    const result=state.result;
    if(!result)return;
    const route=`/api/chrome-review?run=${result.run_id}&target=${result.target_id}&revision=${result.id}`;
    const response=await fetch(route,{headers:{'X-VisualQA':token}});
    if(!response.ok){const value=await response.json();throw new Error(value.error||'검수 파일을 만들지 못했습니다.');}
    const url=URL.createObjectURL(await response.blob());
    const a=element('a');a.href=url;a.download='visualqa-review.json';document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    toast('PC·MO 통합 파일의 저장을 요청했습니다. 저장된 JSON을 Chrome 확장에서 불러오세요.');
}));
$('prune-runs').addEventListener('click',action(async()=>{
    const input=prompt('완료된 검수 이력을 최근 몇 개 보관할까요? 실패·중단 이력은 유지합니다.','20');if(input===null)return;
    const keep=Number(input);if(!Number.isInteger(keep)||keep<1)throw new Error('1 이상의 정수를 입력하세요.');
    const removable=state.runs.filter(r=>r.project_id===state.project&&r.status==='complete').slice(keep);
    if(!removable.length){toast('정리할 완료 이력이 없습니다.');return;}
    if(!confirm(`오래된 완료 이력 ${removable.length}개를 영구 삭제합니다. 계속할까요?`))return;
    const result=await api('/api/prune',{project_id:state.project,keep,confirm:true});await refresh();await selectProject(state.project);toast(`${result.removed.length}개 이력을 정리했습니다.`);
}));
setInterval(async()=>{
    if(pollBusy||!state.run)return;
    const busy=Object.values(state.run.targets).some(t=>['queued','capturing','comparing'].includes(t.status));
    if(!busy)return;pollBusy=true;
    try{
        const runId=state.run.id,targetId=state.target,previousRevision=currentTarget()?.current_revision;
        const run=await api(`/api/run?id=${runId}`);if(state.run.id!==runId)return;state.run=run;
        const index=state.runs.findIndex(r=>r.id===run.id);if(index>=0)state.runs[index]=run;renderRun();
        if(currentTarget()?.current_revision!==previousRevision||(!state.result&&currentTarget()?.current_revision))await loadResult();
        if(!Object.values(run.targets).some(t=>['queued','capturing','comparing'].includes(t.status)))toast(run.status==='complete'?'검수가 완료되었습니다.':'처리가 끝났습니다. 대상별 결과를 확인하세요.');
    }catch(error){toast(error.message);}finally{pollBusy=false;}
},1200);
refresh(true).catch(error=>toast(error.message));
