import {legacyPackageId, CONTRACT} from './core.mjs';

let connection;
const images = new Map();
const CACHE_BYTES = 96 * 1024 * 1024;
function transaction(db, stores, mode, action) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        try { result = action(tx); } catch (error) { tx.abort(); reject(error); return; }
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('검수 파일 저장이 취소되었습니다.'));
    });
}
async function migratePackages(db) {
    const reviews = await transaction(db, ['reviews'], 'readonly', tx => tx.objectStore('reviews').getAll());
    const groups = new Map();
    for (const review of reviews.filter(item => !item.packageId)) {
        review.packageId = await legacyPackageId(review);
        if (!groups.has(review.packageId)) groups.set(review.packageId, {id: review.packageId, legacy: true, version: 2,
            name: review.name, url: review.url, runId: review.runId, breakpoint: CONTRACT.defaultBreakpoint, importedAt: review.importedAt, reviewIds: []});
        groups.get(review.packageId).reviewIds.push(review.id);
    }
    if (!groups.size) return;
    await transaction(db, ['reviews', 'packages'], 'readwrite', tx => {
        for (const review of reviews) tx.objectStore('reviews').put(review);
        for (const group of groups.values()) tx.objectStore('packages').put(group);
    });
}
function database() {
    if (!connection) connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('visualqa-reviews', 2);
        request.onupgradeneeded = () => {
            const db = request.result;
            const reviews = db.objectStoreNames.contains('reviews') ? request.transaction.objectStore('reviews') : db.createObjectStore('reviews', {keyPath: 'id'});
            db.createObjectStore('assets', {keyPath: 'sha256'});
            db.createObjectStore('packages', {keyPath: 'id'});
            reviews.openCursor().onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return;
                const review = cursor.value;
                if (review.image?.base64) {
                    const {base64, ...image} = review.image;
                    request.transaction.objectStore('assets').put({sha256: image.sha256, base64});
                    cursor.update({...review, image});
                }
                cursor.continue();
            };
        };
        request.onsuccess = () => migratePackages(request.result).then(() => resolve(request.result), reject);
        request.onerror = () => { connection = null; reject(request.error); };
        request.onblocked = () => reject(new Error('다른 검수 도구 창을 닫고 다시 불러오세요.'));
    });
    return connection;
}
export async function reviewStore(mode, action) {
    return transaction(await database(), ['reviews'], mode, tx => action(tx.objectStore('reviews')));
}
export const getReviewMeta = id => reviewStore('readonly', store => store.get(id));
export async function getReview(id) {
    const review = await getReviewMeta(id);
    if (!review) return;
    let image = images.get(review.image.sha256);
    if (!image) image = await transaction(await database(), ['assets'], 'readonly', tx => tx.objectStore('assets').get(review.image.sha256));
    if (!image) throw new Error('시안 이미지가 없습니다. 검수 파일을 다시 불러오세요.');
    images.delete(image.sha256); images.set(image.sha256, image);
    let bytes = [...images.values()].reduce((size, item) => size + item.base64.length * 2, 0);
    for (const [hash, item] of images) {
        if (bytes <= CACHE_BYTES) break;
        images.delete(hash); bytes -= item.base64.length * 2;
    }
    return {...review, image: {...review.image, base64: image.base64}};
}
export async function listReviews() {
    return (await reviewStore('readonly', store => store.getAll())).sort((a, b) => b.importedAt - a.importedAt);
}
export async function getPackage(id) {
    return transaction(await database(), ['packages'], 'readonly', tx => tx.objectStore('packages').get(id));
}
export async function listPackages() {
    return (await transaction(await database(), ['packages'], 'readonly', tx => tx.objectStore('packages').getAll())).sort((a, b) => b.importedAt - a.importedAt);
}
export async function putPackage(packageValue) {
    const db = await database();
    const {targets, ...meta} = packageValue;
    const reviewIds = targets.map(target => target.id);
    // Validation completes before this transaction; PC, MO and images commit together.
    await transaction(db, ['reviews', 'assets', 'packages'], 'readwrite', tx => {
        for (const target of targets) {
            const {base64, ...image} = target.image;
            tx.objectStore('assets').put({sha256: image.sha256, base64});
            tx.objectStore('reviews').put({...target, image});
        }
        const packages = tx.objectStore('packages');
        if (packageValue.legacy) {
            const previous = packages.get(packageValue.id);
            previous.onsuccess = () => packages.put({...meta, reviewIds: [...new Set([...(previous.result?.reviewIds || []), ...reviewIds])]});
        } else packages.put({...meta, reviewIds});
    });
}
export async function putReview(review) {
    const id = review.packageId || await legacyPackageId(review);
    return putPackage({id, name: review.name, url: review.url, runId: review.runId, legacy: true, version: 2,
        breakpoint: CONTRACT.defaultBreakpoint, importedAt: review.importedAt, targets: [{...review, packageId: id}]});
}
export async function deletePackage(id) {
    const db = await database(), group = await getPackage(id);
    if (!group) return;
    await transaction(db, ['reviews', 'packages'], 'readwrite', tx => {
        for (const reviewId of group.reviewIds) tx.objectStore('reviews').delete(reviewId);
        tx.objectStore('packages').delete(id);
    });
    await transaction(db, ['assets', 'reviews'], 'readwrite', tx => {
        const metadata = tx.objectStore('reviews').getAll();
        metadata.onsuccess = () => {
            const used = new Set(metadata.result.map(review => review.image.sha256));
            tx.objectStore('assets').openCursor().onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return;
                if (!used.has(cursor.key)) { images.delete(cursor.key); cursor.delete(); }
                cursor.continue();
            };
        };
    });
}
