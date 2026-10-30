// This function is serialized into the inspected page. It must have no outer dependencies.
export function snapshotPage(options = {}, cleanup) {
    const clone = document.documentElement.cloneNode(true), originals = [...document.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
    copies.unshift(clone);
    const indexes = new Map(originals.map((node, index) => [node, index]));
    const sheets = [], seen = new Set(), warnings = [];
    function stylesheet(sheet, owner = null, parent = null) {
        if (seen.has(sheet)) return; seen.add(sheet);
        const entry = {id: `sheet-${sheets.length}`, url: sheet.href || '', owner, parent, css: null,
            raw: sheet.ownerNode?.tagName === 'STYLE' ? sheet.ownerNode.textContent : null, disabled: sheet.disabled};
        sheets.push(entry);
        try {
            const rules = [...sheet.cssRules]; entry.rules = rules.map(rule => rule.cssText); entry.css = entry.rules.join('\n');
            for (const rule of rules) if (rule.styleSheet) stylesheet(rule.styleSheet, null, entry.id);
        } catch { entry.unreadable = true; }
        if (owner !== null) copies[owner]?.setAttribute('data-visualqa-export-sheet', entry.id);
    }
    for (const sheet of document.styleSheets) stylesheet(sheet, indexes.get(sheet.ownerNode) ?? null);
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
        try {
            const entry = {id: `sheet-${sheets.length}`, url: '', owner: 'adopted', raw: null,
                rules: [...sheet.cssRules].map(rule => rule.cssText), disabled: sheet.disabled};
            entry.css = entry.rules.join('\n'); sheets.push(entry);
            const style = document.createElement('style'); style.textContent = entry.css;
            style.setAttribute('data-visualqa-export-sheet', entry.id); clone.querySelector('head')?.append(style);
        } catch { warnings.push('구성된 스타일시트 일부를 읽지 못했습니다.'); }
    }
    if (typeof cleanup !== 'function') throw new Error('내보내기 정리 도구를 다시 불러오세요.');
    const cleanedNodes = cleanup(clone, {...options, base: document.baseURI, preserveSheetMarkers: true});
    const owned = new Set([...clone.querySelectorAll('[data-visualqa-export-sheet]')].map(node => node.getAttribute('data-visualqa-export-sheet')));
    const excluded = new Set();
    for (const entry of sheets) if ((entry.owner !== null && !owned.has(entry.id)) || excluded.has(entry.parent)) excluded.add(entry.id);
    if (originals.some(node => node.shadowRoot && !node.closest('[data-visualqa-extension]'))) warnings.push('Shadow DOM 내부는 HTML 사본에 포함되지 않습니다.');
    if (clone.querySelector('iframe')) warnings.push('iframe 내부 문서는 별도로 내보내야 합니다.');
    if (clone.querySelector('canvas')) warnings.push('페이지 canvas의 그려진 내용은 HTML로 저장되지 않습니다.');
    return {url: location.href, base: document.baseURI, title: document.title, html: clone.outerHTML, cleanedNodes,
        excludedStyles: sheets.filter(entry => excluded.has(entry.id)).map(entry => entry.url).filter(Boolean),
        doctype: document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '<!doctype html>',
        sheets: sheets.filter(entry => !excluded.has(entry.id)), warnings};
}

export function inspectSelector(selector) {
    return `(() => { if (document.querySelectorAll(${JSON.stringify(selector)}).length > 1) throw new Error('선택자가 여러 요소를 가리킵니다. Elements에서 직접 선택하세요.'); const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({block: 'center'}); inspect(node); return true; })()`;
}
