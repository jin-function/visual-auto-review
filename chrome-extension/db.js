let connection;
function database() {
    if (!connection) connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('visualqa-reviews', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('reviews', {keyPath: 'id'});
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return connection;
}
export async function reviewStore(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('reviews', mode);
        const request = action(transaction.objectStore('reviews'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('검수 파일 저장이 취소되었습니다.'));
    });
}
export const getReview = id => reviewStore('readonly', store => store.get(id));
export const putReview = review => reviewStore('readwrite', store => store.put(review));
export const deleteReview = id => reviewStore('readwrite', store => store.delete(id));
export async function listReviews() {
    const reviews = await reviewStore('readonly', store => store.getAll());
    return reviews.sort((a, b) => b.importedAt - a.importedAt).map(({image, ...review}) => review);
}
