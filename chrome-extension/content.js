(() => {
    const version = chrome.runtime.getManifest().version;
    if (globalThis.__visualQAOverlay?.version === version) return;
    globalThis.__visualQAOverlay?.destroy?.();
    // A reloaded extension loses its old isolated context, but its DOM can remain on the page.
    for (const stale of document.querySelectorAll('visualqa-overlay[data-visualqa-extension="overlay"]')) stale.remove();
    let host, canvas, context, bitmap, transfer, meta, settings, selected, frame = 0, devtoolsReady = false;
    let destroyed = false, resizeTimer, generation = 0, paintedReviewId = null, notified = '';
    const cache = new Map();
    function notify() {
        const value = status();
        const signature = JSON.stringify([value.imageState, value.reviewId, value.viewportWidth, value.settings]);
        if (signature === notified) return;
        notified = signature;
        chrome.runtime.sendMessage({type: 'rendered'}).catch(() => {});
    }
    function device() { return innerWidth < (meta?.breakpoint || 1024) ? 'mo' : 'pc'; }
    function active() { return !!bitmap && !!host?.isConnected && meta?.device === device(); }
    function geometry() { return meta && VisualQALayout.geometry(innerWidth, innerHeight, meta, settings, scrollX, scrollY); }
    function status() {
        const layout = geometry();
        const outside = layout && (layout.imageScreenX >= innerWidth || layout.imageScreenX + layout.imageWidth <= 0 || layout.y >= innerHeight || layout.y + layout.imageHeight <= 0);
        const imageState = transfer || (!!meta && meta.device !== device()) ? 'loading' : !active() ? 'missing' : !settings.visible || settings.opacity === 0 ? 'hidden' : outside ? 'outside' : paintedReviewId === meta.reviewId ? 'ready' : 'loading';
        return {version, imageState, cachedReviewIds: [...cache.keys()], connected: !!meta && !!host?.isConnected, imageVisible: imageState === 'ready', viewportWidth: innerWidth, viewportHeight: innerHeight,
            scrollX, scrollY, settings, devtoolsReady, imageRole: meta?.imageRole, reviewId: active() ? meta.reviewId : null,
            device: device(), missingVariant: !!meta && !bitmap && meta.device === device(), switching: !!transfer || (!!meta && meta.device !== device()), geometry: geometry(),
            url: location.href, widthMismatch: !!meta && innerWidth !== meta.viewportWidth};
    }
    function paint() {
        frame = 0;
        if (!canvas || !meta || !host?.isConnected) return;
        host.setAttribute('data-visualqa-device', device());
        host.setAttribute('data-visualqa-review-id', active() ? meta.reviewId : '');
        const layout = geometry();
        const ratio = Math.min(devicePixelRatio || 1, 2, 32760 / layout.canvasWidth, 32760 / innerHeight);
        const width = Math.ceil(layout.canvasWidth * ratio), height = Math.ceil(innerHeight * ratio);
        canvas.style.width = `${layout.canvasWidth}px`;
        canvas.style.minWidth = `${meta.viewportWidth}px`;
        canvas.style.height = `${innerHeight}px`;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, layout.canvasWidth, innerHeight);
        paintedReviewId = null;
        if (!active() || !settings.visible || !settings.opacity) { notify(); return; }
        context.globalAlpha = settings.opacity;
        context.drawImage(bitmap, layout.x, layout.y, layout.imageWidth, layout.imageHeight);
        context.globalAlpha = 1;
        if (selected) {
            context.strokeStyle = '#0084ff'; context.lineWidth = 2;
            const rect = VisualQALayout.findingRect(selected, layout, settings.scale);
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);
        }
        paintedReviewId = meta.reviewId; notify();
    }
    function schedule() { if (!frame && !destroyed) frame = requestAnimationFrame(paint); }
    function mount() {
        if (host?.isConnected) return;
        for (const stale of document.querySelectorAll('visualqa-overlay[data-visualqa-extension="overlay"]')) stale.remove();
        host = document.createElement('visualqa-overlay');
        host.setAttribute('data-visualqa-extension', 'overlay');
        host.setAttribute('data-visualqa-version', version);
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;pointer-events:none!important;overflow:hidden!important;contain:strict!important;display:flex!important;justify-content:center!important;align-items:flex-start!important;';
        const shadow = host.attachShadow({mode: 'closed'});
        canvas = document.createElement('canvas');
        canvas.style.cssText = 'display:block;flex:0 0 auto;max-width:none;pointer-events:none;';
        shadow.append(canvas); context = canvas.getContext('2d');
        document.documentElement.append(host);
    }
    function remove() {
        generation++;
        bitmap?.close(); bitmap = null; transfer = null; selected = null; meta = null; paintedReviewId = null;
        host?.remove(); host = null; canvas = null;
        if (frame) cancelAnimationFrame(frame); frame = 0;
    }
    function viewportChanged() {
        schedule();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!meta || destroyed) return;
            chrome.runtime.sendMessage({type: 'viewport', width: innerWidth}).catch(() => {});
        }, 80);
    }
    async function receive(message) {
        if (message.type === 'status') return status();
        if (message.type === 'begin') {
            transfer = {id: message.transferId, meta: message.meta, generation: ++generation, chunks: [], size: 0};
            notify();
            return {ready: true};
        }
        if (message.type === 'chunk') {
            if (!transfer || transfer.id !== message.transferId || message.index !== transfer.chunks.length || typeof message.data !== 'string') throw new Error('이미지 전송 순서가 올바르지 않습니다.');
            transfer.size += message.data.length;
            if (transfer.size > 112 * 1024 * 1024) { transfer = null; throw new Error('이미지가 너무 큽니다.'); }
            transfer.chunks.push(message.data);
            return {received: message.index};
        }
        if (message.type === 'finish' || message.type === 'reuse') {
            if (message.type === 'reuse') {
                if (!cache.has(message.meta.reviewId)) throw new Error('시안 캐시를 다시 연결하세요.');
                transfer = {id: message.transferId, meta: message.meta, generation: ++generation};
            }
            if (!transfer || transfer.id !== message.transferId) throw new Error('이미지를 다시 연결하세요.');
            const pending = transfer;
            const blob = message.type === 'reuse' ? cache.get(pending.meta.reviewId) : new Blob([Uint8Array.from(atob(pending.chunks.join('')), character => character.charCodeAt(0))], {type: 'image/png'});
            const next = await createImageBitmap(blob);
            if (next.width !== pending.meta.width || next.height !== pending.meta.height) { next.close(); throw new Error('이미지 크기가 다릅니다.'); }
            if (destroyed || pending.generation !== generation || pending.meta.device !== (innerWidth < pending.meta.breakpoint ? 'mo' : 'pc')) {
                next.close(); if (transfer === pending) transfer = null; return {stale: true};
            }
            if (meta?.packageId && meta.packageId !== pending.meta.packageId) cache.clear();
            cache.delete(pending.meta.reviewId); cache.set(pending.meta.reviewId, blob);
            let bytes = [...cache.values()].reduce((sum, item) => sum + item.size, 0);
            for (const [id, value] of cache) { if (bytes <= 32 * 1024 * 1024) break; cache.delete(id); bytes -= value.size; }
            transfer = null; paintedReviewId = null;
            bitmap?.close(); bitmap = next; meta = pending.meta; settings = {...meta.settings}; selected = null;
            devtoolsReady = meta.devtoolsReady === true;
            mount(); schedule(); return status();
        }
        if (message.type === 'empty') {
            remove(); meta = message.meta; settings = {...meta.settings}; devtoolsReady = meta.devtoolsReady === true;
            mount(); schedule(); return status();
        }
        if (message.type === 'settings') {
            if (!meta) throw new Error('오버레이를 먼저 연결하세요.');
            settings = {...message.settings}; schedule(); return status();
        }
        if (message.type === 'jump') {
            if (!active()) throw new Error('현재 화면에 맞는 시안을 먼저 연결하세요.');
            selected = message.rect;
            const layout = geometry();
            scrollTo({...VisualQALayout.jumpPosition(selected, layout, meta, settings, innerWidth, innerHeight, scrollX), behavior: 'instant'});
            schedule(); return status();
        }
        if (message.type === 'remove') { remove(); return {removed: true}; }
        if (message.type === 'devtools-state') { devtoolsReady = message.ready; return status(); }
        throw new Error('지원하지 않는 오버레이 요청입니다.');
    }
    const listener = (message, sender, respond) => {
        if (sender.id !== chrome.runtime.id) return false;
        receive(message).then(respond).catch(error => { transfer = null; schedule(); respond({error: error.message}); });
        return true;
    };
    addEventListener('scroll', schedule, {passive: true});
    addEventListener('resize', viewportChanged, {passive: true});
    globalThis.visualViewport?.addEventListener('resize', viewportChanged, {passive: true});
    chrome.runtime.onMessage.addListener(listener);
    globalThis.__visualQAOverlay = {version, destroy() {
        destroyed = true; clearTimeout(resizeTimer); remove(); cache.clear();
        removeEventListener('scroll', schedule); removeEventListener('resize', viewportChanged);
        globalThis.visualViewport?.removeEventListener('resize', viewportChanged);
        chrome.runtime.onMessage.removeListener(listener);
    }};
})();
