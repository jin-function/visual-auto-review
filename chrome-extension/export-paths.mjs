import {safeFilename} from './core.mjs';

export function originalFilename(url, fallback) {
    let name;
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* Use a name only when it is unavailable. */ }
    return safeFilename(name || fallback, fallback);
}
export function stylesheetPaths(urls) {
    const paths = new Map(), used = new Set();
    for (const url of urls) {
        if (paths.has(url)) continue;
        const filename = originalFilename(url, 'style.css');
        let path = `css/${filename}`, suffix = 2;
        // Windows also needs case-insensitive collision protection. Keep the filename intact.
        while (used.has(path.normalize('NFC').toLowerCase())) path = `css/source-${suffix++}/${filename}`;
        used.add(path.normalize('NFC').toLowerCase()); paths.set(url, path);
    }
    return paths;
}
export function relativePath(from, to) {
    const source = from.split('/').slice(0, -1), target = to.split('/');
    while (source.length && target.length && source[0] === target[0]) { source.shift(); target.shift(); }
    return '../'.repeat(source.length) + target.join('/');
}
