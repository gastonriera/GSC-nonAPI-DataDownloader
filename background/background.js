/**
 * GSC non-API Data Downloader - Background Service Worker (v3.1.9)
 * Coordinates script injection, configures automatic downloads, detects native GSC downloads,
 * and organizes all exported Excel (.xlsx) and CSV (.zip) files into a single date-stamped folder
 * (GSC-Exports-YYYY-MM-DD) automatically without triggering save dialogs.
 */

let pendingDownloadQueue = [];
let lastDownloadMeta = null;
let lastDownloadTime = 0;
let downloadWaiters = [];

/**
 * Returns the current date in YYYY-MM-DD format based on local time.
 */
function getLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Automatically grants multi-file download permissions to Google Search Console
 * so Chrome never pauses batch exports or prompts "Allow multiple downloads?".
 */
function configureSiteDownloadPermissions() {
  if (chrome.contentSettings && chrome.contentSettings.automaticDownloads) {
    const patterns = [
      'https://search.google.com/*',
      'https://*.google.com/*',
      'https://*.googleusercontent.com/*'
    ];

    patterns.forEach((primaryPattern) => {
      try {
        chrome.contentSettings.automaticDownloads.set({
          primaryPattern,
          setting: 'allow'
        }, () => {
          if (chrome.runtime.lastError) {
            // Silently ignore pattern restrictions
          }
        });
      } catch (e) {}
    });
  }
}

// Configure site permissions on startup
configureSiteDownloadPermissions();

chrome.runtime.onInstalled.addListener((details) => {
  configureSiteDownloadPermissions();

  chrome.storage.local.get(['showFloatingButton', 'exportFormat', 'organizeSubfolder'], (res) => {
    chrome.storage.local.set({
      showFloatingButton: res.showFloatingButton !== undefined ? res.showFloatingButton : true,
      exportFormat: res.exportFormat || 'excel',
      organizeSubfolder: true // Always default to true so all files go into the date folder
    });
  });

  console.log('GSC non-API Data Downloader installed/updated (v3.1.9):', details.reason);
});

// Ensure latest content script is injected if user clicks action on an already open GSC tab
async function ensureContentScriptInjected(tabId) {
  const currentVersion = chrome.runtime.getManifest().version;
  let needsInjection = false;

  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    if (!res || res.version !== currentVersion) {
      needsInjection = true;
    }
  } catch (err) {
    needsInjection = true;
  }

  if (needsInjection) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
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

function sanitizeSegment(str, maxLen = 45) {
  if (!str) return '';
  return String(str)
    .replace(/[^a-zA-Z0-9_\-\.]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, maxLen);
}

/**
 * Checks whether a download originates from Google Search Console or Google services.
 */
function isGscDownload(downloadItem) {
  const url = (downloadItem.url || '').toLowerCase();
  const referrer = (downloadItem.referrer || '').toLowerCase();
  const finalUrl = (downloadItem.finalUrl || '').toLowerCase();
  const mime = (downloadItem.mime || '').toLowerCase();
  const filename = (downloadItem.filename || '').toLowerCase();

  const isGoogleDomain =
    url.includes('search.google.com') ||
    referrer.includes('search.google.com') ||
    finalUrl.includes('search.google.com') ||
    url.includes('googleusercontent.com') ||
    finalUrl.includes('googleusercontent.com') ||
    url.includes('.google.com') ||
    referrer.includes('.google.com');

  const isExportFile =
    filename.endsWith('.xlsx') ||
    filename.endsWith('.csv') ||
    filename.endsWith('.zip') ||
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime.includes('zip') ||
    mime.includes('csv');

  const isRecentBatch = (Date.now() - lastDownloadTime < 60000);

  return (isGoogleDomain && isExportFile) || (isRecentBatch && isExportFile) || isGoogleDomain || isRecentBatch;
}

