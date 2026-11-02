/**
 * GSC non-API Data Downloader - Popup Controller
 * Connects UI actions to content script data extraction engine.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const propertyValue = document.getElementById('propertyValue');
  const reportViewValue = document.getElementById('reportViewValue');
  const tablesBadge = document.getElementById('tablesBadge');
  const metricsChipContainer = document.getElementById('metricsChipContainer');
  const tablesPreviewContainer = document.getElementById('tablesPreviewContainer');

  const btnExportZip = document.getElementById('btnExportZip');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnExportJson = document.getElementById('btnExportJson');
  const btnNativeExport = document.getElementById('btnNativeExport');
  const nativeExportStatus = document.getElementById('nativeExportStatus');

  const jumpIndexing = document.getElementById('jumpIndexing');
  const jumpCrawlStats = document.getElementById('jumpCrawlStats');
  const jumpCwv = document.getElementById('jumpCwv');
  const toggleFloatingBtn = document.getElementById('toggleFloatingBtn');

  const progressOverlay = document.getElementById('progressOverlay');
  const progressMessage = document.getElementById('progressMessage');

  let activeTab = null;
  let activeResourceId = '';

  // Show progress modal
  function showProgress(msg) {
    progressMessage.textContent = msg;
    progressOverlay.classList.remove('hidden');
  }

  function hideProgress() {
    progressOverlay.classList.add('hidden');
  }

  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!activeTab || !activeTab.url || !activeTab.url.includes('search.google.com/search-console')) {
    setNonGscState();
    return;
  }

  // Parse resource_id from active tab URL
  try {
    const urlObj = new URL(activeTab.url);
    activeResourceId = urlObj.searchParams.get('resource_id') || '';
  } catch (e) {
    console.warn('Could not parse tab URL', e);
  }

  // Ensure content script is injected in tab
  try {
    await chrome.runtime.sendMessage({ action: 'ENSURE_INJECTED', tabId: activeTab.id });
  } catch (e) {
    console.log('Injection check passed or handled');
  }

  // Query tab for status
  fetchTabStatus();

  // Load user settings
  chrome.storage.local.get({ showFloatingButton: true }, (res) => {
    toggleFloatingBtn.checked = res.showFloatingButton;
  });

  toggleFloatingBtn.addEventListener('change', () => {
    const isChecked = toggleFloatingBtn.checked;
    chrome.storage.local.set({ showFloatingButton: isChecked });
    chrome.tabs.sendMessage(activeTab.id, { action: 'TOGGLE_FLOATING_BTN', show: isChecked });
  });

  // --- TAB STATUS QUERY ---

  function fetchTabStatus() {
    chrome.tabs.sendMessage(activeTab.id, { action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Tab might still be initializing
        setTimeout(retryStatusQuery, 800);
        return;
      }
      renderReportState(response);
    });
  }

  function retryStatusQuery() {
    chrome.tabs.sendMessage(activeTab.id, { action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        renderFallbackState();
        return;
      }
      renderReportState(response);
    });
  }

  function renderReportState(data) {
    const { reportInfo, metrics, tablesCount, tablesPreview, nativeExportAvailable } = data;

    if (reportInfo.property) {
      activeResourceId = reportInfo.property;
    }

    // Property display
    propertyValue.textContent = reportInfo.property || 'Default Property';
    propertyValue.title = reportInfo.property || '';

    // Report View display
    reportViewValue.textContent = `${reportInfo.reportName} (${reportInfo.subView || 'Overview'})`;

    // Status Pill
    statusPill.className = 'status-pill status-active';
    statusText.textContent = reportInfo.reportName;

    // Tables badge
    tablesBadge.textContent = `${tablesCount} ${tablesCount === 1 ? 'table' : 'tables'}`;

    // Render Metrics Chips
    metricsChipContainer.innerHTML = '';
    if (metrics && metrics.length > 0) {
      metrics.slice(0, 4).forEach(m => {
        const chip = document.createElement('div');
        chip.className = 'metric-chip';
        chip.innerHTML = `<span class="chip-label">${escapeHtml(m.label)}:</span> <span class="chip-val">${escapeHtml(m.value)}</span>`;
        metricsChipContainer.appendChild(chip);
      });
    }

    // Render Table Preview List
    tablesPreviewContainer.innerHTML = '';
    if (tablesPreview && tablesPreview.length > 0) {
      tablesPreview.forEach((table, i) => {
        const item = document.createElement('div');
        item.className = 'table-row-item';
        item.innerHTML = `
          <span class="table-name" title="${escapeHtml(table.title)}">${i + 1}. ${escapeHtml(table.title)}</span>
          <span class="table-count">${table.rows} rows</span>
        `;
        tablesPreviewContainer.appendChild(item);
      });
    } else {
      tablesPreviewContainer.innerHTML = `
        <div class="empty-state">No tables visible on screen yet. Scroll down or wait for data to load.</div>
      `;
    }

    // Native export availability
    if (nativeExportAvailable) {
      nativeExportStatus.textContent = 'Available';
      nativeExportStatus.className = 'tag-available';
      btnNativeExport.disabled = false;
    } else {
      nativeExportStatus.textContent = 'Not in View';
      nativeExportStatus.className = 'tag-unavailable';
      btnNativeExport.disabled = false;
    }

    // Enable action buttons
    btnExportZip.disabled = false;
    btnExportCsv.disabled = false;
    btnExportJson.disabled = false;
  }

  function renderFallbackState() {
    statusPill.className = 'status-pill status-warning';
    statusText.textContent = 'GSC Detected';
    propertyValue.textContent = activeResourceId || 'Active Property';
    reportViewValue.textContent = 'Google Search Console';
    tablesBadge.textContent = '0 tables';
    tablesPreviewContainer.innerHTML = `
      <div class="empty-state">Ready to export. Click below to scan and download available report data.</div>
    `;
    btnExportZip.disabled = false;
    btnExportCsv.disabled = false;
    btnExportJson.disabled = false;
  }

  function setNonGscState() {
    statusPill.className = 'status-pill status-inactive';
    statusText.textContent = 'Not on GSC';
    propertyValue.textContent = 'None';
    reportViewValue.textContent = 'Please open Google Search Console';
    tablesBadge.textContent = '0 tables';

    tablesPreviewContainer.innerHTML = `
      <div class="empty-state">Navigate to Google Search Console (Page Indexing, Crawl Stats, or Core Web Vitals) to export data.</div>
    `;

    btnExportZip.disabled = true;
    btnExportCsv.disabled = true;
    btnExportJson.disabled = true;
    btnNativeExport.disabled = true;
    nativeExportStatus.textContent = 'Disabled';
    nativeExportStatus.className = 'tag-unavailable';
  }

  // --- EXPORT BUTTON HANDLERS ---

  btnExportZip.addEventListener('click', async () => {
    showProgress('Scanning tables & generating ZIP bundle...');
    chrome.tabs.sendMessage(activeTab.id, { action: 'TRIGGER_EXPORT', format: 'zip' }, (res) => {
      hideProgress();
      if (res && res.success) {
        window.close();
      } else {
        alert(res?.error || 'Export completed or downloaded.');
      }
    });
  });

  btnExportCsv.addEventListener('click', async () => {
    showProgress('Extracting and downloading CSV tables...');
    chrome.tabs.sendMessage(activeTab.id, { action: 'TRIGGER_EXPORT', format: 'csv' }, (res) => {
      hideProgress();
      if (res && res.success) {
        window.close();
      }
    });
  });

  btnExportJson.addEventListener('click', async () => {
    showProgress('Exporting complete structured JSON...');
    chrome.tabs.sendMessage(activeTab.id, { action: 'TRIGGER_EXPORT', format: 'json' }, (res) => {
      hideProgress();
      if (res && res.success) {
        window.close();
      }
    });
  });

  btnNativeExport.addEventListener('click', async () => {
    showProgress('Triggering Google Search Console native export...');
    chrome.tabs.sendMessage(activeTab.id, { action: 'TRIGGER_NATIVE_EXPORT', format: 'csv' }, (res) => {
      hideProgress();
      if (res && res.success) {
        window.close();
      } else {
        alert(res?.error || 'Native export menu opened.');
      }
    });
  });

  // --- QUICK SWITCH / JUMP HANDLERS ---

  function navigateToReport(target) {
    if (activeTab && activeTab.url && activeTab.url.includes('search.google.com/search-console')) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'NAVIGATE_TO', target }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          // Direct fallback navigation
          const resParam = activeResourceId ? `?resource_id=${encodeURIComponent(activeResourceId)}` : '';
          let path = '/search-console';
          if (target === 'page-indexing') path += '/index';
          if (target === 'crawl-stats') path += '/settings/crawl-stats';
          if (target === 'core-web-vitals') path += '/core-web-vitals';
          chrome.tabs.update(activeTab.id, { url: `https://search.google.com${path}${resParam}` });
        }
        window.close();
      });
    } else {
      // Open in new tab or current tab
      const resParam = activeResourceId ? `?resource_id=${encodeURIComponent(activeResourceId)}` : '';
      let path = '/search-console';
      if (target === 'page-indexing') path += '/index';
      if (target === 'crawl-stats') path += '/settings/crawl-stats';
      if (target === 'core-web-vitals') path += '/core-web-vitals';
      chrome.tabs.create({ url: `https://search.google.com${path}${resParam}` });
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
