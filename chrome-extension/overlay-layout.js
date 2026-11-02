(() => {
    function geometry(viewportWidth, viewportHeight, meta, settings, scrollX = 0, scrollY = 0) {
        const reviewWidth = meta.viewportWidth;
        const canvasWidth = Math.max(viewportWidth, reviewWidth, meta.display.width * settings.scale);
        const canvasLeft = (viewportWidth - canvasWidth) / 2;
        const x = (canvasWidth - reviewWidth) / 2 + meta.placement.x + settings.dx - scrollX;
        const y = meta.placement.y + settings.dy - scrollY;
        return {canvasWidth, canvasHeight: viewportHeight, canvasLeft, x, y,
            imageScreenX: canvasLeft + x, imageScreenY: y,
            imageWidth: meta.display.width * settings.scale, imageHeight: meta.display.height * settings.scale};
    }
    function findingRect(rect, layout, scale) {
        return {x: layout.x + rect.x * scale, y: layout.y + rect.y * scale,
            width: rect.width * scale, height: rect.height * scale};
    }
    function jumpPosition(rect, layout, meta, settings, viewportWidth, viewportHeight, scrollX) {
        return {left: Math.max(0, scrollX + layout.imageScreenX + rect.x * settings.scale - viewportWidth / 4),
            top: Math.max(0, meta.placement.y + settings.dy + rect.y * settings.scale - viewportHeight / 3)};
    }
    globalThis.VisualQALayout = {geometry, findingRect, jumpPosition};
})();
