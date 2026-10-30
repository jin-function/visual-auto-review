// This function is serialized into the inspected page. It must have no outer dependencies.
export function snapshotPage() {
    const clone = document.documentElement.cloneNode(true), originals = [...document.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
    copies.unshift(clone);
    const indexes = new Map(originals.map((node, index) => [node, index]));
    const sheets = [], seen = new Set(), warnings = [];
    function stylesheet(sheet, owner = null) {
        if (seen.has(sheet)) return; seen.add(sheet);
        const entry = {id: `sheet-${sheets.length}`, url: sheet.href || '', owner, css: null, disabled: sheet.disabled};
        sheets.push(entry);
        try {
            const rules = [...sheet.cssRules]; entry.css = rules.map(rule => rule.cssText).join('\n');
            for (const rule of rules) if (rule.styleSheet) stylesheet(rule.styleSheet);
        } catch { entry.unreadable = true; }
        if (owner !== null) copies[owner]?.setAttribute('data-visualqa-export-sheet', entry.id);
    }
    for (const sheet of document.styleSheets) {
        if (sheet.ownerNode?.closest?.('[data-visualqa-extension]')) continue;
        stylesheet(sheet, indexes.get(sheet.ownerNode) ?? null);
    }
    for (let index = 0; index < originals.length; index++) {
        const node = originals[index], copy = copies[index];
        if (!copy) continue;
        if (node instanceof HTMLInputElement && !['password', 'file'].includes(node.type)) {
            copy.setAttribute('value', node.value);
            if (node.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
        }
        if (node instanceof HTMLTextAreaElement) copy.textContent = node.value;
        if (node instanceof HTMLOptionElement) { if (node.selected) copy.setAttribute('selected', ''); else copy.removeAttribute('selected'); }
    }
    for (const sheet of document.adoptedStyleSheets || []) {
        try { const style = document.createElement('style'); style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n'); clone.querySelector('head')?.append(style); }
        catch { warnings.push('구성된 스타일시트 일부를 읽지 못했습니다.'); }
    }
    clone.querySelectorAll('[data-visualqa-extension]').forEach(node => node.remove());
    if (originals.some(node => node.shadowRoot)) warnings.push('Shadow DOM 내부는 HTML 사본에 포함되지 않습니다.');
    if (document.querySelector('iframe')) warnings.push('iframe 내부 문서는 별도로 내보내야 합니다.');
    if (document.querySelector('canvas:not([data-visualqa-extension])')) warnings.push('페이지 canvas의 그려진 내용은 HTML로 저장되지 않습니다.');
    return {url: location.href, base: document.baseURI, title: document.title, html: clone.outerHTML,
        doctype: document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '<!doctype html>', sheets, warnings};
}

export function inspectSelector(selector) {
    return `(() => { if (document.querySelectorAll(${JSON.stringify(selector)}).length > 1) throw new Error('선택자가 여러 요소를 가리킵니다. Elements에서 직접 선택하세요.'); const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({block: 'center'}); inspect(node); return true; })()`;
}
