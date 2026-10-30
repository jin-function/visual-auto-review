export const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
export function pageURL(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('인증 정보가 없는 HTTP 또는 HTTPS 페이지를 사용하세요.');
    }
    return url;
}
export function samePage(a, b) {
    try {
        const left = pageURL(a), right = pageURL(b);
        const hashRoute = /^#(?:\/|!)/.test(left.hash) || /^#(?:\/|!)/.test(right.hash);
        return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search && (!hashRoute || left.hash === right.hash);
    } catch { return false; }
}
function finite(value, min, max, label) {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 값이 올바르지 않습니다.`);
    return value;
}
export async function validateReview(value) {
    if (value?.format !== 'visualqa.chrome-review') throw new Error('지원하는 시안 검수 파일이 아닙니다.');
    if (value.version === 1) throw new Error('이전 파일에는 차이 강조본이 들어 있습니다. 검수 앱에서 Chrome용 검수 파일을 다시 저장하세요.');
    if (value.version !== 2 || value.imageRole !== 'reference-original') throw new Error('시안 원본이 포함된 검수 파일을 사용하세요.');
    const url = pageURL(value.url).href;
    const image = value.image;
    if (image?.mime !== 'image/png' || typeof image.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64) || image.base64.length % 4) {
        throw new Error('시안 원본 이미지 형식이 올바르지 않습니다.');
    }
    if (image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('시안 원본은 80MB 이하로 내보내세요.');
    const bytes = Uint8Array.from(atob(image.base64), character => character.charCodeAt(0));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !signature.every((byte, i) => byte === bytes[i])) throw new Error('PNG 이미지가 손상되었습니다.');
    const view = new DataView(bytes.buffer);
    const width = view.getUint32(16), height = view.getUint32(20);
    finite(width, 1, 32768, '이미지 폭'); finite(height, 1, 150000, '이미지 높이');
    if (width * height > 160000000 || width !== image.width || height !== image.height) throw new Error('이미지 크기가 올바르지 않습니다.');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== image.sha256) throw new Error('시안 원본 이미지가 변경되었거나 손상되었습니다.');
    const placement = value.placement;
    finite(placement?.x, -150000, 150000, 'X 위치'); finite(placement?.y, -150000, 150000, 'Y 위치');
    const viewportWidth = finite(value.viewportWidth, 1, 32768, '검수 화면 폭');
    const display = {width: finite(value.display?.width, 1, 32768, '표시 폭'), height: finite(value.display?.height, 1, 150000, '표시 높이')};
    if (!Array.isArray(value.findings) || value.findings.length > 5000) throw new Error('차이 항목이 올바르지 않습니다.');
    const findings = value.findings.map(finding => {
        const rect = finding.rect;
        for (const key of ['x', 'y', 'width', 'height']) finite(rect?.[key], key === 'width' || key === 'height' ? 0 : -150000, 150000, '차이 영역');
        return {id: String(finding.id).slice(0, 100), title: String(finding.title).slice(0, 500),
            rect: {...rect}, selectors: (finding.selectors || []).slice(0, 30).filter(selector => typeof selector === 'string' && selector.length < 2000)};
    });
    return {format: value.format, version: 2, imageRole: 'reference-original', id: 'reference-' + hash.slice(0, 24) + '-' + String(value.revisionId).replace(/[^\w-]/g, '').slice(0, 60),
        name: String(value.name || '검수 결과').slice(0, 300), url, image: {...image},
        targetId: String(value.targetId || '').slice(0, 100), device: ['pc', 'mo'].includes(value.device) ? value.device : null,
        viewportWidth, placement: {x: placement.x, y: placement.y}, display, findings,
        runId: String(value.runId || ''), revisionId: String(value.revisionId || ''), importedAt: Date.now()};
}
export function overlaySettings(value = {}) {
    return {
        opacity: finite(Number(value.opacity ?? 0.4), 0, 1, '투명도'),
        dx: finite(Number(value.dx ?? 0), -150000, 150000, 'X 보정'),
        dy: finite(Number(value.dy ?? 0), -150000, 150000, 'Y 보정'),
        scale: finite(Number(value.scale ?? 1), 0.1, 4, '배율'),
        visible: value.visible !== false,
        toolsCollapsed: value.toolsCollapsed === true,
        saveAs: value.saveAs !== false
    };
}
export function safeFilename(value, fallback = 'page.html') {
    const name = String(value).normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 180);
    return name && !['.', '..'].includes(name) ? name : fallback;
}
export function hashName(value) {
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
}
