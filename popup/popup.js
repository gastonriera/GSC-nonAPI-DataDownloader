/**
 * GSC non-API Data Downloader - Popup Controller (v2.0.0)
 * Controls native report & drilldown export selection and format preferences.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const propertyValue = document.getElementById('propertyValue');
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

  const jumpIndexing = document.getElementById('jumpIndexing');
  const jumpCrawlStats = document.getElementById('jumpCrawlStats');
  const jumpCwv = document.getElementById('jumpCwv');
  const toggleFloatingBtn = document.getElementById('toggleFloatingBtn');
  const appVersion = document.getElementById('appVersion');

  let activeTab = null;
  let activeResourceId = '';
  let selectedFormat = 'excel';
  let discoveredTasks = [];

  if (appVersion && chrome.runtime?.getManifest) {
    appVersion.textContent = 'v' + chrome.runtime.getManifest().version;
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
  chrome.storage.local.get({ showFloatingButton: true, exportFormat: 'excel' }, (res) => {
    toggleFloatingBtn.checked = res.showFloatingButton;
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

  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!activeTab || !activeTab.url || !isGscUrl(activeTab.url)) {
    setNonGscState();
    return;
  }

  try {
    const urlObj = new URL(activeTab.url);
    activeResourceId = urlObj.searchParams.get('resource_id') || '';
  } catch (e) {}

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

    if (reportInfo.property) {
      activeResourceId = reportInfo.property;
    }

    propertyValue.textContent = reportInfo.property || 'Active Property';
    propertyValue.title = reportInfo.property || '';
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
          <span class="task-count">${escapeHtml(task.count || '')}</span>
        `;
        const cb = labelEl.querySelector('.task-checkbox');
        cb.addEventListener('change', updateSelectedCountBadge);
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
    propertyValue.textContent = activeResourceId || 'Active Property';
    reportViewValue.textContent = 'Google Search Console';
    tasksBadge.textContent = 'Ready';
    tasksChecklistContainer.innerHTML = `
      <div class="empty-state">Please refresh your Google Search Console tab (F5) so the updated v2.0.0 exporter can attach to the page.</div>
    `;
  }

  function setNonGscState() {
    statusPill.className = 'status-pill status-inactive';
    statusText.textContent = 'Not on GSC';
    propertyValue.textContent = 'None';
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
    const selectedTaskIds = checkboxes
      .filter((cb) => cb.checked)
      .map((cb) => cb.getAttribute('data-task-id'));

    chrome.tabs.sendMessage(activeTab.id, {
      action: 'START_BATCH_EXPORT',
      format: selectedFormat,
      selectedTaskIds: selectedTaskIds.length > 0 ? selectedTaskIds : null,
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

  // Quick Switch Navigation
  function navigateToReport(target) {
    const userMatch = activeTab?.url?.match(/search\.google\.com(\/u\/\d+|\/b\/\d+)?\/search-console/);
    const basePath = userMatch && userMatch[1] ? `${userMatch[1]}/search-console` : '/search-console';
    const resParam = activeResourceId ? `?resource_id=${encodeURIComponent(activeResourceId)}` : '';

    if (activeTab && activeTab.url && isGscUrl(activeTab.url)) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'NAVIGATE_TO', target }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          let subPath = '';
          if (target === 'page-indexing') subPath = '/index';
          if (target === 'crawl-stats') subPath = '/settings/crawl-stats';
          if (target === 'core-web-vitals') subPath = '/core-web-vitals';
          chrome.tabs.update(activeTab.id, { url: `https://search.google.com${basePath}${subPath}${resParam}` });
        }
        window.close();
      });
    } else {
      let subPath = '';
      if (target === 'page-indexing') subPath = '/index';
      if (target === 'crawl-stats') subPath = '/settings/crawl-stats';
      if (target === 'core-web-vitals') subPath = '/core-web-vitals';
      chrome.tabs.create({ url: `https://search.google.com${basePath}${subPath}${resParam}` });
      window.close();
    }
  }

  jumpIndexing.addEventListener('click', () => navigateToReport('page-indexing'));
  jumpCrawlStats.addEventListener('click', () => navigateToReport('crawl-stats'));
  jumpCwv.addEventListener('click', () => navigateToReport('core-web-vitals'));

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
