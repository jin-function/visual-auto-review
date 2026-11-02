export async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({type, ...payload});
    if (!result?.ok || result.value?.error) throw new Error(result?.error || result?.value?.error || '확장 도구 연결을 확인하세요.');
    return result.value;
}
export function subscribe(changed, failed) {
    let port, retry, closed = false;
    function connect() {
        if (closed) return;
        try {
            port = chrome.runtime.connect({name: 'visualqa-ui'});
            port.onMessage.addListener(message => { if (message.type === 'changed') changed(message.tabId, message.reason); });
            port.onDisconnect.addListener(() => {
                if (closed) return;
                failed?.('확장 연결을 다시 확인하고 있습니다.');
                retry = setTimeout(connect, 1000);
            });
            changed();
        } catch (error) { failed?.(error.message); retry = setTimeout(connect, 2000); }
    }
    connect();
    return () => { closed = true; clearTimeout(retry); port?.disconnect(); };
}
