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
    globalThis.VisualQALayout = {geometry};
})();
