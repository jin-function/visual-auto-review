import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReview, samePage, overlaySettings, safeFilename} from '../chrome-extension/core.mjs';
import {rebaseCSS, rebaseSrcset} from '../chrome-extension/css.mjs';
import {zipFiles, crc32} from '../chrome-extension/zip.mjs';
import {inspectSelector} from '../chrome-extension/snapshot.mjs';
import {sidePanelRegistered, requireSidePanel, RELOAD_GUIDANCE} from '../chrome-extension/extension-state.mjs';

test('CSS rebases URLs and imports without altering comments, strings, data URLs or fragments', () => {
    const text = `/* url(../wrong.png) */\n@import /* keep */ "../base/a.css" screen;\n.x {content: 'url(fake)'; background: url('../img/a b.png'); mask: url(#mask); --a: url(data:image/png;base64,abc);}`;
    const result = rebaseCSS(text, 'https://example.com/css/main.css', url => url.endsWith('/base/a.css') ? './import.css' : url);
    assert.match(result, /@import \/\* keep \*\/ "\.\/import.css" screen/);
    assert.match(result, /url\("https:\/\/example.com\/img\/a%20b.png"\)/);
    assert.match(result, /content: 'url\(fake\)'/);
    assert.match(result, /url\(\.\.\/wrong.png\)/);
    assert.match(result, /url\("#mask"\)/);
    assert.match(result, /url\("data:image\/png;base64,abc"\)/);
});
test('CSS escaped quotes, escaped parentheses and hex escapes resolve correctly', () => {
    const result = rebaseCSS(String.raw`.x{a:url(../img/a\)b.png);b:url("../img/\61 .png");c:url('../img/a\'b.png')}`, 'https://e.test/css/a.css');
    assert.match(result, /https:\/\/e.test\/img\/a\)b.png/);
    assert.match(result, /https:\/\/e.test\/img\/a.png/);
    assert.match(result, /https:\/\/e.test\/img\/a'b.png/);
});
test('srcset preserves data commas and descriptors', () => {
    assert.equal(rebaseSrcset('../img/a.png 1x, ../img/b.png 2x', 'https://e.test/html/a.html'), 'https://e.test/img/a.png 1x, https://e.test/img/b.png 2x');
    assert.equal(rebaseSrcset('data:image/png;base64,abc 1x, /b.png 2x', 'https://e.test/a'), 'data:image/png;base64,abc 1x, https://e.test/b.png 2x');
});
test('review package validates image integrity and uses stable URL and coordinates', async () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBykAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const value = {format: 'visualqa.chrome-review', version: 2, imageRole: 'reference-original', display: {width: 1, height: 1}, url: 'https://e.test/a', image: {mime: 'image/png', width: 1, height: 1, sha256, base64}, viewportWidth: 390, placement: {x: 20, y: -13}, findings: [], revisionId: 'rev-1'};
    const review = await validateReview(value); assert.deepEqual(review.placement, {x: 20, y: -13});
    await assert.rejects(validateReview({...value, image: {...value.image, sha256: 'wrong'}}), /손상/);
    await assert.rejects(validateReview({...value, url: 'javascript:alert(1)'}));
    await assert.rejects(validateReview({...value, image: {...value.image, width: 2}}), /크기/);
    await assert.rejects(validateReview({...value, placement: {x: 0, y: Infinity}}));
    await assert.rejects(validateReview({...value, version: 1}), /다시 저장/);
    await assert.rejects(validateReview({...value, imageRole: 'diff'}), /시안 원본/);
    await assert.rejects(validateReview({...value, display: {width: 0, height: 1}}));
});
test('overlay settings do not silently scale and URL matching rejects other pages', () => {
    assert.equal(overlaySettings().scale, 1);
    assert.equal(overlaySettings().toolsCollapsed, false);
    assert.equal(overlaySettings().saveAs, true);
    assert.throws(() => overlaySettings({opacity: 2}));
    assert.throws(() => overlaySettings({dy: NaN}));
    assert.ok(samePage('https://e.test/a?q=1#top', 'https://e.test/a?q=1'));
    assert.ok(!samePage('https://e.test/a?q=1', 'https://e.test/a?q=2'));
    assert.ok(!samePage('https://e.test/#/page-a', 'https://e.test/#/page-b'));
    assert.ok(!samePage('https://e.test/a', 'https://other.test/a'));
    assert.ok(!samePage('https://user:pass@e.test/a', 'https://e.test/a'));
    assert.equal(safeFilename('../../bad.css'), '_.._bad.css');
});
test('selector text cannot execute code outside querySelector argument', () => {
    const selector = '#x"); alert(1); //';
    const expression = inspectSelector(selector);
    assert.ok(expression.includes(`querySelector(${JSON.stringify(selector)})`));
});
test('sidepanel detects unapplied permissions and missing APIs without a TypeError', () => {
    assert.equal(sidePanelRegistered({permissions: ['storage']}), false);
    assert.equal(sidePanelRegistered({permissions: ['sidePanel']}), true);
    assert.throws(() => requireSidePanel({permissions: ['storage']}, undefined), {message: RELOAD_GUIDANCE});
    assert.throws(() => requireSidePanel({permissions: ['sidePanel']}, undefined), /Chrome 사이드패널 기능/);
    assert.throws(() => requireSidePanel({permissions: ['sidePanel']}, {}), /Chrome 사이드패널 기능/);
    assert.doesNotThrow(() => requireSidePanel({permissions: ['sidePanel']}, {open() {}}));
});
test('ZIP stores Unicode paths and CRC and rejects duplicate or traversal entries', async () => {
    const zip = new Uint8Array(await zipFiles([{name: 'html/검수.html', content: '수정됨'}]).arrayBuffer());
    const header = new DataView(zip.buffer);
    assert.equal(header.getUint32(0, true), 0x04034b50);
    assert.equal(header.getUint16(6, true), 0x800);
    const encoded = new TextEncoder().encode('수정됨');
    assert.equal(header.getUint32(14, true), crc32(encoded));
    assert.equal(new TextDecoder().decode(zip.slice(30, 30 + header.getUint16(26, true))), 'html/검수.html');
    assert.throws(() => zipFiles([{name: '../bad.css', content: ''}]));
    assert.throws(() => zipFiles([{name: 'x', content: ''}, {name: 'x', content: ''}]));
});

