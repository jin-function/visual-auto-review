// Standalone: also serialized into the inspected page by collectExport.
export function stripTooling(root, options = {}) {
    const owned = '[data-visualqa-extension],visualqa-overlay,visualqa-tools,[data-visualqa-overlay],[data-visualqa-tools]';
    let removed = 0;
    function remove(node) { if (node.parentNode) { node.remove(); removed++; } }
    root.querySelectorAll(owned).forEach(remove);
    root.querySelectorAll('[data-id="five-server"],#fiveserver-info-wrapper,#fiveserver-info').forEach(remove);
    for (const node of root.querySelectorAll('script,style,link')) {
        const address = node.getAttribute('src') || node.getAttribute('href') || '';
        if (options.extensionOrigin && address.startsWith(options.extensionOrigin)) { remove(node); continue; }
        if (node.tagName === 'SCRIPT') {
            let localFiveServer = false;
            try {
                const url = new URL(address, options.base || 'https://invalid.example/');
                localFiveServer = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && /^\/fiveserver\.js$/i.test(url.pathname);
            } catch { /* An inline page script has no URL. */ }
            const liveServer = /\bfunction\s+refreshCSS\s*\(/.test(node.textContent)
                && /\bWebSocket\b/.test(node.textContent) && /(?:window\.)?location\.host/.test(node.textContent);
            if (localFiveServer || liveServer) remove(node);
        }
        if (node.tagName === 'STYLE' && /@(?:-webkit-)?keyframes\s+fiveserverInfoPopup\b/i.test(node.textContent)
            && /#fiveserver-info(?:-wrapper)?\b/.test(node.textContent)) remove(node);
    }
    const document = root.ownerDocument || root;
    const walker = document.createTreeWalker(root, 128); // SHOW_COMMENT
    const comments = [];
    while (walker.nextNode()) if (/^\s*Code injected by (?:Five-server|live-server)\s*$/i.test(walker.currentNode.data)) comments.push(walker.currentNode);
    comments.forEach(remove);
    for (const node of root.querySelectorAll('*')) {
        for (const attribute of [...node.attributes]) {
            if (/^data-visualqa-export-/.test(attribute.name) && !(options.preserveSheetMarkers && attribute.name === 'data-visualqa-export-sheet')) node.removeAttribute(attribute.name);
        }
    }
    return removed;
}
