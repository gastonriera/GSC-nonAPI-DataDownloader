/**
 * GSC non-API Data Downloader - Background Service Worker (v3.1.4)
 * Coordinates script injection, configures automatic downloads, detects native GSC downloads,
 * and renames/organizes exported Excel (.xlsx) and CSV (.zip) files cleanly without save dialogs.
 */

let pendingDownloadMeta = null;
let downloadWaiters = [];

/**
 * Automatically grants multi-file download permissions to Google Search Console
 * so Chrome never pauses batch exports or prompts "Allow multiple downloads?".
 */
function configureSiteDownloadPermissions() {
  if (chrome.contentSettings && chrome.contentSettings.automaticDownloads) {
    try {
      chrome.contentSettings.automaticDownloads.set({
        primaryPattern: 'https://search.google.com/*',
        setting: 'allow'
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Could not set automaticDownloads content setting:', chrome.runtime.lastError);
        } else {
          console.log('Automatic downloads explicitly allowed for https://search.google.com/*');
        }
      });
    } catch (e) {
      console.warn('Error setting automaticDownloads:', e);
    }
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
      organizeSubfolder: res.organizeSubfolder !== undefined ? res.organizeSubfolder : true
    });
  });

  console.log('GSC non-API Data Downloader installed/updated (v3.1.4):', details.reason);
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

// Listen for download creation so the content script knows immediately when GSC starts a file download
if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    if (downloadWaiters.length > 0) {
      const waiters = [...downloadWaiters];
      downloadWaiters = [];
      waiters.forEach((resolve) => resolve({ started: true, downloadId: downloadItem.id }));
    }
  });
}

// Rename and organize GSC exported files into clean paths without triggering save prompts
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const isFromGsc = Boolean(
      (downloadItem.url && downloadItem.url.includes('search.google.com')) ||
      (downloadItem.referrer && downloadItem.referrer.includes('search.google.com')) ||
      (downloadItem.finalUrl && downloadItem.finalUrl.includes('search.google.com'))
    );

    const now = Date.now();
    // Only rename if triggered by our extension within the last 20 seconds
    if (pendingDownloadMeta && (now - pendingDownloadMeta.timestamp < 20000)) {
      const meta = pendingDownloadMeta;
      pendingDownloadMeta = null;

      // Determine file extension from original filename (e.g. .xlsx, .zip, .csv)
      const origName = downloadItem.filename || '';
      const extMatch = origName.match(/(\.[a-zA-Z0-9]{2,5})$/);
      const ext = extMatch ? extMatch[1] : (meta.format === 'csv' ? '.zip' : '.xlsx');

      const dateStr = new Date().toISOString().slice(0, 10);
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

      const finalFileName = `${idxPrefix}${nameParts.join('__')}${ext}`;
      const useSubfolder = meta.organizeSubfolder !== false;
      const fullPath = useSubfolder
        ? `GSC-Exports/${dateStr}/${finalFileName}`
        : `GSC_${dateStr}_${finalFileName}`;

      // Setting conflictAction to 'uniquify' prevents Chrome from opening a Save As collision dialog
      suggest({
        filename: fullPath,
        conflictAction: 'uniquify'
      });
      return;
    }

    // For any native GSC download without metadata, ensure uniquify to prevent overwrite prompts
    if (isFromGsc) {
      const cleanOrigName = (downloadItem.filename || 'GSC_Export.xlsx').replace(/^.*[\\\/]/, '');
      suggest({
        filename: cleanOrigName,
        conflictAction: 'uniquify'
      });
      return;
    }

    suggest();
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
    chrome.storage.local.get({ organizeSubfolder: true }, (stored) => {
      pendingDownloadMeta = {
        ...request.meta,
        organizeSubfolder: request.meta?.organizeSubfolder !== undefined
          ? request.meta.organizeSubfolder
          : stored.organizeSubfolder,
        timestamp: Date.now()
      };
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'WAIT_FOR_DOWNLOAD') {
    const timeoutMs = request.timeoutMs || 4500;
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
