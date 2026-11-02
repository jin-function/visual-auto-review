export async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({type, ...payload});
    if (!result?.ok || result.value?.error) throw new Error(result?.error || result?.value?.error || '확장 도구 연결을 확인하세요.');
    return result.value;
}
export function subscribe(changed, failed) {
    const extensionId = chrome.runtime.id;
    let port, retry, closed = false;
    function available() {
        try { return !closed && !!extensionId && chrome.runtime.id === extensionId; } catch { return false; }
    }
    function close() {
        closed = true; clearTimeout(retry);
        try { port?.disconnect(); } catch { /* Context invalidated. */ }
    }
    function invalidated() {
        close(); failed?.('확장을 갱신했습니다. 검수 패널과 개발자도구를 다시 열어 주세요.');
    }
    function connect() {
        if (closed) return;
        if (!available()) { invalidated(); return; }
        try {
            port = chrome.runtime.connect({name: 'visualqa-ui'});
            port.onMessage.addListener(message => { if (message.type === 'changed') changed(message.tabId, message.reason); });
            port.onDisconnect.addListener(() => {
                if (closed) return;
                if (!available()) { invalidated(); return; }
                failed?.('확장 연결을 다시 확인하고 있습니다.');
                retry = setTimeout(connect, 1000);
            });
            changed();
        } catch (error) {
            if (!available() || error.message.includes('Extension context invalidated')) { invalidated(); return; }
            failed?.(error.message); retry = setTimeout(connect, 2000);
        }
    }
    connect();
    return close;
}