test('responsive variants use CSS viewport width and pair only the same page and run', async () => {
    const {deviceForWidth, reviewDevice, initialVariants} = await import('../chrome-extension/responsive.mjs');
    assert.equal(deviceForWidth(1023), 'mo');
    assert.equal(deviceForWidth(1024), 'pc');
    assert.equal(deviceForWidth(768, 769), 'mo');
    assert.equal(reviewDevice({targetId: 'mobile', viewportWidth: 1200}), 'mo');
    assert.equal(reviewDevice({targetId: 'pc', viewportWidth: 900}), 'pc');
    const mo = {id: 'mo', version: 2, imageRole: 'reference-original', url: 'https://e.test/page', runId: 'run', viewportWidth: 390};
    const pc = {...mo, id: 'pc', viewportWidth: 1920};
    const wrongRun = {...pc, id: 'wrong-run', runId: 'other', importedAt: 999};
    const wrongPage = {...pc, id: 'wrong-page', url: 'https://e.test/other', importedAt: 999};
    assert.deepEqual(initialVariants(mo, [wrongRun, wrongPage, pc, mo], samePage), {pc: 'pc', mo: 'mo'});
    assert.deepEqual(initialVariants(mo, [wrongRun, wrongPage], samePage), {pc: null, mo: 'mo'});
});

