// Legacy accordion behavior is intentionally preserved.
async function openAccordions(send, profile, delay) {
    const toggleResult = await send("Runtime.evaluate", {
        expression: `(() => {
            const toggleSelector = ${JSON.stringify(profile.toggleSelectors)}.join(', ');
            const toggles = Array.from(new Set(document.querySelectorAll(toggleSelector)));
            toggles.forEach(toggle => {
                if (toggle instanceof HTMLDetailsElement) {
                    toggle.open = true;
                    return;
                }
                if (toggle.getAttribute('aria-expanded') !== 'true') {
                    toggle.click();
                }
            });

            toggles.forEach(toggle => {
                if (toggle instanceof HTMLDetailsElement) return;
                const contentId = toggle.getAttribute('aria-controls');
                const content = contentId ? document.getElementById(contentId) : null;
                if (toggle.hasAttribute('aria-expanded') || contentId) {
                    toggle.setAttribute('aria-expanded', 'true');
                }
                if (content) {
                    window.clearTimeout(content._slideTimer);
                    content.hidden = false;
                    content.removeAttribute('hidden');
                    [
                        'height', 'padding-top', 'padding-bottom', 'margin-top',
                        'margin-bottom', 'overflow', 'transition-duration',
                        'transition-property'
                    ].forEach(property => content.style.removeProperty(property));
                }
                if (toggle.matches('.concierge_faq__head')) {
                    toggle.closest('li')?.classList.add('active');
                }
            });
            return toggles.length;
        })()`,
        returnByValue: true,
    });
    await delay(350);
    const toggleState = await send("Runtime.evaluate", {
        expression: `(() => {
            const toggleSelector = ${JSON.stringify(profile.toggleSelectors)}.join(', ');
            const toggles = Array.from(new Set(document.querySelectorAll(toggleSelector)));
            const opened = toggles.filter(toggle => {
                if (toggle instanceof HTMLDetailsElement) return toggle.open;
                const contentId = toggle.getAttribute('aria-controls');
                const content = contentId ? document.getElementById(contentId) : null;
                const controlledContentIsOpen = !content ||
                    (!content.hidden && getComputedStyle(content).display !== 'none');
                return (toggle.getAttribute('aria-expanded') === 'true' && controlledContentIsOpen) ||
                    toggle.classList.contains('open') ||
                    toggle.classList.contains('active') ||
                    toggle.classList.contains('is-open');
            });
            return { toggleCount: toggles.length, openedToggleCount: opened.length };
        })()`,
        returnByValue: true,
    });
    const toggles = toggleState.result.value;
    if (toggles.openedToggleCount !== toggleResult.result.value) {
        throw new Error(`아코디언 열기 실패: 전체 ${toggleResult.result.value}개, 열린 상태 ${toggles.openedToggleCount}개`);
    }
    return toggles;
}
module.exports = { openAccordions };
