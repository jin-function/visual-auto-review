import './overlay-layout.js';
export const DEFAULT_BREAKPOINT = 1024;
export const overlayGeometry = globalThis.VisualQALayout.geometry;

export function deviceForWidth(width, breakpoint = DEFAULT_BREAKPOINT) {
    return width < breakpoint ? 'mo' : 'pc';
}

export function reviewDevice(review, breakpoint = DEFAULT_BREAKPOINT) {
    if (['pc', 'mo'].includes(review.device)) return review.device;
    if (/^(?:mobile|mo)$/i.test(review.targetId || '')) return 'mo';
    if (/^(?:desktop|pc)$/i.test(review.targetId || '')) return 'pc';
    return deviceForWidth(review.viewportWidth, breakpoint);
}

// Only pair results from the same run automatically. Other runs require an explicit choice.
export function initialVariants(anchor, reviews, samePage) {
    const variants = {pc: null, mo: null};
    const candidates = reviews.filter(review => review.version === 2 && review.imageRole === 'reference-original'
        && anchor.runId && review.runId === anchor.runId && samePage(review.url, anchor.url))
        .sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
    for (const review of candidates) {
        const device = reviewDevice(review);
        if (!variants[device]) variants[device] = review.id;
    }
    variants[reviewDevice(anchor)] = anchor.id;
    return variants;
}