test('overlay keeps review width, centers wide and narrow planes and retains document offsets', async () => {
    const {overlayGeometry} = await import('../chrome-extension/responsive.mjs');
    const meta = {viewportWidth: 1920, display: {width: 1920, height: 10000}, placement: {x: 0, y: 60}};
    const settings = {dx: 0, dy: 0, scale: 1};
    const narrow = overlayGeometry(1200, 600, meta, settings);
    assert.equal(narrow.canvasWidth, 1920);
    assert.equal(narrow.canvasLeft, -360);
    assert.equal(narrow.imageScreenX, -360);
    assert.equal(narrow.imageWidth, 1920);
    const wide = overlayGeometry(2560, 600, meta, settings);
    assert.equal(wide.canvasWidth, 2560);
    assert.equal(wide.imageScreenX, 320);
    const mo = overlayGeometry(320, 600, {...meta, viewportWidth: 390, display: {width: 390, height: 5000}}, {...settings, dx: 11, dy: 7}, 5, 100);
    assert.equal(mo.canvasWidth, 390);
    assert.equal(mo.imageWidth, 390);
    assert.equal(mo.imageScreenX, -29);
    assert.equal(mo.imageScreenY, -33);
});

test('export keeps original filenames and isolates duplicate CSS names in folders', async () => {
    const {originalFilename, stylesheetPaths, relativePath} = await import('../chrome-extension/export-paths.mjs');
    const paths = stylesheetPaths(['https://a.test/css/style.css?v=2', 'https://b.test/style.css', 'https://a.test/STYLE.css', 'https://a.test/css/%EC%8B%9C%EC%95%88.css']);
    assert.equal(originalFilename('https://a.test/html/original.htm?q=1', 'index.html'), 'original.htm');
    assert.equal(paths.get('https://a.test/css/style.css?v=2'), 'css/style.css');
    assert.equal(paths.get('https://b.test/style.css'), 'css/source-2/style.css');
    assert.equal(paths.get('https://a.test/STYLE.css'), 'css/source-3/STYLE.css');
    assert.equal(paths.get('https://a.test/css/%EC%8B%9C%EC%95%88.css'), 'css/시안.css');
    assert.equal(relativePath('css/source-2/style.css', 'css/import.css'), '../import.css');
    assert.equal(relativePath('html/original.htm', 'css/style.css'), '../css/style.css');
});
test('export URL changes preserve CSS CRLF, tabs, quote style and whitespace inside url()', () => {
    const css = '/* keep */\r\n@import  \'./other.css\';\r\n.x {\r\n\tbackground: URL(\r\n\t\t"../img/a.png"  \r\n\t);\r\n\tmask: url( #mask );\r\n}\r\n';
    const output = rebaseCSS(css, 'https://a.test/css/style.css', url => url.endsWith('/other.css') ? 'other.css' : url, true);
    assert.equal(output, css.replace('./other.css', 'other.css').replace('../img/a.png', 'https://a.test/img/a.png'));
    assert.equal(rebaseCSS('.x{a:url(../img/a\\)b.png)}', 'https://a.test/css/style.css', undefined, true), '.x{a:url(https://a.test/img/a\\)b.png)}');
});
test('CSS source merge preserves authored rules/comments and inserts or deletes runtime rules', async () => {
    const {cssRuleRanges, mergeStylesheet} = await import('../chrome-extension/css-source.mjs');
    const normalize = value => value.replace(/\s+/g, '');
    const css = '/* heading */\r\n.a {\r\n\tcolor: red;\r\n}\r\n\r\n/* tail */\r\n.b { width: 10px; }\r\n';
    const rules = ['.a {color:red;}', '.b {width:10px;}'];
    assert.equal(mergeStylesheet(css, rules, normalize), css);
    const added = mergeStylesheet(css, [...rules, '.runtime { margin: 17px; }'], normalize);
    assert.ok(added.includes('.a {\r\n\tcolor: red;\r\n}'));
    assert.ok(added.includes('/* tail */\r\n.b { width: 10px; }'));
    assert.ok(added.includes('.runtime {\r\n\tmargin: 17px;\r\n}'));
    const removed = mergeStylesheet(css, rules.slice(1), normalize);
    assert.ok(!removed.includes('.a {'));
    assert.ok(removed.includes('/* heading */'));
    assert.ok(removed.includes('.b { width: 10px; }'));
    const tricky = '/* { */\n.a[data-v="};"] { content: "}"; --x: {nested: ";"}; background: url(data:x;{}); }\n@media (min-width:1px) {.b{color:red}}';
    assert.equal(cssRuleRanges(tricky).length, 2);
});

