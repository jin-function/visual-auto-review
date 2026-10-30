export const RELOAD_GUIDANCE = 'Chrome에서 사이드패널 업데이트를 적용해야 합니다. ‘Chrome 확장 관리 열기’를 누르고 시안 검수의 새로고침 버튼을 누르세요. 권한 확인이 나오면 허용한 뒤 확장 아이콘으로 도구를 다시 여세요.';

export function sidePanelRegistered(manifest) {
    return manifest?.permissions?.includes('sidePanel') === true;
}

export function requireSidePanel(manifest, api) {
    if (!sidePanelRegistered(manifest)) throw new Error(RELOAD_GUIDANCE);
    if (typeof api?.open !== 'function') throw new Error('Chrome 사이드패널 기능을 사용할 수 없습니다. 확장 관리에서 시안 검수를 새로고침하고 Chrome 120 이상에서 다시 여세요.');
}