// Listen for download creation so the content script knows immediately when GSC starts a file download
if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    lastDownloadTime = Date.now();
    if (downloadWaiters.length > 0) {
      const waiters = [...downloadWaiters];
      downloadWaiters = [];
      waiters.forEach((resolve) => resolve({ started: true, downloadId: downloadItem.id }));
    }
  });
}

// Rename and organize ALL GSC exported files into a single date folder (GSC-Exports-YYYY-MM-DD)
// with conflictAction: 'uniquify' so Chrome never opens a Save As dialog
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    try {
      if (!isGscDownload(downloadItem)) {
        suggest();
        return;
      }

      const dateStr = getLocalDateString();
      const targetFolder = `GSC-Exports-${dateStr}`;

      // Purge queue items older than 60 seconds
      const now = Date.now();
      pendingDownloadQueue = pendingDownloadQueue.filter((m) => (now - m.timestamp < 60000));

      // Retrieve next queued metadata item in first-in-first-out order
      let meta = null;
      if (pendingDownloadQueue.length > 0) {
        meta = pendingDownloadQueue.shift();
      } else if (lastDownloadMeta && (now - lastDownloadTime < 30000)) {
        meta = lastDownloadMeta;
      }

      // Determine extension from original filename
      const origName = (downloadItem.filename || 'GSC_Export.xlsx').replace(/^.*[\\\/]/, '');
      const extMatch = origName.match(/(\.[a-zA-Z0-9]{2,5})$/);
      const ext = extMatch ? extMatch[1] : (meta?.format === 'csv' ? '.zip' : '.xlsx');

      let finalFileName = origName;

      if (meta) {
        const reportSlug = sanitizeSegment(meta.reportName || 'Report', 25);
        const sectionSlug = sanitizeSegment(meta.section || '', 25);
        const itemSlug = sanitizeSegment(meta.label || 'Export', 45);
        const idxPrefix = meta.index ? `${String(meta.index).padStart(2, '0')}_` : '';

        const nameParts = [reportSlug];
        if (sectionSlug && sectionSlug.toLowerCase() !== reportSlug.toLowerCase() && sectionSlug.toLowerCase() !== itemSlug.toLowerCase()) {
          nameParts.push(sectionSlug);
        }
        if (itemSlug && itemSlug.toLowerCase() !== reportSlug.toLowerCase()) {
          nameParts.push(itemSlug);
        }

        finalFileName = `${idxPrefix}${nameParts.join('__')}${ext}`;
      } else {
        const cleanBase = origName.replace(/\.[a-zA-Z0-9]+$/, '');
        finalFileName = `${sanitizeSegment(cleanBase, 50)}${ext}`;
      }

      // Ensure every single file is placed inside the target date folder
      const fullPath = `${targetFolder}/${finalFileName}`;

      suggest({
        filename: fullPath,
        conflictAction: 'uniquify'
      });
    } catch (err) {
      console.warn('GSC Downloader: Error determining filename:', err);
      const dateStr = getLocalDateString();
      const fallbackName = (downloadItem.filename || 'GSC_Export.xlsx').replace(/^.*[\\\/]/, '');
      suggest({
        filename: `GSC-Exports-${dateStr}/${fallbackName}`,
        conflictAction: 'uniquify'
      });
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ENSURE_INJECTED' && request.tabId) {
    ensureContentScriptInjected(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'PREPARE_DOWNLOAD') {
    const metaItem = {
      ...request.meta,
      timestamp: Date.now()
    };
    pendingDownloadQueue.push(metaItem);
    lastDownloadMeta = metaItem;
    lastDownloadTime = Date.now();
    sendResponse({ success: true, queueLength: pendingDownloadQueue.length });
    return true;
  }

  if (request.action === 'WAIT_FOR_DOWNLOAD') {
    const timeoutMs = request.timeoutMs || 6500;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        downloadWaiters = downloadWaiters.filter((w) => w !== onDownload);
        sendResponse({ started: false, timedOut: true });
      }
    }, timeoutMs);

    function onDownload(result) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        sendResponse(result);
      }
    }

    downloadWaiters.push(onDownload);
    return true;
  }
});
