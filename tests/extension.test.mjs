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
