/**
 * GSC non-API Data Downloader - Content Script
 * Extracts data from Google Search Console reports:
 * 1. Page Indexing (Overview & Drilldowns)
 * 2. Crawl Stats (Summary, Host Status, & 4 Breakdowns)
 * 3. Core Web Vitals (Mobile, Desktop, & Drilldowns)
 * Supports 1-Click ZIP bundling, individual CSVs, raw JSON, and triggering Google's native CSV export.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__GSC_DOWNLOADER_INITIALIZED__) return;
  window.__GSC_DOWNLOADER_INITIALIZED__ = true;

  // --- REPORT DETECTION ---

  function detectReportInfo() {
    const url = window.location.href;
    const urlObj = new URL(url);

    // Extract property (resource_id)
    let property = urlObj.searchParams.get('resource_id') || '';
    if (!property) {
      // Try finding property in page DOM (dropdown or title)
      const propEl = document.querySelector('[data-property-name], [aria-label*="Select property"], .property-selector-text');
      if (propEl) {
        property = propEl.textContent.trim();
      }
    }

    let reportType = 'unknown';
    let reportName = 'Google Search Console';
    let isDrilldown = false;
    let subView = '';

    if (url.includes('/settings/crawl-stats')) {
      reportType = 'crawl-stats';
      reportName = 'Crawl Stats';
      if (url.includes('response_code=') || url.includes('file_type=') || url.includes('purpose=') || url.includes('bot_type=')) {
        isDrilldown = true;
        subView = 'Breakdown Drilldown';
      } else {
        subView = 'Overview';
      }
    } else if (url.includes('/index') || url.includes('/indexation') || url.includes('/pages')) {
      reportType = 'page-indexing';
      reportName = 'Page Indexing';
      if (url.includes('/drilldown') || url.includes('item_key=')) {
        isDrilldown = true;
        subView = 'Reason Drilldown';
      } else {
        subView = 'Overview';
      }
    } else if (url.includes('/core-web-vitals')) {
      reportType = 'core-web-vitals';
      reportName = 'Core Web Vitals';
      if (url.includes('/drilldown') || url.includes('item_key=')) {
        isDrilldown = true;
        subView = 'Issue Drilldown';
      } else if (url.includes('device=2') || url.includes('/mobile')) {
        subView = 'Mobile Report';
      } else if (url.includes('device=1') || url.includes('/desktop')) {
        subView = 'Desktop Report';
      } else {
        subView = 'Overview';
      }
    } else if (url.includes('/performance')) {
      reportType = 'performance';
      reportName = 'Search Performance';
      subView = 'Overview';
    }

    // Try detecting heading text from DOM
    const headingEl = document.querySelector('h1, [role="heading"][aria-level="1"], .header-title');
    const pageTitle = headingEl ? headingEl.textContent.trim() : '';

    return {
      isGSC: url.includes('search.google.com') && url.includes('search-console'),
      reportType,
      reportName,
      subView,
      isDrilldown,
      property,
      pageTitle,
      url,
      timestamp: new Date().toISOString()
    };
  }

  // --- CLEAN TEXT UTILITY ---

  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/Learn more/gi, '')
      .replace(/arrow_drop_down/gi, '')
      .replace(/open_in_new/gi, '')
      .replace(/help_outline/gi, '')
      .replace(/info_outline/gi, '')
      .trim();
  }

  // --- DOM TABLE & GRID SCRAPING ENGINE ---

  function scrapeAllTables() {
    const detectedTables = [];
    const seenElements = new Set();

    // Strategy 1: Look for explicit HTML tables and ARIA tables/grids
    const tableContainers = Array.from(document.querySelectorAll(
      'table, [role="table"], [role="grid"], [role="treegrid"], div[role="rowgroup"]'
    ));

    // Also look for containers that hold repeated role="row"
    const rowHolders = Array.from(document.querySelectorAll('div, section')).filter(el => {
      const rows = el.querySelectorAll(':scope > [role="row"], :scope > div > [role="row"]');
      return rows.length >= 2;
    });

    const allContainers = [...new Set([...tableContainers, ...rowHolders])];

    allContainers.forEach((container, index) => {
      if (seenElements.has(container)) return;

      // Extract rows
      const rowElements = Array.from(container.querySelectorAll('[role="row"], tr'));
      if (rowElements.length === 0) return;

      // Mark container and child rows as seen
      seenElements.add(container);
      rowElements.forEach(r => seenElements.add(r));

      // Determine Table Title / Preceding Header
      let title = '';
      let prev = container.previousElementSibling;
      while (prev && !title) {
        if (/H[1-6]/.test(prev.tagName) || prev.matches('[role="heading"], .card-header, .title, .header')) {
          title = cleanText(prev.textContent);
        }
        prev = prev.previousElementSibling;
      }

      if (!title) {
        // Look up parent card or section
        const parentCard = container.closest('section, [role="region"], .card, .widget, .dashboard-card');
        if (parentCard) {
          const cardHeader = parentCard.querySelector('h1, h2, h3, h4, [role="heading"], .title, .card-title');
          if (cardHeader) {
            title = cleanText(cardHeader.textContent);
          }
        }
      }

      if (!title) {
        title = `Table_${detectedTables.length + 1}`;
      }

      // Extract Headers and Rows
      let headers = [];
      const rowsData = [];

      rowElements.forEach((row, rowIndex) => {
        const headerCells = Array.from(row.querySelectorAll('[role="columnheader"], th'));
        const dataCells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"], td'));

        if (headerCells.length > 0 && headers.length === 0) {
          headers = headerCells.map(c => cleanText(c.textContent)).filter(t => t.length > 0);
        } else if (dataCells.length > 0) {
          const rowValues = dataCells.map(c => cleanText(c.textContent));
          // If the row has meaningful values
          if (rowValues.some(val => val.length > 0)) {
            rowsData.push(rowValues);
          }
        } else if (headers.length === 0 && rowIndex === 0) {
          // If no formal headers, treat first row items as headers if they resemble labels
          const rawItems = Array.from(row.children).map(c => cleanText(c.textContent)).filter(t => t.length > 0);
          if (rawItems.length > 0) {
            headers = rawItems;
          }
        } else {
          // Fallback row items
          const rawItems = Array.from(row.children).map(c => cleanText(c.textContent));
          if (rawItems.some(v => v.length > 0)) {
            rowsData.push(rawItems);
          }
        }
      });

      // If headers count doesn't match row columns, synthesize generic headers
      if (rowsData.length > 0) {
        const maxCols = Math.max(...rowsData.map(r => r.length));
        if (headers.length < maxCols) {
          for (let i = headers.length; i < maxCols; i++) {
            headers.push(`Column_${i + 1}`);
          }
        }

        detectedTables.push({
          title,
          headers,
          rows: rowsData,
          rowCount: rowsData.length
        });
      }
    });

    return detectedTables;
  }

  // --- METRIC & SCORECARD SCRAPING ---

  function scrapeSummaryMetrics(reportInfo) {
    const metrics = [];

    // Crawl Stats Specific Cards
    if (reportInfo.reportType === 'crawl-stats') {
      const cards = Array.from(document.querySelectorAll('.card, [role="region"], div[class*="metric"], div[class*="summary"]'));
      cards.forEach(card => {
        const text = card.innerText || '';
        if (text.includes('Total crawl requests') || text.includes('Total download size') || text.includes('Average response time')) {
          const lines = text.split('\n').map(l => cleanText(l)).filter(l => l.length > 0);
          metrics.push({
            label: lines[0] || 'Metric',
            value: lines[1] || '',
            extra: lines.slice(2).join(' | ')
          });
        }
      });

      // Host Status checks
      const hostStatusItems = Array.from(document.querySelectorAll('div, tr, li')).filter(el => {
        const t = el.textContent || '';
        return t.includes('Robots.txt fetch') || t.includes('DNS resolution') || t.includes('Server connectivity');
      });
      hostStatusItems.slice(0, 3).forEach(el => {
        const text = cleanText(el.textContent);
        if (text && !metrics.some(m => m.label === text)) {
          metrics.push({ label: 'Host Check', value: text });
        }
      });
    }

    // Page Indexing Specific Cards
    if (reportInfo.reportType === 'page-indexing') {
      // Look for Indexed and Not Indexed scorecards
      const elements = Array.from(document.querySelectorAll('div, button, [role="tab"]')).filter(el => {
        const t = (el.textContent || '').trim();
        return (t.includes('Not indexed') || t.includes('Indexed')) && /\d/.test(t);
      });

      elements.forEach(el => {
        const clean = cleanText(el.textContent);
        if (clean.length < 50 && !metrics.some(m => m.label === clean)) {
          metrics.push({ label: 'Indexing Status', value: clean });
        }
      });
    }

    // Core Web Vitals Specific Cards
    if (reportInfo.reportType === 'core-web-vitals') {
      const elements = Array.from(document.querySelectorAll('div, section')).filter(el => {
        const t = el.textContent || '';
        return (t.includes('Poor URLs') || t.includes('Need improvement') || t.includes('Good URLs')) && /\d/.test(t);
      });

      elements.forEach(el => {
        const clean = cleanText(el.textContent);
        if (clean.length < 80 && !metrics.some(m => m.value === clean)) {
          metrics.push({ label: 'CWV Status', value: clean });
        }
      });
    }

    // Generic Metric Card Sweeper if none caught
    if (metrics.length === 0) {
      const genericCards = Array.from(document.querySelectorAll('[class*="scorecard"], [class*="summary-card"], [class*="stat-card"]'));
      genericCards.forEach(c => {
        const label = cleanText(c.querySelector('h2, h3, .label, .title')?.textContent || '');
        const val = cleanText(c.querySelector('.value, .count, .number')?.textContent || '');
        if (label || val) {
          metrics.push({ label: label || 'Metric', value: val || cleanText(c.textContent) });
        }
      });
    }

    return metrics;
  }

  // --- NATIVE EXPORT AUTOMATION ---

  function findNativeExportButton() {
    // Look for button with Export label or icon
    const candidates = Array.from(document.querySelectorAll(
      'button[aria-label*="Export" i], button[aria-label*="export" i], button[title*="Export" i], [role="button"][aria-label*="Export" i]'
    ));

    if (candidates.length > 0) return candidates[0];

    // Search by text content
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], span'));
    const textMatch = buttons.find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return text === 'export' || text === 'export table' || text === 'export data';
    });

    return textMatch ? (textMatch.closest('button, [role="button"]') || textMatch) : null;
  }

  async function triggerNativeExport(format = 'csv') {
    const exportBtn = findNativeExportButton();
    if (!exportBtn) {
      return { success: false, error: 'Native Export button not found on this page' };
    }

    // Click Export Button
    exportBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    exportBtn.click();
    showToast('Opening native export menu...', 'info');

    // Wait for dropdown menu to appear
    await new Promise(resolve => setTimeout(resolve, 600));

    // Find format menu items (Google Sheets, Microsoft Excel, Download CSV)
    const menuItems = Array.from(document.querySelectorAll(
      '[role="menuitem"], .mat-menu-item, button, div[role="button"]'
    ));

    const targetFormat = format.toLowerCase();
    let chosenItem = null;

    if (targetFormat === 'csv') {
      chosenItem = menuItems.find(el => /download csv|csv/i.test(el.textContent || ''));
    } else if (targetFormat === 'excel' || targetFormat === 'xlsx') {
      chosenItem = menuItems.find(el => /excel|microsoft excel/i.test(el.textContent || ''));
    } else if (targetFormat === 'sheets') {
      chosenItem = menuItems.find(el => /google sheets|sheets/i.test(el.textContent || ''));
    }

    if (!chosenItem) {
      // Fallback: pick any item containing "CSV"
      chosenItem = menuItems.find(el => /csv/i.test(el.textContent || ''));
    }

    if (chosenItem) {
      chosenItem.click();
      showToast('Native export triggered! Download will start shortly.', 'success');
      return { success: true, message: 'Native export triggered' };
    } else {
      showToast('Export menu opened. Please choose your format.', 'info');
      return { success: true, message: 'Export menu opened' };
    }
  }

  // --- CSV GENERATOR ---

  function convertTableToCSV(table, reportInfo) {
    const lines = [];

    // Optional metadata header
    lines.push(`# Google Search Console Export`);
    lines.push(`# Report: ${reportInfo.reportName} - ${table.title}`);
    lines.push(`# Property: ${reportInfo.property || 'N/A'}`);
    lines.push(`# Exported: ${new Date().toLocaleString()}`);
    lines.push(``);

    // Escape cell for CSV
    const escapeCell = (val) => {
      const str = String(val === undefined || val === null ? '' : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Header row
    if (table.headers && table.headers.length > 0) {
      lines.push(table.headers.map(escapeCell).join(','));
    }

    // Data rows
    if (table.rows && table.rows.length > 0) {
      table.rows.forEach(row => {
        lines.push(row.map(escapeCell).join(','));
      });
    }

    // UTF-8 BOM prefix (\uFEFF) for seamless Microsoft Excel rendering
    return '\uFEFF' + lines.join('\r\n');
  }

  function convertMetricsToCSV(metrics, reportInfo) {
    const lines = [];
    lines.push(`# Google Search Console - Key Summary Metrics`);
    lines.push(`# Report: ${reportInfo.reportName}`);
    lines.push(`# Property: ${reportInfo.property || 'N/A'}`);
    lines.push(`# Exported: ${new Date().toLocaleString()}`);
    lines.push(``);
    lines.push(`Metric,Value,Details`);

    const escapeCell = (val) => {
      const str = String(val === undefined || val === null ? '' : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    metrics.forEach(m => {
      lines.push([escapeCell(m.label), escapeCell(m.value), escapeCell(m.extra || '')].join(','));
    });

    return '\uFEFF' + lines.join('\r\n');
  }

  // --- DOWNLOAD HELPER ---

  function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_+/g, '_');
  }

  function generateFilenamePrefix(reportInfo) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const propSlug = (reportInfo.property || 'gsc')
      .replace(/https?:\/\//i, '')
      .replace(/sc-domain:/i, '')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .slice(0, 25);
    const reportSlug = reportInfo.reportType || 'report';
    return `GSC_${reportSlug}_${propSlug}_${dateStr}`;
  }

  // --- FULL REPORT BUNDLE EXPORT (ZIP / CSV / JSON) ---

  async function exportAllData(options = {}) {
    const format = options.format || 'zip'; // 'zip', 'csv', 'json'
    const reportInfo = detectReportInfo();
    const tables = scrapeAllTables();
    const metrics = scrapeSummaryMetrics(reportInfo);

    if (tables.length === 0 && metrics.length === 0) {
      showToast('No table or metric data found on this page.', 'error');
      return { success: false, error: 'No data detected' };
    }

    const filePrefix = generateFilenamePrefix(reportInfo);
    showToast(`Exporting ${tables.length} table(s)...`, 'info');

    // JSON Export
    if (format === 'json') {
      const jsonData = {
        metadata: reportInfo,
        summaryMetrics: metrics,
        tables: tables
      };
      const jsonBlob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
      triggerBrowserDownload(jsonBlob, `${filePrefix}_complete_data.json`);
      showToast('JSON export downloaded!', 'success');
      return { success: true, count: tables.length };
    }

    // Single / Multiple CSV Export
    if (format === 'csv') {
      if (metrics.length > 0) {
        const metricsCSV = convertMetricsToCSV(metrics, reportInfo);
        triggerBrowserDownload(new Blob([metricsCSV], { type: 'text/csv;charset=utf-8' }), `${filePrefix}_summary_metrics.csv`);
      }
      tables.forEach(table => {
        const csvContent = convertTableToCSV(table, reportInfo);
        const tableNameSlug = sanitizeFilename(table.title.toLowerCase());
        triggerBrowserDownload(new Blob([csvContent], { type: 'text/csv;charset=utf-8' }), `${filePrefix}_${tableNameSlug}.csv`);
      });
      showToast(`${tables.length} CSV file(s) downloaded!`, 'success');
      return { success: true, count: tables.length };
    }

    // ZIP Bundle Export (Default 1-Click Action)
    if (format === 'zip') {
      if (typeof window.ZipWriter === 'undefined') {
        showToast('ZipWriter library missing, falling back to CSV', 'error');
        return exportAllData({ format: 'csv' });
      }

      const zip = new window.ZipWriter();

      // 1. Add Summary README
      const readmeLines = [
        `======================================================`,
        `Google Search Console - Non-API Data Export Bundle`,
        `======================================================`,
        `Report:       ${reportInfo.reportName} (${reportInfo.subView || 'Overview'})`,
        `Property:     ${reportInfo.property || 'N/A'}`,
        `Date & Time:  ${new Date().toLocaleString()}`,
        `Page URL:     ${reportInfo.url}`,
        `Total Tables: ${tables.length}`,
        `Total Metrics:${metrics.length}`,
        `======================================================\n`,
        `Tables Included:`,
        ...tables.map((t, i) => `  ${i + 1}. ${t.title} (${t.rowCount} rows)`),
        `\nNote: All CSV files are UTF-8 encoded with BOM for full compatibility with Excel and Sheets.`
      ];
      zip.addFile('README_export_summary.txt', readmeLines.join('\n'));

      // 2. Add Summary Metrics CSV
      if (metrics.length > 0) {
        const metricsCSV = convertMetricsToCSV(metrics, reportInfo);
        zip.addFile('summary_metrics.csv', metricsCSV);
      }

      // 3. Add each table as individual CSV
      tables.forEach((table, index) => {
        const csvContent = convertTableToCSV(table, reportInfo);
        const nameSlug = sanitizeFilename(table.title.toLowerCase()) || `table_${index + 1}`;
        zip.addFile(`${String(index + 1).padStart(2, '0')}_${nameSlug}.csv`, csvContent);
      });

      // 4. Add Consolidated JSON
      const fullJson = {
        metadata: reportInfo,
        summaryMetrics: metrics,
        tables: tables
      };
      zip.addFile('all_report_data.json', JSON.stringify(fullJson, null, 2));

      // Generate and Download ZIP
      const zipBlob = zip.generateBlob();
      triggerBrowserDownload(zipBlob, `${filePrefix}.zip`);
      showToast(`ZIP bundle downloaded (${tables.length} tables + JSON)!`, 'success');

      return { success: true, count: tables.length, filename: `${filePrefix}.zip` };
    }

    return { success: false, error: 'Unknown format' };
  }

  // --- FLOATING IN-PAGE BUTTON ---

  function injectFloatingButton() {
    if (document.getElementById('gsc-downloader-floating-root')) return;

    const reportInfo = detectReportInfo();
    if (!reportInfo.isGSC) return;

    const container = document.createElement('div');
    container.id = 'gsc-downloader-floating-root';

    const btn = document.createElement('button');
    btn.className = 'gsc-downloader-floating-btn';
    btn.title = '1-Click Export GSC Report Data (.ZIP)';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>
      <span>1-Click Export Data</span>
    `;

    btn.addEventListener('click', () => {
      exportAllData({ format: 'zip' });
    });

    container.appendChild(btn);
    document.body.appendChild(container);

    // Check user preference for floating button visibility
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ showFloatingButton: true }, (res) => {
        if (!res.showFloatingButton) {
          container.style.display = 'none';
        }
      });
    }
  }

  // --- TOAST NOTIFICATIONS ---

  function showToast(message, type = 'info') {
    let toast = document.getElementById('gsc-downloader-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gsc-downloader-toast';
      toast.className = 'gsc-downloader-toast';
      document.body.appendChild(toast);
    }

    toast.className = `gsc-downloader-toast gsc-toast-${type} gsc-toast-visible`;
    toast.textContent = message;

    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.classList.remove('gsc-toast-visible');
    }, 3500);
  }

  // --- CHROME EXTENSION MESSAGE LISTENER ---

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const action = request.action;

      if (action === 'PING') {
        sendResponse({ pong: true });
        return true;
      }

      if (action === 'GET_STATUS') {
        const reportInfo = detectReportInfo();
        const tables = scrapeAllTables();
        const metrics = scrapeSummaryMetrics(reportInfo);
        const nativeExportAvailable = !!findNativeExportButton();

        sendResponse({
          reportInfo,
          metrics,
          tablesCount: tables.length,
          tablesPreview: tables.map(t => ({ title: t.title, rows: t.rowCount, headers: t.headers })),
          nativeExportAvailable
        });
        return true;
      }

      if (action === 'TRIGGER_EXPORT') {
        exportAllData({ format: request.format || 'zip' })
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }

      if (action === 'TRIGGER_NATIVE_EXPORT') {
        triggerNativeExport(request.format || 'csv')
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }

      if (action === 'NAVIGATE_TO') {
        const target = request.target;
        const currentUrl = new URL(window.location.href);
        const resourceId = currentUrl.searchParams.get('resource_id') || '';
        const userMatch = window.location.pathname.match(/^(\/u\/\d+|\/b\/\d+)?\/search-console/);
        const prefix = userMatch ? userMatch[0] : '/search-console';
        let newPath = '';

        if (target === 'page-indexing') {
          newPath = `${prefix}/index?resource_id=${encodeURIComponent(resourceId)}`;
        } else if (target === 'crawl-stats') {
          newPath = `${prefix}/settings/crawl-stats?resource_id=${encodeURIComponent(resourceId)}`;
        } else if (target === 'core-web-vitals') {
          newPath = `${prefix}/core-web-vitals?resource_id=${encodeURIComponent(resourceId)}`;
        }

        if (newPath) {
          window.location.href = `https://search.google.com${newPath}`;
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Unknown target report' });
        }
        return true;
      }

      if (action === 'TOGGLE_FLOATING_BTN') {
        const container = document.getElementById('gsc-downloader-floating-root');
        if (container) {
          container.style.display = request.show ? 'block' : 'none';
        }
        sendResponse({ success: true });
        return true;
      }
    });
  }

  // Inject floating button when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFloatingButton);
  } else {
    injectFloatingButton();
  }

})();