test('v3 package validates both images before import and rejects mixed or duplicate targets', async () => {
    const {validatePackage, CONTRACT} = await import('../chrome-extension/core.mjs');
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    const target = {format: CONTRACT.format, version: 2, imageRole:'reference-original',name:'fixture',runId:'r',revisionId:'v',url:'https://e.test/page',placement:{x:0,y:0},display:{width:390,height:390},viewportWidth:390,image:{mime:'image/png',width:1,height:1,sha256,base64},findings:[]};
    const pc = {...target, device:'pc',targetId:'pc',revisionId:'pc-v',viewportWidth:1920};
    const mo = {...target, device:'mo',targetId:'mobile'};
    const packageValue = {format:CONTRACT.format,version:3,packageId:'a'.repeat(64),coordinateSpace:CONTRACT.coordinateSpace,runId:'r',url:target.url,responsive:{breakpoint:900},targets:[pc,mo]};
    const group = await validatePackage(packageValue);
    assert.equal(group.targets.length,2);assert.equal(group.breakpoint,900);assert.notEqual(group.targets[0].id,group.targets[1].id);
    await assert.rejects(validatePackage({...packageValue,targets:[pc,pc]}), /중복/);
    await assert.rejects(validatePackage({...packageValue,targets:[pc,{...mo,runId:'other'}]}), /같은 실행/);
    await assert.rejects(validatePackage({...packageValue,targets:[pc,{...mo,image:{...mo.image,sha256:'0'.repeat(64)}}]}), /손상/);
    const old = await validatePackage(mo);assert.equal(old.legacy,true);assert.equal(old.targets.length,1);
});

test('app and extension use the same generated handoff contract', async () => {
    const fs = await import('node:fs/promises');
    const {CONTRACT} = await import('../chrome-extension/contract.mjs');
    assert.deepEqual(CONTRACT, JSON.parse(await fs.readFile(new URL('../app/review-contract.json',import.meta.url),'utf8')));
});

test('late responses from a previous result/revision cannot update the selected view', async () => {
    const {runInNewContext} = await import('node:vm');
    const fs = await import('node:fs/promises');
    const window = {};
    runInNewContext(await fs.readFile(new URL('../app/web/request_state.js',import.meta.url),'utf8'),{window});
    const first=window.VisualQARequests.begin('result');
    const second=window.VisualQARequests.begin('result');
    assert.equal(first(),false);assert.equal(second(),true);
    window.VisualQARequests.begin('run','result');assert.equal(second(),false);
});

