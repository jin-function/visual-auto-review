import {overlaySettings} from './core.mjs';

const tabKey = id => `tab:${id}`;
const preferenceKey = id => `review:${id}`;
export async function binding(tabId) {
    return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)];
}
export async function preferences(packageId) {
    return (await chrome.storage.local.get(preferenceKey(packageId)))[preferenceKey(packageId)] || {};
}
export async function storeBinding(tabId, value, persist = false) {
    await chrome.storage.session.set({[tabKey(tabId)]: value});
    if (persist && value.packageId) await chrome.storage.local.set({[preferenceKey(value.packageId)]: {
        settings: overlaySettings(value.settings), adjustments: value.adjustments, breakpoint: value.breakpoint,
        customVariants: value.customVariants ? value.variants : null
    }});
}
export const removeBinding = tabId => chrome.storage.session.remove(tabKey(tabId));
