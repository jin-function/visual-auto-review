// Resolve an element and its authored CSS through Chrome's own matched-rule data.
const crypto = require('crypto');

async function inspectSource(send, evaluate, selector, sheets) {
    await send('DOM.enable');
    await send('CSS.enable');
    const root = await send('DOM.getDocument', {depth: 0});
    const found = await send('DOM.querySelector', {nodeId: root.root.nodeId, selector});
    if (!found.nodeId) throw new Error('현재 페이지에서 해당 요소를 찾지 못했습니다. 새 검수를 실행해 주세요.');
    const count = await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (count !== 1) throw new Error('선택자가 여러 요소를 가리킵니다. 새 검수 후 다시 선택하세요.');
    const element = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const path = [];
        for (let node = element; node; node = node.parentElement) {
            const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(e => e.tagName === node.tagName) : [node];
            path.unshift({tag:node.tagName.toLowerCase(),nth:siblings.indexOf(node)+1,id:node.id});
        }
        return {tag:element.tagName.toLowerCase(),id:element.id,attributes:Object.fromEntries(Array.from(element.attributes).map(a => [a.name,a.value])),path,outerHTML:element.outerHTML.slice(0,30000)};
    })()`);
    const matched = await send('CSS.getMatchedStylesForNode', {nodeId: found.nodeId});
    const rules = [];
    const sheetTexts = new Map();
    const groups = [{matches: [...(matched.matchedCSSRules || [])].reverse(), inherited: false},
        ...(matched.inherited || []).map(item => ({matches:[...(item.matchedCSSRules || [])].reverse(), inherited:true}))];
    const seen = new Set();
    for (const group of groups) {
        for (const match of group.matches) {
            const rule = match.rule;
            if ((rule.media || []).some(media => media.mediaList?.length && !media.mediaList.some(query => query.active))) continue;
            if ((rule.supports || []).some(condition => condition.active === false)) continue;
            if (!rule.styleSheetId || rule.origin === 'user-agent') continue;
            const header = sheets.get(rule.styleSheetId);
            if (!header || !header.sourceURL) continue;
            if (!sheetTexts.has(rule.styleSheetId)) {
                const sheet = await send('CSS.getStyleSheetText', {styleSheetId:rule.styleSheetId});
                sheetTexts.set(rule.styleSheetId, crypto.createHash('sha256').update(sheet.text.replace(/\r\n/g,'\n')).digest('hex'));
            }
            const range = rule.selectorList.selectors?.[match.matchingSelectors?.[0]]?.range || rule.style.range;
            if (!range) continue;
            const key = `${rule.styleSheetId}:${range.startLine}:${range.startColumn}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rules.push({url:header.sourceURL, inline:header.isInline, sheetStartLine:header.startLine || 0,
                sheetStartColumn:header.startColumn || 0, line:range.startLine+1,column:range.startColumn+1,
                sheetHash:sheetTexts.get(rule.styleSheetId),selector:rule.selectorList.text,
                inherited:group.inherited, properties:(rule.style.cssProperties || []).filter(p => !p.disabled && p.parsedOk !== false).map(p => ({name:p.name,value:p.value,important:p.important}))});
            if (rules.length >= 100) break;
        }
        if (rules.length >= 100) break;
    }
    return {selector, element, rules};
}
module.exports = {inspectSource};
