/* Source editing stays beside the visual evidence. No generated page is edited. */
(() => {
    const editor = {doc:null, links:[], elements:[], dirty:false, generation:0, busy:false, project:null, inspecting:false,pending:null};
    const field = id => document.getElementById(id);
    function status(message, error=false) {
        field('source-status').textContent=message;
        field('source-status').className=error?'source-error':'muted';
    }
    function show() {
        field('source-workbench').hidden=false;document.body.classList.add('source-open');applyZoom();
        requestAnimationFrame(()=>document.querySelector('.review-layout')?.scrollIntoView({block:'start'}));
    }
    function canLeave() {
        if(!editor.dirty)return true;
        if(!confirm('저장하지 않은 소스 변경이 있습니다. 변경 내용을 버리고 이동할까요?'))return false;
        if(editor.doc){field('source-code').value=editor.doc.content;lineNumbers();}
        editor.dirty=false;buttons();return true;
    }
    function reset() {
        editor.generation++;editor.doc=null;editor.dirty=false;editor.busy=false;editor.pending=null;
        field('source-workbench').hidden=true;field('source-editor-body').hidden=true;document.body.classList.remove('source-open');
    }
    function buttons() {
        const disabled=editor.busy||!editor.doc;
        for(const id of ['source-save','source-save-rerun','source-reload','source-open-editor'])field(id).disabled=disabled;
        field('source-undo').disabled=disabled||!editor.doc?.backup_id;
        field('source-file-state').textContent=editor.doc?`${editor.doc.path} · ${editor.dirty?'저장하지 않은 변경':'저장된 원본'}`:'';
    }
    async function loadFile(link, guarded=true) {
        if(guarded&&!canLeave())return;
        const generation=++editor.generation;editor.busy=true;buttons();
        try{
            const doc=await api(`/api/source/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(link.path)}&line=${link.line||1}`);
            if(generation!==editor.generation)return;
            editor.doc=doc;editor.project=state.project;editor.dirty=false;
            field('source-code').value=doc.content;field('source-editor-body').hidden=false;
            lineNumbers();
            const lines=doc.content.split('\n'),start=lines.slice(0,doc.line-1).reduce((n,line)=>n+line.length+1,0);
            field('source-code').focus({preventScroll:true});field('source-code').setSelectionRange(start,start+(lines[doc.line-1]?.length||0));
            field('source-code').scrollTop=Math.max(0,(doc.line-4)*20);syncNumbers();
            status(`${doc.path}:${doc.line} · ${link.exact===false?'요소 위치를 직접 확인하세요.':'해당 위치로 이동했습니다.'}`);
        }catch(error){status(error.message,true);toast(error.message);}
        finally{if(generation===editor.generation){editor.busy=false;buttons();}}
    }
    function setLinks(links) {
        editor.links=links;
        field('source-files').replaceChildren(...links.map((link,index)=>{const option=element('option',`${link.label} · ${link.path}:${link.line}`);option.value=String(index);return option;}));
    }
    async function inspect(selector) {
        if(!canLeave())return;
        if(editor.inspecting){editor.pending=selector;status('현재 요소 확인을 마친 뒤 선택한 요소로 이동합니다.');return;}
        editor.inspecting=true;
        const generation=++editor.generation;editor.busy=true;editor.dirty=false;editor.doc=null;buttons();
        field('source-editor-body').hidden=true;
        status('현재 페이지에서 요소와 실제 적용된 CSS 규칙을 찾고 있습니다.');
        try{
            const links=await api('/api/source/resolve',{run_id:state.run.id,target_id:state.target,revision_id:state.result.id,selector});
            if(generation!==editor.generation)return;
            setLinks(links.links);editor.busy=false;
            await loadFile(links.links[0],false);
            if(links.warnings.length)status(links.warnings.join('\n'),true);
        }catch(error){if(generation===editor.generation){status(error.message,true);editor.busy=false;buttons();}}
        finally{
            editor.inspecting=false;
            if(editor.pending&&!field('source-workbench').hidden){const next=editor.pending;editor.pending=null;inspect(next);}
        }
    }
    function select(elements) {
        if(!canLeave())return;
        show();editor.elements=elements||[];
        field('source-element-title').textContent=elements?.[0]?.selector||'선택한 영역의 소스';
        field('source-elements').replaceChildren(...editor.elements.map(item=>{const option=element('option',item.selector);option.value=item.selector;return option;}));
        if(!currentProject()?.source){field('source-editor-body').hidden=true;status('소스 폴더와 HTML 파일을 한 번 연결하면 해당 요소를 바로 수정할 수 있습니다.');return;}
        if(!elements?.length){status('연결된 요소가 없는 영역입니다. HTML 열기로 원본을 확인할 수 있습니다.');field('source-editor-body').hidden=true;return;}
        inspect(elements[0].selector);
    }
    async function openHtml() {
        if(!canLeave())return;show();
        const project=currentProject();
        if(!project?.source){select([]);return;}
        field('source-element-title').textContent='페이지 HTML';field('source-elements').replaceChildren();
        const link={path:project.source.html,line:1,label:'HTML 파일',exact:false};setLinks([link]);await loadFile(link,false);
    }
    function lineNumbers() {field('source-line-numbers').textContent=Array.from({length:field('source-code').value.split('\n').length},(_,i)=>String(i+1)).join('\n');}
    function syncNumbers() {field('source-line-numbers').scrollTop=field('source-code').scrollTop;}
    async function save(rerun=false) {
        if(!editor.doc||editor.busy)return;editor.busy=true;buttons();
        try{
            const result=await api('/api/source/save',{project_id:editor.project,path:editor.doc.path,sha256:editor.doc.sha256,connection_id:editor.doc.connection_id,content:field('source-code').value});
            editor.doc=result;editor.dirty=false;
            status(result.changed?'원본을 백업하고 저장했습니다. 현재 캡처는 수정 전 결과이므로 재검수로 확인하세요.':'저장할 변경이 없습니다.');
            toast(result.changed?'원본 백업과 저장을 완료했습니다.':'변경 내용이 없습니다.');
            if(rerun){editor.busy=false;await startRun();}
        }catch(error){status(error.message,true);toast(error.message);}
        finally{editor.busy=false;buttons();}
    }
    field('source-code').addEventListener('input',()=>{editor.dirty=field('source-code').value!==editor.doc?.content;lineNumbers();buttons();});
    field('source-code').addEventListener('scroll',syncNumbers);
    field('source-code').addEventListener('keydown',event=>{
        if(event.key==='Tab'){event.preventDefault();const input=event.currentTarget;input.setRangeText('    ',input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));}
        if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();save();}
    });
    field('source-files').addEventListener('change',()=>loadFile(editor.links[Number(field('source-files').value)]));
    field('source-elements').addEventListener('change',()=>inspect(field('source-elements').value));
    field('source-save').addEventListener('click',()=>save());
    field('source-save-rerun').addEventListener('click',()=>save(true));
    field('source-reload').addEventListener('click',()=>loadFile({path:editor.doc.path,line:editor.doc.line,exact:true}));
    field('source-undo').addEventListener('click',action(async()=>{
        if(!editor.doc?.backup_id||!canLeave())return;
        const result=await api('/api/source/restore',{project_id:editor.project,backup_id:editor.doc.backup_id,sha256:editor.doc.sha256,connection_id:editor.doc.connection_id});
        await loadFile({path:result.path,line:editor.doc.line,exact:true},false);status('직전 저장 전의 원본으로 되돌렸습니다. 되돌리기 전 파일도 백업했습니다.');
    }));
    field('source-open-editor').addEventListener('click',action(async()=>{
        if(editor.dirty){toast('앱에서 변경한 내용을 먼저 저장하세요.');return;}
        await api('/api/source/open',{project_id:editor.project,path:editor.doc.path,line:editor.doc.line,connection_id:editor.doc.connection_id});toast('연결된 편집기로 원본 파일을 열었습니다.');
    }));
    field('close-source').addEventListener('click',()=>{if(canLeave()){reset();applyZoom();}});
    field('source-configure').addEventListener('click',()=>{if(!canLeave())return;reset();editProject(currentProject());field('source-connection').open=true;field('source-root-input').focus();});
    field('open-html-source').addEventListener('click',openHtml);
    field('edit-finding-source').addEventListener('click',()=>select(currentFinding()?.elements||[]));
    for(const type of ['reference','actual','diff'])field(type+'-image').addEventListener('click',event=>{
        if(!state.result||!canLeave())return;
        const image=event.currentTarget,box=image.getBoundingClientRect(),m=state.result.metrics;
        const x=(event.clientX-box.left)*m.width/box.width,y=(event.clientY-box.top)*m.width/box.width;
        const finding=state.result.findings.filter(f=>x>=f.rect.x&&x<f.rect.x+f.rect.width&&y>=f.rect.y&&y<f.rect.y+f.rect.height).sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height)[0];
        if(finding)selectFinding(finding.id,false);
        const actualY=y-m.actual_top;
        const elements=(state.result.capture.domElements||[]).filter(item=>x>=item.rect.x&&x<item.rect.x+item.rect.width&&actualY>=item.rect.y&&actualY<item.rect.y+item.rect.height).sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height).slice(0,12);
        if(elements.length)select(elements);else if(finding)select(finding.elements);else openHtml();
    });
    const nativeRequests=new Map();let requestId=0;
    window.visualqaNativeResult=result=>{const resolve=nativeRequests.get(result.requestId);if(resolve){nativeRequests.delete(result.requestId);resolve(result.path);}};
    async function choose(kind){
        const handler=window.webkit?.messageHandlers?.sourcePicker;
        if(!handler){toast('앱 창에서 선택하거나 파일 경로를 직접 입력하세요.');return;}
        const id=String(++requestId);
        const selected=await new Promise(resolve=>{nativeRequests.set(id,resolve);handler.postMessage({kind,requestId:id});});
        if(selected)field(kind==='folder'?'source-root-input':'source-html-input').value=selected;
    }
    field('choose-source-root').addEventListener('click',()=>choose('folder'));
    field('choose-source-html').addEventListener('click',()=>choose('html'));
    window.SourceEditor={select,canLeave,reset};
})();