async function overlayLifecycle() {
    const {createContext,runInContext}=await import('node:vm');
    const fs=await import('node:fs/promises');
    const listeners=new Map(),timers=new Map(),frames=new Map(),hosts=[];
    let valid=true,listener,sequence=0,decode;
    const invalid=()=>{if(!valid)throw new Error('Extension context invalidated.');};
    const context=createContext({Blob,atob,innerWidth:390,innerHeight:600,devicePixelRatio:1,scrollX:0,scrollY:0,location:{href:'https://e.test/page'},
        chrome:{runtime:{get id(){return valid?'extension':undefined;},getManifest(){invalid();return {version:'test'};},sendMessage(){invalid();return Promise.resolve();},
            onMessage:{addListener(fn){invalid();listener=fn;},removeListener(){invalid();listener=null;}}}},
        document:{querySelectorAll(){return hosts.filter(host=>host.isConnected);},documentElement:{append(host){host.isConnected=true;}},createElement(tag){
            const node={style:{},setAttribute(){},remove(){this.isConnected=false;},attachShadow(){return {append(){}};},getContext(){return {setTransform(){},clearRect(){},drawImage(){}};}};
            if(tag==='visualqa-overlay')hosts.push(node);return node;
        }},
        addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);},
        setTimeout(fn){const id=++sequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
        requestAnimationFrame(fn){const id=++sequence;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);},
        createImageBitmap:()=>new Promise(resolve=>{decode=resolve;})});
    for(const file of ['overlay-layout.js','content.js'])runInContext(await fs.readFile(new URL('../chrome-extension/'+file,import.meta.url),'utf8'),context);
    const meta={reviewId:'r',packageId:'p',device:'mo',breakpoint:1024,viewportWidth:390,width:1,height:1,display:{width:1,height:1},placement:{x:0,y:0},settings:{visible:true,opacity:1,dx:0,dy:0,scale:1}};
    return {context,meta,hosts,listeners,invalidate(){valid=false;},decode(bitmap){decode(bitmap);},
        receive(message){return new Promise(resolve=>listener(message,{id:'extension'},resolve));},
        flush(){for(const map of [timers,frames])for(const [id,fn] of [...map]){map.delete(id);fn();}}};
}

test('an extension reload cleans up old overlay events without synchronous runtime errors',async()=>{
    const page=await overlayLifecycle();
    await page.receive({type:'empty',meta:page.meta});
    page.invalidate();
    assert.doesNotThrow(()=>{page.listeners.get('resize')();page.flush();});
    assert.equal(page.hosts.some(host=>host.isConnected),false);
    assert.equal(page.listeners.size,0);
});

test('destroy remains safe after Chrome invalidates the extension context',async()=>{
    const page=await overlayLifecycle();
    await page.receive({type:'empty',meta:page.meta});page.invalidate();
    assert.doesNotThrow(()=>page.context.__visualQAOverlay.destroy());
    assert.equal(page.hosts.some(host=>host.isConnected),false);
});

test('an image finishing after an extension reload never mounts an orphan overlay',async()=>{
    const page=await overlayLifecycle();
    await page.receive({type:'begin',transferId:'t',meta:page.meta});
    await page.receive({type:'chunk',transferId:'t',index:0,data:'AA=='});
    const pending=page.receive({type:'finish',transferId:'t'});
    page.invalidate();
    const bitmap={width:1,height:1,closed:false,close(){this.closed=true;}};page.decode(bitmap);
    await pending;
    assert.equal(page.hosts.some(host=>host.isConnected),false);
    assert.equal(bitmap.closed,true);
});

test('invalidated DevTools and panel clients stop reconnecting to an unloaded extension',async()=>{
    const {createContext,runInContext}=await import('node:vm');
    const fs=await import('node:fs/promises');
    for(const file of ['devtools.js','client.mjs']) {
        let valid=true,disconnected,sequence=0,connections=0;
        const timers=new Map();
        const context=createContext({URL:{revokeObjectURL(){}},
            chrome:{runtime:{get id(){return valid?'extension':undefined;},connect(){
                if(!valid)throw new Error('Extension context invalidated.');connections++;
                return {postMessage(){},disconnect(){},onMessage:{addListener(){}},onDisconnect:{addListener(fn){disconnected=fn;}}};
            }},devtools:{panels:{create(){}},inspectedWindow:{tabId:1}}},
            setTimeout(fn){const id=++sequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
            setInterval(fn){const id=++sequence;timers.set(id,fn);return id;},clearInterval(id){timers.delete(id);},addEventListener(){}});
        // Keep production connection logic; stub only its imported export/selector dependencies.
        const source=(await fs.readFile(new URL('../chrome-extension/'+file,import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
        runInContext(source,context);
        if(file==='client.mjs')context.subscribe(()=>{},()=>{});
        valid=false;
        assert.doesNotThrow(()=>{disconnected();for(const [id,fn] of [...timers]){timers.delete(id);fn();}},file);
        assert.equal(connections,1,file);
        assert.equal(timers.size,0,file);
    }
});
