(() => {
    const version = chrome.runtime.getManifest().version;
    if (globalThis.__visualQAOverlay?.version === version) return;
    globalThis.__visualQAOverlay?.destroy?.();
    // A reloaded extension loses its old isolated context, but its DOM can remain on the page.
    for (const stale of document.querySelectorAll('visualqa-overlay[data-visualqa-extension="overlay"]')) stale.remove();
    let host, canvas, context, bitmap, transfer, meta, settings, selected, frame = 0, devtoolsReady = false;
    let destroyed = false, resizeTimer, generation = 0;
    function device() { return innerWidth < (meta?.breakpoint || 1024) ? 'mo' : 'pc'; }
    function active() { return !!bitmap && !!host?.isConnected && meta?.device === device(); }
    function geometry() { return meta && VisualQALayout.geometry(innerWidth, innerHeight, meta, settings, scrollX, scrollY); }
    function status() {
        return {version, connected: !!meta && !!host?.isConnected, imageVisible: active() && settings.visible, viewportWidth: innerWidth, viewportHeight: innerHeight,
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
        if (!active() || !settings.visible) return;
        context.globalAlpha = settings.opacity;
        context.drawImage(bitmap, layout.x, layout.y, layout.imageWidth, layout.imageHeight);
        context.globalAlpha = 1;
        if (selected) {
            context.strokeStyle = '#0084ff'; context.lineWidth = 2;
            context.strokeRect(layout.x + selected.x * settings.scale, layout.y + selected.y * settings.scale,
                selected.width * settings.scale, selected.height * settings.scale);
        }
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
        bitmap?.close(); bitmap = null; transfer = null; selected = null; meta = null;
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
            return {ready: true};
        }
        if (message.type === 'chunk') {
            if (!transfer || transfer.id !== message.transferId || message.index !== transfer.chunks.length || typeof message.data !== 'string') throw new Error('이미지 전송 순서가 올바르지 않습니다.');
            transfer.size += message.data.length;
            if (transfer.size > 112 * 1024 * 1024) { transfer = null; throw new Error('이미지가 너무 큽니다.'); }
            transfer.chunks.push(message.data);
            return {received: message.index};
        }
        if (message.type === 'finish') {
            if (!transfer || transfer.id !== message.transferId) throw new Error('이미지를 다시 연결하세요.');
            const pending = transfer; transfer = null;
            const bytes = Uint8Array.from(atob(pending.chunks.join('')), character => character.charCodeAt(0));
            const next = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
            if (next.width !== pending.meta.width || next.height !== pending.meta.height) { next.close(); throw new Error('이미지 크기가 다릅니다.'); }
            if (destroyed || pending.generation !== generation || pending.meta.device !== (innerWidth < pending.meta.breakpoint ? 'mo' : 'pc')) {
                next.close(); return {stale: true};
            }
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
            scrollTo({left: Math.max(0, scrollX + layout.imageScreenX + selected.x * settings.scale - innerWidth / 4),
                top: Math.max(0, meta.placement.y + settings.dy + selected.y * settings.scale - innerHeight / 3), behavior: 'instant'});
            schedule(); return status();
        }
        if (message.type === 'remove') { remove(); return {removed: true}; }
        if (message.type === 'devtools-state') { devtoolsReady = message.ready; return status(); }
        throw new Error('지원하지 않는 오버레이 요청입니다.');
    }
    const listener = (message, sender, respond) => {
        if (sender.id !== chrome.runtime.id) return false;
        receive(message).then(respond).catch(error => respond({error: error.message}));
        return true;
    };
    addEventListener('scroll', schedule, {passive: true});
    addEventListener('resize', viewportChanged, {passive: true});
    globalThis.visualViewport?.addEventListener('resize', viewportChanged, {passive: true});
    chrome.runtime.onMessage.addListener(listener);
    globalThis.__visualQAOverlay = {version, destroy() {
        destroyed = true; clearTimeout(resizeTimer); remove();
        removeEventListener('scroll', schedule); removeEventListener('resize', viewportChanged);
        globalThis.visualViewport?.removeEventListener('resize', viewportChanged);
        chrome.runtime.onMessage.removeListener(listener);
    }};
})();
