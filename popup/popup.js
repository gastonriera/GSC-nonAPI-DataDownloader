/**
 * GSC non-API Data Downloader - Popup Controller (v3.1.2)
 * Controls native report & drilldown export selection, format preferences,
 * and macOS silent download configuration.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const reportViewValue = document.getElementById('reportViewValue');
  const fmtExcel = document.getElementById('fmtExcel');
  const fmtCsv = document.getElementById('fmtCsv');

  const btnToggleAll = document.getElementById('btnToggleAll');
  const tasksBadge = document.getElementById('tasksBadge');
  const tasksChecklistContainer = document.getElementById('tasksChecklistContainer');

  const btnExportBatch = document.getElementById('btnExportBatch');
  const btnExportBatchTitle = document.getElementById('btnExportBatchTitle');
  const btnExportCurrentOnly = document.getElementById('btnExportCurrentOnly');
  const btnCurrentOnlyText = document.getElementById('btnCurrentOnlyText');

  const macOsHelpCard = document.getElementById('macOsHelpCard');
  const btnDismissMacHelp = document.getElementById('btnDismissMacHelp');
  const btnCopySettingsUrl = document.getElementById('btnCopySettingsUrl');
  const copySettingsText = document.getElementById('copySettingsText');

  const jumpIndexing = document.getElementById('jumpIndexing');
  const jumpCrawlStats = document.getElementById('jumpCrawlStats');
  const jumpCwv = document.getElementById('jumpCwv');
  const jumpCwvGoodUrls = document.getElementById('jumpCwvGoodUrls');
  const toggleFloatingBtn = document.getElementById('toggleFloatingBtn');
  const toggleSubfolder = document.getElementById('toggleSubfolder');
  const appVersion = document.getElementById('appVersion');

  let activeTab = null;
  let selectedFormat = 'excel';
  let discoveredTasks = [];

  if (appVersion && chrome.runtime?.getManifest) {
    appVersion.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  // Detect macOS to surface silent download guidance
  const isMac = Boolean(
    (navigator.userAgentData && navigator.userAgentData.platform === 'macOS') ||
    /Macintosh|MacIntel|MacPPC|Mac68K/i.test(navigator.userAgent || navigator.platform || '')
  );

  if (isMac && macOsHelpCard) {
    chrome.storage.local.get({ hideMacHelp: false }, (res) => {
      if (!res.hideMacHelp) {
        macOsHelpCard.style.display = 'flex';
      }
    });
  }

  if (btnDismissMacHelp) {
    btnDismissMacHelp.addEventListener('click', () => {
      if (macOsHelpCard) macOsHelpCard.style.display = 'none';
      chrome.storage.local.set({ hideMacHelp: true });
    });
  }

  if (btnCopySettingsUrl) {
    btnCopySettingsUrl.addEventListener('click', async () => {
      const urlToCopy = 'chrome://settings/downloads';
      try {
        await navigator.clipboard.writeText(urlToCopy);
        if (copySettingsText) {
          const originalText = copySettingsText.textContent;
          copySettingsText.textContent = '✓ Copied! Paste in new tab';
          setTimeout(() => {
            copySettingsText.textContent = originalText;
          }, 2500);
        }
      } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = urlToCopy;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        if (copySettingsText) {
          copySettingsText.textContent = '✓ Copied!';
          setTimeout(() => {
            copySettingsText.textContent = 'Copy chrome://settings/downloads';
          }, 2500);
        }
      }
    });
  }

  function isGscUrl(url) {
    return Boolean(url && url.includes('search.google.com') && url.includes('search-console'));
  }

  function setFormatUI(format) {
    selectedFormat = format === 'csv' ? 'csv' : 'excel';
    fmtExcel.classList.toggle('active', selectedFormat === 'excel');
    fmtCsv.classList.toggle('active', selectedFormat === 'csv');

    const labelSuffix = selectedFormat === 'csv' ? 'CSV' : 'Excel';
    btnExportBatchTitle.textContent = `1-Click Export All Report Files (${labelSuffix})`;
    btnCurrentOnlyText.textContent = `Export Current View Only (${labelSuffix})`;
  }

  // Load saved preferences
  chrome.storage.local.get({ showFloatingButton: true, exportFormat: 'excel', organizeSubfolder: true }, (res) => {
    toggleFloatingBtn.checked = res.showFloatingButton;
    if (toggleSubfolder) toggleSubfolder.checked = res.organizeSubfolder !== false;
    setFormatUI(res.exportFormat);
  });

  fmtExcel.addEventListener('click', () => {
    setFormatUI('excel');
    chrome.storage.local.set({ exportFormat: 'excel' });
  });

  fmtCsv.addEventListener('click', () => {
    setFormatUI('csv');
    chrome.storage.local.set({ exportFormat: 'csv' });
  });

  if (toggleSubfolder) {
    toggleSubfolder.addEventListener('change', () => {
      chrome.storage.local.set({ organizeSubfolder: toggleSubfolder.checked });
    });
  }

  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!activeTab || !activeTab.url || !isGscUrl(activeTab.url)) {
    setNonGscState();
    return;
  }

  try {
    await chrome.runtime.sendMessage({ action: 'ENSURE_INJECTED', tabId: activeTab.id });
  } catch (e) {}

  fetchTabStatus();

  toggleFloatingBtn.addEventListener('change', () => {
    const isChecked = toggleFloatingBtn.checked;
    chrome.storage.local.set({ showFloatingButton: isChecked });
    chrome.tabs.sendMessage(activeTab.id, { action: 'TOGGLE_FLOATING_BTN', show: isChecked });
  });

  function fetchTabStatus() {
    chrome.tabs.sendMessage(activeTab.id, { action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setTimeout(() => {
          chrome.tabs.sendMessage(activeTab.id, { action: 'GET_STATUS' }, (retryRes) => {
            if (chrome.runtime.lastError || !retryRes) {
              renderFallbackState();
            } else {
              renderReportState(retryRes);
            }
          });
        }, 600);
        return;
      }
      renderReportState(response);
    });
  }

  function updateSelectedCountBadge() {
    const checkboxes = Array.from(tasksChecklistContainer.querySelectorAll('.task-checkbox'));
    const checkedCount = checkboxes.filter((cb) => cb.checked).length;
    tasksBadge.textContent = `${checkedCount} of ${checkboxes.length} selected`;
    btnExportBatch.disabled = checkedCount === 0;
  }

  function renderReportState(data) {
    const { reportInfo, tasks, nativeExportAvailable } = data;
    discoveredTasks = tasks || [];

    reportViewValue.textContent = `${reportInfo.reportName} (${reportInfo.subView || 'Overview'})`;

    statusPill.className = 'status-pill status-active';
    statusText.textContent = reportInfo.reportName;

    tasksChecklistContainer.innerHTML = '';

    if (discoveredTasks.length > 0) {
      discoveredTasks.forEach((task) => {
        const labelEl = document.createElement('label');
        labelEl.className = 'task-item';
        labelEl.innerHTML = `
          <div class="task-left">
            <input type="checkbox" class="task-checkbox" data-task-id="${escapeHtml(task.id)}" checked>
            <div class="task-texts">
              <span class="task-label" title="${escapeHtml(task.label)}">${escapeHtml(task.label)}</span>
              <span class="task-section">${escapeHtml(task.section)}</span>
            </div>
          </div>
          <div class="task-right">
            ${task.targetUrl ? `<button type="button" class="btn-load-page" data-url="${escapeHtml(task.targetUrl)}" title="Load this report in tab">Load ↗</button>` : ''}
            <span class="task-count">${escapeHtml(task.count || '')}</span>
          </div>
        `;
        const cb = labelEl.querySelector('.task-checkbox');
        cb.addEventListener('change', updateSelectedCountBadge);

        // Click on "Load ↗" button directly loads that report URL into the active tab
        const loadBtn = labelEl.querySelector('.btn-load-page');
        if (loadBtn) {
          loadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const url = loadBtn.getAttribute('data-url');
            if (url && activeTab) {
              chrome.tabs.update(activeTab.id, { url });
              window.close();
            }
          });
        }

        // Clicking the task label on tasks that have a targetUrl also navigates to that report
        const taskTexts = labelEl.querySelector('.task-texts');
        if (taskTexts && task.targetUrl) {
          taskTexts.style.cursor = 'pointer';
          taskTexts.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (activeTab && task.targetUrl) {
              chrome.tabs.update(activeTab.id, { url: task.targetUrl });
              window.close();
            }
          });
        }

        tasksChecklistContainer.appendChild(labelEl);
      });
      updateSelectedCountBadge();
    } else {
      tasksBadge.textContent = '0 files';
      tasksChecklistContainer.innerHTML = `
        <div class="empty-state">
          No exportable breakdown tables or Export buttons detected on this view yet. Wait for the report to finish loading or switch to Page Indexing, Crawl Stats, or Core Web Vitals.
        </div>
      `;
      btnExportBatch.disabled = !nativeExportAvailable;
    }

    btnExportCurrentOnly.disabled = !nativeExportAvailable;
  }

  function renderFallbackState() {
    statusPill.className = 'status-pill status-warning';
    statusText.textContent = 'GSC Detected';
    reportViewValue.textContent = 'Google Search Console';
    tasksBadge.textContent = 'Ready';
    tasksChecklistContainer.innerHTML = `
      <div class="empty-state">Please refresh your Google Search Console tab (F5) so the updated exporter can attach to the page.</div>
    `;
  }

  function setNonGscState() {
    statusPill.className = 'status-pill status-inactive';
    statusText.textContent = 'Not on GSC';
    reportViewValue.textContent = 'Open Google Search Console';
    tasksBadge.textContent = '0 files';

    tasksChecklistContainer.innerHTML = `
      <div class="empty-state">Navigate to Google Search Console (Page Indexing, Crawl Stats, or Core Web Vitals) to export report files.</div>
    `;

    btnExportBatch.disabled = true;
    btnExportCurrentOnly.disabled = true;
  }

  // Toggle All / None
  btnToggleAll.addEventListener('click', () => {
    const checkboxes = Array.from(tasksChecklistContainer.querySelectorAll('.task-checkbox'));
    if (checkboxes.length === 0) return;
    const allChecked = checkboxes.every((cb) => cb.checked);
    checkboxes.forEach((cb) => {
      cb.checked = !allChecked;
    });
    updateSelectedCountBadge();
  });

  // Trigger Batch Export (Main + Checked Drilldowns)
  btnExportBatch.addEventListener('click', () => {
    const checkboxes = Array.from(tasksChecklistContainer.querySelectorAll('.task-checkbox'));
    const allChecked = checkboxes.length > 0 && checkboxes.every((cb) => cb.checked);
    const selectedTaskIds = allChecked
      ? null
      : checkboxes.filter((cb) => cb.checked).map((cb) => cb.getAttribute('data-task-id'));

    chrome.tabs.sendMessage(activeTab.id, {
      action: 'START_BATCH_EXPORT',
      format: selectedFormat,
      selectedTaskIds: selectedTaskIds && selectedTaskIds.length > 0 ? selectedTaskIds : null,
      currentViewOnly: false
    });

    // Close popup so user can watch the live progress widget on the GSC page
    window.close();
  });

  // Trigger Single Export on Current View Only
  btnExportCurrentOnly.addEventListener('click', () => {
    chrome.tabs.sendMessage(activeTab.id, {
      action: 'START_BATCH_EXPORT',
      format: selectedFormat,
      currentViewOnly: true
    });
    window.close();
  });

  // Quick Switch Navigation (Property-Agnostic: preserves current query string)
  function navigateToReport(target) {
    const userMatch = activeTab?.url?.match(/search\.google\.com(\/u\/\d+|\/b\/\d+)?\/search-console/);
    const basePath = userMatch && userMatch[1] ? `${userMatch[1]}/search-console` : '/search-console';
    let searchQuery = '';
    let resourceId = '';
    try {
      if (activeTab?.url) {
        const u = new URL(activeTab.url);
        searchQuery = u.search || '';
        resourceId = u.searchParams.get('resource_id') || '';
      }
    } catch (e) {}

    function buildTargetUrl(tgt) {
      if (tgt === 'page-indexing') return `https://search.google.com${basePath}/index${searchQuery}`;
      if (tgt === 'crawl-stats') return `https://search.google.com${basePath}/settings/crawl-stats${searchQuery}`;
      if (tgt === 'core-web-vitals') return `https://search.google.com${basePath}/core-web-vitals${searchQuery}`;
      if (tgt === 'cwv-good-urls-mobile' || tgt === 'cwv-good-urls') {
        const resParam = resourceId ? `?resource_id=${encodeURIComponent(resourceId)}&device=2` : searchQuery;
        return `https://search.google.com${basePath}/core-web-vitals/drilldown${resParam}`;
      }
      if (tgt === 'cwv-good-urls-desktop') {
        const resParam = resourceId ? `?resource_id=${encodeURIComponent(resourceId)}&device=1` : searchQuery;
        return `https://search.google.com${basePath}/core-web-vitals/drilldown${resParam}`;
      }
      return `https://search.google.com${basePath}/core-web-vitals${searchQuery}`;
    }

    if (activeTab && activeTab.url && isGscUrl(activeTab.url)) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'NAVIGATE_TO', target }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          chrome.tabs.update(activeTab.id, { url: buildTargetUrl(target) });
        }
        window.close();
      });
    } else {
      chrome.tabs.create({ url: buildTargetUrl(target) });
      window.close();
    }
  }

  jumpIndexing.addEventListener('click', () => navigateToReport('page-indexing'));
  jumpCrawlStats.addEventListener('click', () => navigateToReport('crawl-stats'));
  jumpCwv.addEventListener('click', () => navigateToReport('core-web-vitals'));
  if (jumpCwvGoodUrls) {
    jumpCwvGoodUrls.addEventListener('click', () => navigateToReport('cwv-good-urls-mobile'));
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
