/**
 * GSC non-API Data Downloader - Background Service Worker
 * Manages extension state, script injection, and message routing.
 */

chrome.runtime.onInstalled.addListener((details) => {
  // Set default settings
  chrome.storage.local.get(['showFloatingButton', 'defaultFormat'], (res) => {
    chrome.storage.local.set({
      showFloatingButton: res.showFloatingButton !== undefined ? res.showFloatingButton : true,
      defaultFormat: res.defaultFormat || 'zip'
    });
  });

  console.log('GSC non-API Data Downloader extension installed/updated:', details.reason);
});

// Ensure content script is injected if user clicks action on an already open GSC tab
async function ensureContentScriptInjected(tabId) {
  try {
    // Ping tab to check if content script is active
    await chrome.tabs.sendMessage(tabId, { action: 'PING' });
  } catch (err) {
    // If ping fails, inject dependencies and content script dynamically
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/zip-writer.js', 'content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/page-injected.css']
      });
    } catch (injectErr) {
      console.warn('Could not inject script into tab:', injectErr);
    }
  }
}

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ENSURE_INJECTED' && request.tabId) {
    ensureContentScriptInjected(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

