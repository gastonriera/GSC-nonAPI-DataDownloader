/**
 * GSC non-API Data Downloader - Content Script (v3.1.5)
 * Automates Google Search Console's native Export menu ("Download Excel" / "Download CSV")
 * across the main report AND all sub-reports/drilldowns for:
 * 1. Page Indexing (Indexed pages + all "Why pages aren't indexed" reason drilldowns)
 * 2. Crawl Stats (Universal 25-row pagination expansion, 90-day overview chart,
 *    all crawl breakdown tables [By response, By file type, By purpose, By Googlebot type],
 *    Host status [Robots.txt fetch, DNS resolution, Server connectivity], and Hosts)
 * 3. Core Web Vitals (Mobile & Desktop reports + Good URLs + all issue drilldowns)
 */

(function () {
  'use strict';

  if (window.__GSC_DOWNLOADER_V315_INITIALIZED__) return;
  window.__GSC_DOWNLOADER_V315_INITIALIZED__ = true;

  let isBatchRunning = false;
  let cancelBatchRequested = false;
  let batchProgressState = null;
  let inMemoryFloatingBtnPosition = null;
  let activeFloatingExportFormat = 'excel';

  // --- UTILITIES & VISIBILITY HELPERS ---

  /**
   * Safely checks whether the extension context is still valid.
   * Prevents "Extension context invalidated" errors when the extension is reloaded
   * while a tab remains open.
   */
  function isExtensionValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Checks if an element is genuinely visible on screen (excludes hidden <c-wiz> SPA views).
   */
  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    let cur = el;
    while (cur && cur !== document.documentElement) {
      const style = window.getComputedStyle(cur);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  }

  /**
   * Returns the top-level currently visible <c-wiz> container for the active GSC view.
   */
  function getActiveCWiz() {
    const cwizList = Array.from(document.querySelectorAll('c-wiz')).filter((el) => isElementVisible(el));
    return cwizList.length > 0 ? cwizList[0] : document.body;
  }

  function getVisiblePageHeadingText() {
    const headings = Array.from(document.querySelectorAll('h1, [role="heading"][aria-level="1"], .header-title'))
      .filter((el) => isElementVisible(el));
    return headings.length > 0 ? getCleanElementText(headings[headings.length - 1]) : '';
  }

  /**
   * Extracts clean human-readable text from an element, stripping Material icon ligatures.
   */
  function getCleanElementText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    const junkSelectors = [
      'i',
      'svg',
      '.google-material-icons',
      '.material-icons',
      '.DPvwYc',
      '[aria-hidden="true"]'
    ];
    clone.querySelectorAll(junkSelectors.join(',')).forEach((node) => node.remove());

    return (clone.textContent || '')
      .replace(/\b(file_download|save_alt|arrow_drop_down|open_in_new|help_outline|info_outline|chevron_right|arrow_back|error|warning|check_circle|cancel|info|Learn more)\b/gi, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Dispatches a full browser pointer + mouse click sequence so Google Closure (jsaction)
   * and Angular Material components respond reliably.
   */
  function dispatchRealClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1
    };

    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  }

  // --- REPORT DETECTION ---

  function isBackButtonVisible() {
    const backBtns = Array.from(document.querySelectorAll(
      'button, [role="button"], a[role="button"]'
    )).filter((el) => {
      if (!isElementVisible(el)) return false;
      if (el.closest('#gsc-downloader-floating-root')) return false;
      const aria = (
        el.getAttribute('aria-label') ||
        el.getAttribute('data-tooltip') ||
        el.getAttribute('title') ||
        ''
      ).toLowerCase();
      const txt = getCleanElementText(el).toLowerCase();
      if (
        /^(back|atr[aá]s|volver|retour|zur[uü]ck|indietro|voltar|назад)$/i.test(aria) ||
        /^(back|atr[aá]s|volver|retour|zur[uü]ck|indietro|voltar|назад)$/i.test(txt) ||
        aria.includes('back') ||
        aria.includes('atrás') ||
        aria.includes('volver')
      ) {
        return true;
      }
      if (el.querySelector('[data-icon*="arrow_back"], [data-icon*="arrow-back"], [aria-label*="back" i], [aria-label*="atr[aá]s" i]')) {
        return true;
      }
      return false;
    });
    return backBtns.length > 0 ? backBtns[0] : null;
  }

  function isCloseButtonVisible() {
    const closeBtns = Array.from(document.querySelectorAll(
      'button, [role="button"], a[role="button"]'
    )).filter((el) => {
      if (!isElementVisible(el)) return false;
      if (el.closest('#gsc-downloader-floating-root')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width > 120 || rect.height > 120) return false;
      const aria = (
        el.getAttribute('aria-label') ||
        el.getAttribute('data-tooltip') ||
        el.getAttribute('title') ||
        ''
      ).toLowerCase();
      const txt = getCleanElementText(el).toLowerCase();
      if (
        /^(close|cerrar|fermer|schlie[sß]en|chiudi|fechar|закрыть)$/i.test(aria) ||
        /^(close|cerrar|fermer|schlie[sß]en|chiudi|fechar|закрыть)$/i.test(txt) ||
        aria.includes('close') ||
        aria.includes('cerrar')
      ) {
        return true;
      }
      if (el.querySelector('[data-icon*="close"], [aria-label*="close" i], [aria-label*="cerrar" i]')) {
        return true;
      }
      return false;
    });
    return closeBtns.length > 0 ? closeBtns[0] : null;
  }

  function detectReportInfo() {
    const url = window.location.href;

    let reportType = 'unknown';
    let reportName = 'Google Search Console';
    let isDrilldown = false;
    let subView = 'Overview';

    const headingEl = Array.from(document.querySelectorAll('h1, [role="heading"][aria-level="1"], .header-title'))
      .filter((el) => isElementVisible(el))
      .pop();
    const pageTitle = headingEl ? getCleanElementText(headingEl) : '';

    if (url.includes('/settings/crawl-stats')) {
      reportType = 'crawl-stats';
      reportName = 'Crawl Stats';
      // In Crawl Stats, clicking a breakdown or host row shows a Back button or flyout drawer Close button
      const backBtn = isBackButtonVisible();
      const closeBtn = isCloseButtonVisible();
      if (
        url.includes('response_code=') ||
        url.includes('file_type=') ||
        url.includes('purpose=') ||
        url.includes('bot_type=') ||
        url.includes('host=') ||
        url.includes('host_status=') ||
        ((backBtn || closeBtn) && pageTitle && !/(crawl stats|estad[ií]sticas de rastreo)/i.test(pageTitle))
      ) {
        isDrilldown = true;
        subView = pageTitle || 'Breakdown Drilldown';
      } else {
        subView = 'Overview';
      }
    } else if (url.includes('/index') || url.includes('/indexation') || url.includes('/pages')) {
      reportType = 'page-indexing';
      reportName = 'Page Indexing';
      if (url.includes('/drilldown') || url.includes('item_key=')) {
        isDrilldown = true;
        subView = pageTitle || 'Reason Drilldown';
      } else {
        subView = 'Overview';
      }
    } else if (url.includes('/core-web-vitals')) {
      reportType = 'core-web-vitals';
      reportName = 'Core Web Vitals';
      if (url.includes('/drilldown')) {
        isDrilldown = true;
        const isGoodUrls = !url.includes('item_key=');
        const deviceName = (url.includes('device=1') || /desktop/i.test(pageTitle)) ? 'Desktop' : 'Mobile';
        if (isGoodUrls) {
          subView = pageTitle || `${deviceName} Good URLs Report`;
        } else {
          subView = pageTitle || `${deviceName} Issue Drilldown`;
        }
      } else if (url.includes('device=2') || url.includes('/mobile') || /mobile/i.test(pageTitle)) {
        subView = 'Mobile Report';
      } else if (url.includes('device=1') || url.includes('/desktop') || /desktop/i.test(pageTitle)) {
        subView = 'Desktop Report';
      } else {
        subView = 'Overview';
      }
    } else if (url.includes('/performance')) {
      reportType = 'performance';
      reportName = 'Search Performance';
      subView = 'Overview';
    }

    return {
      isGSC: url.includes('search.google.com') && url.includes('search-console'),
      reportType,
      reportName,
      subView,
      isDrilldown,
      pageTitle,
      url
    };
  }

  // --- NATIVE EXPORT BUTTON & MENU FINDER ---

  function findVisibleExportButton(excludeBtn = null) {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'))
      .filter((el) => {
        if (excludeBtn && el === excludeBtn) return false;
        if (!isElementVisible(el)) return false;
        if (el.closest('#gsc-downloader-floating-root')) return false;
        if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return false;
        return true;
      });

    for (const btn of candidates) {
      const aria = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('data-tooltip') ||
        btn.getAttribute('title') ||
        ''
      ).toLowerCase();
      const cleanTxt = getCleanElementText(btn).toLowerCase();
      const rawTxt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

      if (
        aria === 'export' ||
        aria === 'exportar' ||
        aria.includes('export') ||
        aria.includes('exportar') ||
        cleanTxt === 'export' ||
        cleanTxt === 'exportar' ||
        rawTxt === 'export' ||
        rawTxt === 'exportar' ||
        rawTxt.endsWith('export') ||
        rawTxt.endsWith('exportar') ||
        /^(export|exportar|exporter|exportieren|esporta|экспорт)$/i.test(cleanTxt) ||
        /^(export|exportar|exporter|exportieren|esporta|экспорт)$/i.test(aria)
      ) {
        return btn;
      }
    }

    return null;
  }

  /**
   * Visibility check for popup menu/modal elements (allows mid-transition opacity).
   */
  function isMenuElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    let cur = el;
    while (cur && cur !== document.documentElement) {
      const style = window.getComputedStyle(cur);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  }

  /**
   * Checks that text/aria matches ONLY the target export option ("Download Excel" or "Download CSV")
   * and is NOT a parent menu container holding all options ("Google Sheets Download Excel Download CSV").
   */
  function isSingleExportOptionMatch(text, aria, format = 'excel') {
    const combined = `${text || ''} ${aria || ''}`.replace(/\s+/g, ' ').trim();
    if (!combined) return false;

    // Reject parent containers that contain multiple menu options
    const hasSheets = /sheets/i.test(combined);
    const hasExcel = /excel/i.test(combined);
    const hasCsv = /csv/i.test(combined);

    if ((hasSheets && hasExcel) || (hasSheets && hasCsv) || (hasExcel && hasCsv)) {
      return false;
    }

    if (format === 'csv') {
      return hasCsv;
    }
    return hasExcel;
  }

  function findExportMenuItem(format = 'excel') {
    // 1. Check standard ARIA / Closure / Material menu items (NEVER match parent [role="menu"] wrappers)
    const itemSelectors = [
      '[role="menuitem"]',
      '[role="option"]',
      '[role="menuitemradio"]',
      '[role="radio"]',
      '.goog-menuitem',
      '.mat-menu-item',
      '.z80M1'
    ];

    const menuItems = Array.from(document.querySelectorAll(itemSelectors.join(',')))
      .filter((el) => isMenuElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    for (const item of menuItems) {
      const txt = getCleanElementText(item) || (item.textContent || '').trim();
      const aria = item.getAttribute('aria-label') || '';
      if (isSingleExportOptionMatch(txt, aria, format)) {
        const innerEl =
          Array.from(item.querySelectorAll('.jO7h3c, .uyYuVb, span, div'))
            .filter((child) => isMenuElementVisible(child) && isSingleExportOptionMatch(child.textContent, '', format))
            .pop() || item;
        return { menuItem: item, innerEl };
      }
    }

    // 2. Fallback: Find the innermost visible text element matching "Download Excel" / "Excel"
    const allElements = Array.from(document.querySelectorAll('span, div, li, button, a, label'))
      .filter((el) => isMenuElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    const matchingNodes = allElements.filter((el) => {
      const txt = getCleanElementText(el) || (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      return txt.length < 35 && isSingleExportOptionMatch(txt, aria, format);
    });

    if (matchingNodes.length > 0) {
      // Pick the deepest / innermost node
      const innerEl = matchingNodes[matchingNodes.length - 1];
      const interactiveAncestor = innerEl.closest(
        '[role="menuitem"], [role="option"], [role="radio"], [role="button"], button, a, li'
      );
      return {
        menuItem: interactiveAncestor || innerEl,
        innerEl
      };
    }

    return null;
  }

  /**
   * Performs a multi-stage human-realistic hover -> highlight -> mousedown -> mouseup -> click
   * sequence on a Google Closure / Wiz menu item so "Download Excel" is reliably selected.
   */
  async function activateExportMenuItem(matchObj) {
    const { menuItem, innerEl } = matchObj;
    const target = innerEl || menuItem;

    const rect = menuItem.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const baseOpts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0
    };

    // Stage 1: Hover & Highlight (Closure jscontroller="uY3Nvd" requires mouseenter/mouseover to set highlightedItem)
    for (const el of [menuItem, target]) {
      el.dispatchEvent(new PointerEvent('pointerenter', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new PointerEvent('pointerover', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseover', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mousemove', { ...baseOpts, buttons: 0 }));
    }
    if (typeof menuItem.focus === 'function') {
      try { menuItem.focus({ preventScroll: true }); } catch (e) {}
    }

    // Wait 90ms for Closure/Wiz to apply highlight state (.FwR7Pc) to the menu item
    await sleep(90);

    // Stage 2: Mouse / Pointer Press Down
    for (const el of [target, menuItem]) {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...baseOpts, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...baseOpts, buttons: 1 }));
    }

    await sleep(65);

    // Stage 3: Mouse / Pointer Release & Click
    for (const el of [target, menuItem]) {
      el.dispatchEvent(new PointerEvent('pointerup', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...baseOpts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...baseOpts, buttons: 0 }));
    }

    // Stage 4: Fallback if menu/modal is still open after 250ms
    await sleep(250);
    if (isMenuElementVisible(menuItem)) {
      try { target.click(); } catch (e) {}
      try { menuItem.click(); } catch (e) {}

      // Also dispatch Enter key on the focused menuItem (Closure menus execute action on Enter)
      const keyOpts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      };
      menuItem.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      menuItem.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      menuItem.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

      // If inside a modal dialog with a separate confirm/download button, click it too
      const dialog = menuItem.closest('[role="dialog"], [role="alertdialog"]');
      if (dialog) {
        const confirmBtn = Array.from(dialog.querySelectorAll('button, [role="button"]'))
          .find((b) => isMenuElementVisible(b) && /^(download|export|ok|confirm)$/i.test(getCleanElementText(b)));
        if (confirmBtn) {
          dispatchRealClick(confirmBtn);
        }
      }
    }
  }

  /**
   * Triggers GSC's native Export button on the currently visible view and automatically
   * selects "Download Excel" (or "Download CSV").
   */
  async function triggerSingleNativeExport(format = 'excel', meta = null, excludeBtn = null) {
    // Poll up to 6 seconds for the active view's Export button to appear
    let exportBtn = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      exportBtn = findVisibleExportButton(excludeBtn);
      if (
        !exportBtn &&
        excludeBtn &&
        attempt >= 10 &&
        (isBackButtonVisible() || isCloseButtonVisible()) &&
        findCrawlStatsBreakdownHeadings().length === 0
      ) {
        exportBtn = findVisibleExportButton(null);
      }
      if (exportBtn) break;
      // If view has stabilized with Back/Close button and no export button after 3 seconds, stop waiting
      if (!exportBtn && attempt >= 15 && (isBackButtonVisible() || isCloseButtonVisible())) {
        break;
      }
      await sleep(200);
    }

    if (!exportBtn) {
      return {
        success: false,
        skipped: true,
        error: 'No active Export button found on this view'
      };
    }

    // Inform background service worker so it can rename/organize the downloaded file
    if (meta && isExtensionValid() && chrome.runtime?.sendMessage) {
      try {
        await chrome.runtime.sendMessage({
          action: 'PREPARE_DOWNLOAD',
          meta: { ...meta, format }
        });
      } catch (e) {}
    }

    // Start listening for Chrome download creation in parallel
    let downloadStarted = false;
    const downloadWaitPromise = new Promise((resolve) => {
      if (isExtensionValid() && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage({ action: 'WAIT_FOR_DOWNLOAD', timeoutMs: 5500 }, (res) => {
            if (chrome.runtime?.lastError || !res) {
              resolve({ started: false });
              return;
            }
            if (res.started) downloadStarted = true;
            resolve(res);
          });
        } catch (e) {
          setTimeout(() => resolve({ started: false }), 2500);
        }
      } else {
        setTimeout(() => resolve({ started: false }), 2500);
      }
    });

    // Check if the Export menu is already open; if not, click the Export button
    let matchObj = findExportMenuItem(format);
    if (!matchObj) {
      dispatchRealClick(exportBtn);

      // Poll up to 2.5 seconds for the Export menu item ("Download Excel" / "Download CSV") to appear
      for (let i = 0; i < 25; i++) {
        await sleep(100);
        if (downloadStarted) {
          await sleep(500);
          return { success: true, direct: true };
        }
        matchObj = findExportMenuItem(format);
        if (matchObj) break;

        // Only retry native .click() at 800ms if no [role="menu"] is visible yet
        if (i === 8) {
          const anyMenuOpen = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]'))
            .some((m) => isMenuElementVisible(m));
          if (!anyMenuOpen) {
            try { exportBtn.click(); } catch (e) {}
          }
        }
      }
    }

    if (!matchObj) {
      if (downloadStarted) {
        return { success: true, direct: true };
      }
      return {
        success: false,
        error: `Export menu opened, but "${format === 'csv' ? 'Download CSV' : 'Download Excel'}" option was not found.`
      };
    }

    // Wait 180ms for GSC's menu open animation to settle, then automatically select "Download Excel"
    await sleep(180);
    await activateExportMenuItem(matchObj);

    // Wait for Chrome to confirm the download started (or timeout after 5.5s)
    await downloadWaitPromise;

    // Close any lingering menu with Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await sleep(450);

    return { success: true };
  }

  // --- DISCOVERING SUB-REPORTS & DRILLDOWN ROWS ---

  /**
   * The Crawl Stats breakdown tables & sections in Google Search Console:
   * 1. By response (Por respuesta)
   * 2. By file type (Por tipo de archivo)
   * 3. By purpose (Por finalidad / Por propósito)
   * 4. By Googlebot type (Por tipo de Googlebot / Por Googlebot)
   * 5. Host status (Estado del host: Robots.txt fetch, DNS resolution, Server connectivity)
   * 6. Hosts table (Hosts / Servidores)
   */
  const CRAWL_STATS_BREAKDOWNS = [
    {
      id: 'by-response',
      section: 'By response',
      regex: /(?:crawl requests:?\s*)?(?:by\s+|por\s+)?(?:responses?|respuestas?)/i
    },
    {
      id: 'by-file-type',
      section: 'By file type',
      regex: /(?:crawl requests:?\s*)?(?:by\s+|por\s+)?(?:file\s+types?|tipos?\s+de\s+archivo)/i
    },
    {
      id: 'by-purpose',
      section: 'By purpose',
      regex: /(?:crawl requests:?\s*)?(?:by\s+|por\s+)?(?:purpose|finalidad|prop[oó]sito)/i
    },
    {
      id: 'by-googlebot',
      section: 'By Googlebot type',
      regex: /(?:crawl requests:?\s*)?(?:by\s+|por\s+)?(?:googlebot(\s+type)?|tipos?\s+de\s+googlebot)/i
    },
    {
      id: 'host-status',
      section: 'Host status',
      regex: /(?:host\s+status|estado\s+del\s+host|statut\s+de\s+l'h[oô]te|host-status)/i
    },
    {
      id: 'hosts',
      section: 'Hosts',
      regex: /^(?:hosts|hosts\s+table|tabla\s+de\s+hosts|servidores|anfitriones)$/i
    }
  ];

  /**
   * Universal regular expressions to detect pagination range indicators and controls
   * across all Google Search Console languages (e.g. "1–10 of 42", "1–10 de 42", "Filas por página").
   */
  const PAGINATION_RANGE_REGEX = /\b\d+\s*[-–]\s*\d+\s*(?:of|de|von|d'|sur|из|\/)\s*\d+\b/i;
  const PAGINATION_LABEL_REGEX = /(?:rows|filas|lignes|zeilen|righe|linhas|строк)\s*(?:per|por|pro|par|na|de)?\s*(?:page|p[aá]gina|seite|страниц[еу])?/i;

  /**
   * Signature pattern matching for Crawl Stats rows to accurately categorize them
   * even when headings are nested, translated, or styled in custom layouts.
   */
  function detectCrawlStatsSectionBySignature(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.trim();

    // Host status check (Robots.txt fetch, DNS resolution, Server connectivity)
    if (
      /(robots\.txt|dns|resoluci[oó]n|conectividad|connectivity|recuperaci[oó]n)/i.test(clean)
    ) {
      return 'Host status';
    }

    // Hosts check (domain / hostname format: e.g. www.reuse.mx, example.com)
    if (
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(clean)
    ) {
      return 'Hosts';
    }

    // HTTP status codes or status strings: 200, 301, 302, 304, 404, 500, etc.
    if (
      /\b(200|301|302|304|307|308|400|401|403|404|410|429|500|502|503|504)\b/.test(clean) ||
      /^(OK|Correcto|Moved permanently|Temporary redirect|Redirect|Redirecci[oó]n|Not found|No encontrado|Server error|Error del servidor|Blocked|Bloqueado|Other client error|Otro error de cliente)\b/i.test(clean)
    ) {
      return 'By response';
    }

    // File types
    if (
      /^(HTML|Image|Imagen|Imágenes|JavaScript|CSS|JSON|PDF|Video|Audio|XML|Font|Fuente|Other file type|Otro tipo de archivo|Syndication)$/i.test(clean) ||
      /\b(HTML|Image|JavaScript|CSS|JSON|PDF|Video|Audio)\b/i.test(clean)
    ) {
      return 'By file type';
    }

    // Purpose
    if (/^(Refresh|Discovery|Actualizaci[oó]n|Descubrimiento)$/i.test(clean)) {
      return 'By purpose';
    }

    // Googlebot types
    if (
      /googlebot/i.test(clean) ||
      /^(Smartphone|Desktop|Ordenador|Page resource load|Carga de recursos de p[aá]gina|AdsBot|StoreBot|Feedfetcher)$/i.test(clean)
    ) {
      return 'By Googlebot type';
    }

    return null;
  }

  /**
   * Finds the visible heading elements for each of the Crawl Stats breakdowns & sections on the page.
   */
  function findCrawlStatsBreakdownHeadings() {
    const candidates = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], div, span, p, th, td, caption')
    ).filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    const found = [];
    for (const def of CRAWL_STATS_BREAKDOWNS) {
      const matches = candidates.filter((el) => {
        const txt = getCleanElementText(el);
        return txt.length <= 45 && def.regex.test(txt);
      });
      if (matches.length > 0) {
        // Pick the innermost matching element (one that doesn't contain another match)
        const innermost =
          matches.find((el) => !matches.some((other) => other !== el && el.contains(other))) ||
          matches[matches.length - 1];
        found.push({
          ...def,
          headingEl: innermost
        });
      }
    }
    return found;
  }

  /**
   * Isolates the DOM container(s) belonging specifically to a single Crawl Stats section card
   * so rows from "By response", "By file type", "By purpose", "By Googlebot type", "Host status", etc.
   * are cleanly separated.
   */
  function getBreakdownCardScopeElements(item, allHeadings) {
    const otherHeadingEls = allHeadings
      .filter((h) => h.headingEl !== item.headingEl)
      .map((h) => h.headingEl);

    let cardRoot = item.headingEl;
    while (cardRoot.parentElement && cardRoot.parentElement !== document.body) {
      const parent = cardRoot.parentElement;
      if (otherHeadingEls.some((otherEl) => parent.contains(otherEl))) {
        break;
      }
      cardRoot = parent;
    }

    if (cardRoot === item.headingEl || cardRoot.children.length === 0) {
      const scopes = [];
      let sib = item.headingEl.nextElementSibling;
      while (sib) {
        if (otherHeadingEls.some((otherEl) => sib === otherEl || sib.contains(otherEl))) {
          break;
        }
        if (isElementVisible(sib)) {
          scopes.push(sib);
        }
        sib = sib.nextElementSibling;
      }
      if (scopes.length > 0) return scopes;
    }

    return [cardRoot];
  }

  /**
   * Parses a row element inside a Crawl Stats breakdown or report table into { key, section, label, count, rowElement, firstCell }.
   */
  function parseBreakdownRow(row, sectionTitle, headingEl = null) {
    if (!row || !isElementVisible(row)) return null;
    if (row.closest('#gsc-downloader-floating-root')) return null;
    if (headingEl && (row === headingEl || row.contains(headingEl) || headingEl.contains(row))) {
      return null;
    }

    let cellEls = Array.from(row.querySelectorAll('td, [role="cell"], [role="gridcell"]'))
      .filter((c) => isElementVisible(c));

    if (cellEls.length === 0) {
      let children = Array.from(row.children).filter((c) => isElementVisible(c));
      if (children.length === 1 && children[0].children.length >= 2) {
        children = Array.from(children[0].children).filter((c) => isElementVisible(c));
      }
      cellEls = children;
    }

    // Filter to cells with non-empty text (ignores progress bar graphic cells)
    const nonEmptyCells = cellEls
      .map((el) => ({ el, text: getCleanElementText(el) }))
      .filter((item) => item.text.length > 0);

    let label = '';
    let count = '';
    let firstCell = row;

    if (nonEmptyCells.length >= 2) {
      label = nonEmptyCells[0].text;
      count = nonEmptyCells[nonEmptyCells.length - 1].text;
      firstCell = nonEmptyCells[0].el;
    } else if (nonEmptyCells.length === 1) {
      const singleText = nonEmptyCells[0].text;
      const match = singleText.match(/^(.+?)\s+(\d[\d,.]*%?)$/);
      if (match) {
        label = match[1].trim();
        count = match[2].trim();
      } else {
        label = singleText.trim();
        count = '';
      }
      firstCell = nonEmptyCells[0].el;
    } else {
      const fullText = getCleanElementText(row);
      const match = fullText.match(/^(.+?)\s+(\d[\d,.]*%?)$/);
      if (match) {
        label = match[1].trim();
        count = match[2].trim();
      } else if (fullText.length >= 3) {
        label = fullText.trim();
        count = '';
      } else {
        return null;
      }
      firstCell = row;
    }

    if (!label || label.length > 140) return null;

    // Skip table header labels, breakdown titles, or pagination controls
    if (/^(reason|motivo|response|respuesta|file type|tipo de archivo|purpose|finalidad|googlebot(\s+type)?|tipo de googlebot|metric|m[eé]trica|status|estado|url|rows per page|filas por p[aá]gina|by response|by file type|by purpose|by googlebot(\s+type)?|por respuesta|por tipo de archivo|por finalidad|por tipo de googlebot)$/i.test(label)) {
      return null;
    }
    if (PAGINATION_RANGE_REGEX.test(label) || PAGINATION_LABEL_REGEX.test(label)) {
      return null;
    }

    // Reject if label is purely a number or percentage
    if (/^\d[\d,.]*%?$/.test(label)) {
      return null;
    }

    if (!sectionTitle || sectionTitle === 'Breakdown' || sectionTitle === 'Report Table') {
      const sigSection = detectCrawlStatsSectionBySignature(label);
      if (sigSection) {
        sectionTitle = sigSection;
      }
    }

    const interactiveRow =
      row.closest('tr, [role="row"], [role="listitem"], a[href], [role="button"], [tabindex="0"], [jsaction]') || row;

    return {
      key: `${sectionTitle}::${label}`,
      section: sectionTitle,
      label,
      count,
      rowElement: interactiveRow && (!headingEl || !interactiveRow.contains(headingEl)) ? interactiveRow : row,
      firstCell
    };
  }

  /**
   * Discovers all clickable breakdown and section rows across Crawl Stats:
   * By response, By file type, By purpose, By Googlebot type, Host status, and Hosts.
   */
  function findCrawlStatsBreakdownRows() {
    const headings = findCrawlStatsBreakdownHeadings();
    const discovered = [];
    const seenKeys = new Set();

    for (const item of headings) {
      const scopes = getBreakdownCardScopeElements(item, headings);
      let candidateRows = [];

      // Pass 1: Standard table and ARIA rows inside this breakdown card
      for (const scope of scopes) {
        const rows = Array.from(
          scope.querySelectorAll('tbody tr, tr[role="row"], table tr, [role="row"], [role="listitem"], [role="option"]')
        ).filter((r) => {
          if (!isElementVisible(r)) return false;
          if (r.closest('thead')) return false;
          if (r.querySelector('th, [role="columnheader"]')) return false;
          if (r === item.headingEl || r.contains(item.headingEl) || item.headingEl.contains(r)) return false;
          return true;
        });
        candidateRows.push(...rows);
      }

      // Keep innermost rows if nested
      candidateRows = candidateRows.filter(
        (r) => !candidateRows.some((other) => other !== r && r.contains(other))
      );

      let parsedForSection = [];
      for (const r of candidateRows) {
        const parsed = parseBreakdownRow(r, item.section, item.headingEl);
        if (parsed && !seenKeys.has(parsed.key)) {
          seenKeys.add(parsed.key);
          parsedForSection.push(parsed);
        }
      }

      // Pass 2: Fallback for div/link/jsaction-based breakdown rows if Pass 1 found none in this card
      if (parsedForSection.length === 0) {
        let fallbackEls = [];
        for (const scope of scopes) {
          const els = Array.from(
            scope.querySelectorAll('a[href], [role="link"], [role="button"], [tabindex="0"], [jsaction], div, li')
          ).filter((el) => {
            if (!isElementVisible(el)) return false;
            if (el === item.headingEl || el.contains(item.headingEl) || item.headingEl.contains(el)) return false;
            return true;
          });
          fallbackEls.push(...els);
        }

        for (const el of fallbackEls) {
          const parsed = parseBreakdownRow(el, item.section, item.headingEl);
          if (parsed && !seenKeys.has(parsed.key)) {
            seenKeys.add(parsed.key);
            parsedForSection.push(parsed);
          }
        }
      }

      discovered.push(...parsedForSection);
    }

    return discovered;
  }

  /**
   * Finds the "View data about indexed pages" button on the Page Indexing overview.
   */
  function findIndexedPagesButton() {
    const candidates = Array.from(document.querySelectorAll(
      '[role="button"], a, button, [jsaction], [tabindex="0"], span, div'
    )).filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    for (const el of candidates) {
      const txt = getCleanElementText(el);
      if (/^view data about indexed pages$/i.test(txt)) {
        return el.closest('[role="button"], a, button, [tabindex="0"], [jsaction]') || el;
      }
    }
    return null;
  }

  /**
   * Finds the Mobile and Desktop "Open report" buttons on the Core Web Vitals overview page.
   */
  function findCwvOpenReportButtons() {
    const results = [];
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    for (const btn of candidates) {
      const txt = getCleanElementText(btn);
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (/^open report$/i.test(txt) || aria.includes('open report')) {
        const card = btn.closest('section, [role="region"], c-wiz > div div, .card') || btn.parentElement?.parentElement;
        const cardText = card ? getCleanElementText(card) : '';
        let device = 'Device';
        if (/mobile/i.test(cardText) && !results.some((r) => r.device === 'Mobile')) {
          device = 'Mobile';
        } else if (/desktop/i.test(cardText) && !results.some((r) => r.device === 'Desktop')) {
          device = 'Desktop';
        } else {
          device = results.length === 0 ? 'Mobile' : 'Desktop';
        }
        results.push({ device, element: btn });
      }
    }
    return results;
  }

  /**
   * Constructs the canonical Google Search Console URL for the Good URLs drilldown report
   * (e.g. https://search.google.com/u/0/search-console/core-web-vitals/drilldown?resource_id=...&device=2).
   */
  function buildCwvGoodUrlsUrl(device = 2) {
    try {
      const currentUrl = new URL(window.location.href);
      const resourceId = currentUrl.searchParams.get('resource_id') || '';
      const userMatch = window.location.pathname.match(/^(\/u\/\d+|\/b\/\d+)?\/search-console/);
      const prefix = userMatch ? userMatch[0] : '/search-console';
      const deviceNum = (device === 1 || String(device).toLowerCase() === 'desktop') ? 1 : 2;

      if (resourceId) {
        return `https://search.google.com${prefix}/core-web-vitals/drilldown?resource_id=${encodeURIComponent(resourceId)}&device=${deviceNum}`;
      }
      currentUrl.searchParams.set('device', String(deviceNum));
      currentUrl.searchParams.delete('item_key');
      return `https://search.google.com${prefix}/core-web-vitals/drilldown?${currentUrl.searchParams.toString()}`;
    } catch (e) {
      return null;
    }
  }

  /**
   * Finds the "View data about good URLs" button or link on the Core Web Vitals report.
   * Matches links by href (/core-web-vitals/drilldown?device=) as well as multilingual button text (EN, ES, FR, DE, etc.).
   */
  function findCwvGoodUrlsButton(device = 2) {
    const deviceNum = (device === 1 || String(device).toLowerCase() === 'desktop') ? 1 : 2;

    // 1. Direct href match for canonical drilldown link
    const candidateLinks = Array.from(document.querySelectorAll('a[href*="/core-web-vitals/drilldown"], [role="button"][href*="/core-web-vitals/drilldown"]'))
      .filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root') && !el.href.includes('item_key='));

    const exactLink = candidateLinks.find((el) => el.href.includes(`device=${deviceNum}`));
    if (exactLink) return exactLink;
    if (candidateLinks.length > 0) return candidateLinks[0];

    // 2. Multilingual text and aria-label matching
    const candidates = Array.from(document.querySelectorAll(
      '[role="button"], a, button, [jsaction], [tabindex="0"], span, div'
    )).filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    const goodUrlsRegex = /(?:view data about good (?:urls|pages)|view good (?:urls|pages)|good (?:urls|pages)|ver datos sobre (?:las )?(?:urls|p[aá]ginas) correctas|ver datos sobre (?:las )?(?:urls|p[aá]ginas) buenas|urls correctas|urls v[aá]lidas|urls buenas|buenas urls|bonnes url|fehlerfreie urls|url validi)/i;

    for (const el of candidates) {
      const txt = getCleanElementText(el);
      const aria = (
        el.getAttribute('aria-label') ||
        el.getAttribute('data-tooltip') ||
        el.getAttribute('title') ||
        ''
      ).toLowerCase();

      if (goodUrlsRegex.test(txt) || goodUrlsRegex.test(aria)) {
        return el.closest('[role="button"], a, button, [tabindex="0"], [jsaction]') || el;
      }
    }
    return null;
  }

  // --- UNIVERSAL MULTILINGUAL PAGINATION EXPANSION (25 ROWS PER PAGE) ---

  /**
   * Finds all pagination container elements across the current page.
   * Matches numeric range text (e.g. "1–10 of 42", "1–10 de 42") and localized labels.
   */
  function findAllPaginationBlocks() {
    const blocks = [];
    const seenElements = new Set();

    // 0. Explicit Angular Material paginators
    const explicitPaginators = Array.from(document.querySelectorAll('mat-paginator, .mat-mdc-paginator, .mat-paginator'))
      .filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));
    for (const p of explicitPaginators) {
      if (!seenElements.has(p)) {
        seenElements.add(p);
        blocks.push(p);
      }
    }

    // 1. Find elements matching range pattern (e.g. "1–10 of 42" or "1–10 de 42")
    const allTextNodes = Array.from(document.querySelectorAll('span, div, p, label, footer, [role="toolbar"]'))
      .filter((el) => {
        if (!isElementVisible(el)) return false;
        if (el.closest('#gsc-downloader-floating-root')) return false;
        const txt = getCleanElementText(el);
        return txt.length < 50 && PAGINATION_RANGE_REGEX.test(txt);
      });

    // Keep only the innermost matching elements
    const innermostRanges = allTextNodes.filter((el) =>
      !allTextNodes.some((other) => other !== el && el.contains(other))
    );

    for (const rangeEl of innermostRanges) {
      let container = rangeEl.closest('mat-paginator, footer, [role="toolbar"], div[jscontroller], div[jsmodel]') || rangeEl.parentElement;
      while (container && container.parentElement && container.parentElement !== document.body) {
        if (container.querySelector('tbody, table, [role="grid"], [role="table"]')) {
          break;
        }
        if (container.parentElement.querySelector('tbody, table, [role="grid"], [role="table"]')) {
          break;
        }
        container = container.parentElement;
      }

      if (container && !seenElements.has(container) && !blocks.some((b) => b === container || b.contains(container))) {
        seenElements.add(container);
        blocks.push(container);
      }
    }

    // 2. Also check for localized "rows per page" text elements whose containers weren't captured
    const labelNodes = Array.from(document.querySelectorAll('span, div, p, label'))
      .filter((el) => {
        if (!isElementVisible(el)) return false;
        if (el.closest('#gsc-downloader-floating-root')) return false;
        const txt = getCleanElementText(el);
        return txt.length < 40 && PAGINATION_LABEL_REGEX.test(txt);
      });

    for (const lbl of labelNodes) {
      const container = lbl.closest('mat-paginator, footer, [role="toolbar"], div') || lbl.parentElement;
      if (container && !seenElements.has(container) && !blocks.some((b) => b === container || b.contains(container) || container.contains(b))) {
        seenElements.add(container);
        blocks.push(container);
      }
    }

    return blocks;
  }

  /**
   * Checks whether a pagination dropdown trigger is already set to 25 rows per page.
   * Inspects the trigger element directly to prevent false positives from table cell data.
   */
  function isTriggerAlready25(trigger) {
    if (!trigger) return false;
    const txt = getCleanElementText(trigger).trim();
    if (txt === '25' || /^25\b/.test(txt)) return true;
    const aria = trigger.getAttribute('aria-label') || '';
    if (/\b25\b/.test(aria)) return true;
    const valText = trigger.querySelector('.mat-mdc-select-value, .mat-select-value, .mat-mdc-select-value-text');
    if (valText && (getCleanElementText(valText).trim() === '25' || /^25\b/.test(getCleanElementText(valText).trim()))) {
      return true;
    }
    return false;
  }

  /**
   * Ensures any active CDK overlay panels, menus, or backdrops from previous operations
   * have completely closed and vanished from the DOM before interacting with the next element.
   */
  async function waitForOverlaysToClose(timeoutMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const activeBackdrops = Array.from(
        document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-backdrop-showing')
      ).filter((b) => isElementVisible(b));

      const activePanels = Array.from(
        document.querySelectorAll('div.cdk-overlay-pane, [role="listbox"], .mat-mdc-select-panel, .mat-select-panel')
      ).filter((p) => isMenuElementVisible(p) && !p.closest('#gsc-downloader-floating-root'));

      if (activeBackdrops.length === 0 && activePanels.length === 0) {
        break;
      }

      // If overlay is still lingering after 350ms, send Escape to close it cleanly
      if (Date.now() - start > 350) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      }
      await sleep(100);
    }
    await sleep(100);
  }

  /**
   * Locates the paginator footer container specifically within a card scope.
   */
  function findPaginatorInCardScope(scope) {
    if (!scope || !isElementVisible(scope)) return null;

    // 1. Explicit Angular Material paginator
    const explicit = scope.querySelector('mat-paginator, .mat-mdc-paginator, .mat-paginator');
    if (explicit && isElementVisible(explicit)) return explicit;

    // 2. Elements with pagination range text (e.g. "1–10 of 42", "1–10 de 42")
    const allEls = Array.from(scope.querySelectorAll('div, footer, [role="toolbar"], p, span, label'))
      .filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    const rangeEls = allEls.filter((el) => {
      const txt = getCleanElementText(el);
      return txt.length < 50 && PAGINATION_RANGE_REGEX.test(txt);
    });

    if (rangeEls.length > 0) {
      const innermost = rangeEls.find((el) => !rangeEls.some((other) => other !== el && el.contains(other))) || rangeEls[0];
      const paginatorContainer = innermost.closest('mat-paginator, footer, [role="toolbar"], div[jscontroller], div[jsmodel], div');
      if (paginatorContainer) return paginatorContainer;
    }

    // 3. Elements with pagination label ("Rows per page", "Filas por página")
    const labelEls = allEls.filter((el) => {
      const txt = getCleanElementText(el);
      return txt.length < 40 && PAGINATION_LABEL_REGEX.test(txt);
    });

    if (labelEls.length > 0) {
      const innermostLabel = labelEls.find((el) => !labelEls.some((other) => other !== el && el.contains(other))) || labelEls[0];
      const paginatorContainer = innermostLabel.closest('mat-paginator, footer, [role="toolbar"], div');
      if (paginatorContainer) return paginatorContainer;
    }

    // 4. Any footer or toolbar in scope
    const footer = scope.querySelector('footer, [role="toolbar"]');
    if (footer && isElementVisible(footer)) return footer;

    return null;
  }

  /**
   * Finds the dropdown combobox/trigger inside a pagination block.
   */
  function findDropdownTriggerInPaginationBlock(block) {
    if (!block || !isElementVisible(block)) return null;

    // 1. Native <select> element
    const selectEl = block.querySelector('select');
    if (selectEl && isElementVisible(selectEl)) {
      return { type: 'select', element: selectEl, container: selectEl };
    }

    // 2. Angular Material / MDC Select components inside page-size container
    const matSelectInSize = block.querySelector('.mat-mdc-paginator-page-size mat-select, .mat-paginator-page-size mat-select');
    if (matSelectInSize && isElementVisible(matSelectInSize)) {
      const innerTrigger = matSelectInSize.querySelector('.mat-mdc-select-trigger, .mat-select-trigger, [role="combobox"]') || matSelectInSize;
      return { type: 'custom', element: innerTrigger, container: matSelectInSize };
    }

    // 3. Any mat-select inside the block
    const matSelect = block.querySelector('mat-select, .mat-mdc-select, .mat-select');
    if (matSelect && isElementVisible(matSelect)) {
      const innerTrigger = matSelect.querySelector('.mat-mdc-select-trigger, .mat-select-trigger, [role="combobox"]') || matSelect;
      return { type: 'custom', element: innerTrigger, container: matSelect };
    }

    // 4. Sibling search relative to "Rows per page" or "Filas por página" text node
    const textEls = Array.from(block.querySelectorAll('span, div, p, label'))
      .filter((el) => isElementVisible(el) && PAGINATION_LABEL_REGEX.test(getCleanElementText(el)));

    for (const txtEl of textEls) {
      let sib = txtEl.nextElementSibling;
      while (sib) {
        if (isElementVisible(sib)) {
          const innerTrigger = sib.querySelector('mat-select, button, [role="combobox"], [role="button"], div[jsaction]') || sib;
          return { type: 'custom', element: innerTrigger, container: sib };
        }
        sib = sib.nextElementSibling;
      }
    }

    // 5. Look for button/div displaying current page size numbers ("5", "10", "20", "25", "50", "100")
    const allClickable = Array.from(block.querySelectorAll('button, [role="button"], div[tabindex="0"], div[jsaction], span[tabindex="0"]'))
      .filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    for (const el of allClickable) {
      const txt = getCleanElementText(el).trim();
      if (/^(5|10|20|25|50|100)$/.test(txt) || /^(5|10|20|25|50|100)\s*(rows|filas)?$/i.test(txt)) {
        return { type: 'custom', element: el, container: el.closest('mat-select') || el };
      }
    }

    // 6. Dropdown combobox / button controls
    const triggerSelectors = [
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
      '.mat-mdc-select-trigger',
      '.mat-select-trigger',
      '.VfPpkd-O12Habb',
      '.VfPpkd-T0kwAb',
      '[aria-label*="row" i]',
      '[aria-label*="fila" i]',
      '[aria-label*="page" i]',
      '[aria-label*="página" i]',
      '[aria-label*="per page" i]',
      '[aria-label*="por página" i]'
    ];

    const candidates = Array.from(block.querySelectorAll(triggerSelectors.join(',')))
      .filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

    if (candidates.length > 0) {
      return { type: 'custom', element: candidates[0], container: candidates[0].closest('mat-select') || candidates[0] };
    }

    return null;
  }

  /**
   * Expands a single Crawl Stats breakdown card to 25 rows per page.
   * Handles overlay lifecycle cleanly to prevent backdrop interference across cards.
   */
  async function expandCardTo25(cardScope, sectionName = '') {
    if (!cardScope || !isElementVisible(cardScope)) return false;

    // 1. Wait for any previous overlay or backdrop to completely vanish
    await waitForOverlaysToClose(1200);

    // 2. Scroll the card into the center of the viewport
    cardScope.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await sleep(150);

    // 3. Find paginator footer inside cardScope
    const paginator = findPaginatorInCardScope(cardScope) || cardScope;
    const triggerInfo = findDropdownTriggerInPaginationBlock(paginator);
    if (!triggerInfo) {
      console.log(`GSC non-API Downloader: No pagination trigger found in card "${sectionName}"`);
      return false;
    }

    // 4. Handle native select
    if (triggerInfo.type === 'select') {
      const selectEl = triggerInfo.element;
      const opt = Array.from(selectEl.options).find(
        (o) => o.value === '25' || o.text.trim() === '25' || /^25\b/.test(o.text.trim())
      );
      if (opt && selectEl.value !== opt.value) {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(650);
        return true;
      }
      return false;
    }

    const trigger = triggerInfo.element;

    // 5. Check if already showing 25
    if (isTriggerAlready25(trigger)) {
      console.log(`GSC non-API Downloader: "${sectionName}" pagination is already set to 25 rows`);
      return true;
    }

    // 6. Scroll trigger specifically into view to ensure it's not obscured
    trigger.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await sleep(100);

    // 7. Click trigger to open dropdown
    const rect = trigger.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const clickOpts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1
    };

    trigger.dispatchEvent(new PointerEvent('pointerdown', clickOpts));
    trigger.dispatchEvent(new MouseEvent('mousedown', clickOpts));
    await sleep(35);
    trigger.dispatchEvent(new PointerEvent('pointerup', { ...clickOpts, buttons: 0 }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { ...clickOpts, buttons: 0 }));
    trigger.dispatchEvent(new MouseEvent('click', { ...clickOpts, buttons: 0 }));
    try { trigger.click(); } catch (e) {}

    // 8. Poll for the opened dropdown overlay panel (up to 2000ms)
    let activePanel = null;
    let opt25 = null;

    const panelSelectors = [
      'div.cdk-overlay-pane:not([style*="display: none"])',
      'div.cdk-overlay-container [role="listbox"]',
      'div.mat-mdc-select-panel',
      'div.mat-select-panel',
      '[role="listbox"]',
      '[role="menu"]',
      '.VfPpkd-xl07Ob-XxIAqe',
      '.goog-menu'
    ];

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);

      const visiblePanels = Array.from(document.querySelectorAll(panelSelectors.join(',')))
        .filter((p) => isMenuElementVisible(p) && !p.closest('#gsc-downloader-floating-root'));

      if (visiblePanels.length > 0) {
        activePanel = visiblePanels[visiblePanels.length - 1];

        const optionEls = Array.from(
          activePanel.querySelectorAll('mat-option, [role="option"], .mat-mdc-option, .mat-option, [role="menuitem"], .VfPpkd-Listitem, li')
        ).filter((el) => isMenuElementVisible(el));

        opt25 = optionEls.find((el) => {
          const val = el.getAttribute('data-value') || el.getAttribute('value') || el.value || '';
          if (val === '25') return true;
          const txt = getCleanElementText(el).trim();
          return txt === '25' || /^25\b/.test(txt);
        });

        if (!opt25) {
          const allInPanel = Array.from(activePanel.querySelectorAll('*')).filter((el) => isMenuElementVisible(el));
          const match = allInPanel.find((el) => {
            const val = el.getAttribute('data-value') || el.getAttribute('value') || '';
            if (val === '25') return true;
            const t = (el.textContent || '').trim();
            return t === '25' || /^25\b/.test(t);
          });
          if (match) {
            opt25 = match.closest('mat-option, [role="option"], .mat-mdc-option, li') || match;
          }
        }

        if (opt25) break;
      }
    }

    if (!opt25) {
      const documentOptions = Array.from(
        document.querySelectorAll('mat-option, .mat-mdc-option, [role="option"][data-value="25"], [role="option"]')
      ).filter((el) => isMenuElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

      opt25 = documentOptions.find((el) => {
        const val = el.getAttribute('data-value') || el.getAttribute('value') || '';
        if (val === '25') return true;
        const txt = getCleanElementText(el).trim();
        return txt === '25' || /^25\b/.test(txt);
      });
    }

    if (opt25) {
      if (typeof opt25.focus === 'function') {
        try { opt25.focus({ preventScroll: true }); } catch (e) {}
      }

      const optRect = opt25.getBoundingClientRect();
      const optX = optRect.left + optRect.width / 2;
      const optY = optRect.top + optRect.height / 2;

      const optOpts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: optX,
        clientY: optY,
        screenX: optX,
        screenY: optY,
        button: 0
      };

      opt25.dispatchEvent(new PointerEvent('pointerenter', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('mouseenter', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new PointerEvent('pointerover', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('mouseover', { ...optOpts, buttons: 0 }));
      await sleep(30);

      opt25.dispatchEvent(new PointerEvent('pointerdown', { ...optOpts, buttons: 1 }));
      opt25.dispatchEvent(new MouseEvent('mousedown', { ...optOpts, buttons: 1 }));
      await sleep(40);

      opt25.dispatchEvent(new PointerEvent('pointerup', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('mouseup', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('click', { ...optOpts, buttons: 0 }));

      try { opt25.click(); } catch (e) {}

      const innerTextSpan = opt25.querySelector('.mdc-list-item__primary-text, .mat-mdc-option-text, .mat-option-text, span');
      if (innerTextSpan && innerTextSpan !== opt25) {
        try {
          innerTextSpan.dispatchEvent(new MouseEvent('click', { ...optOpts, buttons: 0 }));
          innerTextSpan.click();
        } catch (e) {}
      }

      const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      opt25.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
      opt25.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
      opt25.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

      const spaceOpts = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
      opt25.dispatchEvent(new KeyboardEvent('keydown', spaceOpts));
      opt25.dispatchEvent(new KeyboardEvent('keyup', spaceOpts));

      await sleep(500);

      await waitForOverlaysToClose(1200);
      return true;
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(150);
      await waitForOverlaysToClose(800);
    }

    return false;
  }

  /**
   * Expands a single pagination block to 25 rows per page.
   * Accurately scopes searching to the opened dropdown overlay panel and dispatches
   * pointer, mouse, and keyboard interaction to reliably select the "25" option.
   */
  async function expandPaginationBlockTo25(block) {
    const triggerInfo = findDropdownTriggerInPaginationBlock(block);
    if (!triggerInfo) return false;

    // A. Native <select> element
    if (triggerInfo.type === 'select') {
      const selectEl = triggerInfo.element;
      const opt = Array.from(selectEl.options).find(
        (o) => o.value === '25' || o.text.trim() === '25' || /^25\b/.test(o.text.trim())
      );
      if (opt && selectEl.value !== opt.value) {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(650);
        return true;
      }
      return false;
    }

    const trigger = triggerInfo.element;

    // Check if trigger itself already displays "25"
    if (isTriggerAlready25(trigger)) {
      return true;
    }

    await waitForOverlaysToClose(800);

    trigger.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await sleep(100);

    const rect = trigger.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const clickOpts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1
    };

    trigger.dispatchEvent(new PointerEvent('pointerdown', clickOpts));
    trigger.dispatchEvent(new MouseEvent('mousedown', clickOpts));
    await sleep(35);
    trigger.dispatchEvent(new PointerEvent('pointerup', { ...clickOpts, buttons: 0 }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { ...clickOpts, buttons: 0 }));
    trigger.dispatchEvent(new MouseEvent('click', { ...clickOpts, buttons: 0 }));
    try { trigger.click(); } catch (e) {}

    let activePanel = null;
    let opt25 = null;

    const panelSelectors = [
      'div.cdk-overlay-pane:not([style*="display: none"])',
      'div.cdk-overlay-container [role="listbox"]',
      'div.mat-mdc-select-panel',
      'div.mat-select-panel',
      '[role="listbox"]',
      '[role="menu"]',
      '.VfPpkd-xl07Ob-XxIAqe',
      '.goog-menu'
    ];

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);

      const visiblePanels = Array.from(document.querySelectorAll(panelSelectors.join(',')))
        .filter((p) => isMenuElementVisible(p) && !p.closest('#gsc-downloader-floating-root'));

      if (visiblePanels.length > 0) {
        activePanel = visiblePanels[visiblePanels.length - 1];

        const optionEls = Array.from(activePanel.querySelectorAll('mat-option, [role="option"], .mat-mdc-option, .mat-option, [role="menuitem"], .VfPpkd-Listitem, li'))
          .filter((el) => isMenuElementVisible(el));

        opt25 = optionEls.find((el) => {
          const val = el.getAttribute('data-value') || el.getAttribute('value') || el.value || '';
          if (val === '25') return true;
          const txt = getCleanElementText(el).trim();
          return txt === '25' || /^25\b/.test(txt);
        });

        if (!opt25) {
          const allInPanel = Array.from(activePanel.querySelectorAll('*'))
            .filter((el) => isMenuElementVisible(el));

          const match = allInPanel.find((el) => {
            const val = el.getAttribute('data-value') || '';
            if (val === '25') return true;
            const t = (el.textContent || '').trim();
            return t === '25';
          });

          if (match) {
            opt25 = match.closest('mat-option, [role="option"], .mat-mdc-option, li') || match;
          }
        }

        if (opt25) break;
      }
    }

    if (!opt25) {
      const documentOptions = Array.from(document.querySelectorAll('mat-option, .mat-mdc-option, [role="option"][data-value="25"], [role="option"]'))
        .filter((el) => isMenuElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));

      opt25 = documentOptions.find((el) => {
        const val = el.getAttribute('data-value') || el.getAttribute('value') || '';
        if (val === '25') return true;
        const txt = getCleanElementText(el).trim();
        return txt === '25' || /^25\b/.test(txt);
      });
    }

    if (opt25) {
      if (typeof opt25.focus === 'function') {
        try { opt25.focus({ preventScroll: true }); } catch (e) {}
      }

      const optRect = opt25.getBoundingClientRect();
      const optX = optRect.left + optRect.width / 2;
      const optY = optRect.top + optRect.height / 2;

      const optOpts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: optX,
        clientY: optY,
        screenX: optX,
        screenY: optY,
        button: 0
      };

      opt25.dispatchEvent(new PointerEvent('pointerenter', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('mouseenter', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new PointerEvent('pointerover', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('mouseover', { ...optOpts, buttons: 0 }));
      await sleep(30);

      opt25.dispatchEvent(new PointerEvent('pointerdown', { ...optOpts, buttons: 1 }));
      opt25.dispatchEvent(new MouseEvent('mousedown', { ...optOpts, buttons: 1 }));
      await sleep(40);

      opt25.dispatchEvent(new PointerEvent('pointerup', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('mouseup', { ...optOpts, buttons: 0 }));
      opt25.dispatchEvent(new MouseEvent('click', { ...optOpts, buttons: 0 }));

      try { opt25.click(); } catch (e) {}

      const innerTextSpan = opt25.querySelector('.mdc-list-item__primary-text, .mat-mdc-option-text, .mat-option-text, span');
      if (innerTextSpan && innerTextSpan !== opt25) {
        try {
          innerTextSpan.dispatchEvent(new MouseEvent('click', { ...optOpts, buttons: 0 }));
          innerTextSpan.click();
        } catch (e) {}
      }

      const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      opt25.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
      opt25.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
      opt25.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

      const spaceOpts = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
      opt25.dispatchEvent(new KeyboardEvent('keydown', spaceOpts));
      opt25.dispatchEvent(new KeyboardEvent('keyup', spaceOpts));

      await sleep(500);

      await waitForOverlaysToClose(1000);
      return true;
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(150);
      await waitForOverlaysToClose(800);
    }

    return false;
  }

  /**
   * Expands every pagination control found on Crawl Stats to 25 rows per page.
   * Explicitly targets each breakdown card:
   * 1. "By response"
   * 2. "By file type"
   * 3. "By purpose"
   * 4. "By Googlebot type"
   * Sequentially isolates each card, waits for overlays to close between cards,
   * and expands each to 25 rows.
   */
  async function expandAllCrawlStatsBreakdownsTo25() {
    let anyChanged = false;

    // 1. Explicitly locate the 4 Crawl Requests Breakdown headings
    const breakdownHeadings = findCrawlStatsBreakdownHeadings();
    const targetBreakdownIds = ['by-response', 'by-file-type', 'by-purpose', 'by-googlebot'];
    const targetHeadings = breakdownHeadings.filter((h) => targetBreakdownIds.includes(h.id));

    if (targetHeadings.length > 0) {
      for (const item of targetHeadings) {
        try {
          showProgressPanel(1, 1, `Expanding "${item.section}" to 25 rows...`);
          const scopes = getBreakdownCardScopeElements(item, breakdownHeadings);
          for (const scope of scopes) {
            const changed = await expandCardTo25(scope, item.section);
            if (changed) anyChanged = true;
          }
        } catch (e) {
          console.warn(`GSC non-API Downloader: Error expanding breakdown "${item.section}" to 25`, e);
        }
      }
    }

    // 2. Fallback: check any remaining unexpanded pagination blocks on the page
    const blocks = findAllPaginationBlocks();
    for (const block of blocks) {
      try {
        const changed = await expandPaginationBlockTo25(block);
        if (changed) anyChanged = true;
      } catch (e) {
        console.warn('GSC non-API Downloader: Error expanding fallback pagination block', e);
      }
    }

    if (anyChanged) {
      await sleep(600);
    }
    return anyChanged;
  }

  /**
   * Finds all clickable drilldown rows in tables on the current Overview page:
   * - Page Indexing: "Why pages aren't indexed", "Improve page experience"
   * - Crawl Stats: "By response", "By file type", "By purpose", "By Googlebot type", "Host status", "Hosts", etc.
   * - Core Web Vitals (Mobile/Desktop): "Why URLs aren't considered good"
   */
  function findClickableTableRows(reportInfo) {
    if (reportInfo.isDrilldown) return [];

    const discoveredRows = [];
    const seenKeys = new Set();

    // 1. On Crawl Stats, first discover rows under all known Crawl Stats headings (Breakdowns, Host status, Hosts)
    if (reportInfo.reportType === 'crawl-stats') {
      const breakdownRows = findCrawlStatsBreakdownRows();
      breakdownRows.forEach((r) => {
        if (!seenKeys.has(r.key)) {
          seenKeys.add(r.key);
          discoveredRows.push(r);
        }
      });
    }

    // 2. Discover any additional table rows on the current page
    const rowElements = Array.from(document.querySelectorAll('tbody tr, tr[role="row"], [role="row"]'))
      .filter((row) => {
        if (!isElementVisible(row)) return false;
        if (row.closest('thead')) return false;
        if (row.querySelector('th, [role="columnheader"]')) return false;
        if (row.closest('#gsc-downloader-floating-root')) return false;
        return true;
      });

    rowElements.forEach((row) => {
      if (discoveredRows.some((d) => d.rowElement === row || d.rowElement.contains(row) || row.contains(d.rowElement))) {
        return;
      }

      let cells = Array.from(row.querySelectorAll('td, [role="cell"], [role="gridcell"]'))
        .filter((c) => isElementVisible(c));
      if (cells.length === 0) {
        cells = Array.from(row.children).filter((c) => isElementVisible(c));
      }

      const nonEmptyCells = cells
        .map((el) => ({ el, text: getCleanElementText(el) }))
        .filter((item) => item.text.length > 0);

      if (nonEmptyCells.length === 0) return;

      const firstCellText = nonEmptyCells[0].text;
      const lastCellText = nonEmptyCells.length > 1 ? nonEmptyCells[nonEmptyCells.length - 1].text : '';

      if (!firstCellText || firstCellText.length > 140) return;

      // Skip table header labels or pagination rows
      if (/^(reason|motivo|response|respuesta|file type|tipo de archivo|purpose|finalidad|googlebot(\s+type)?|tipo de googlebot|metric|m[eé]trica|status|estado|url|rows per page|filas por p[aá]gina)$/i.test(firstCellText)) {
        return;
      }
      if (PAGINATION_RANGE_REGEX.test(firstCellText) || PAGINATION_LABEL_REGEX.test(firstCellText)) {
        return;
      }

      // Determine which section this row belongs to
      let sectionTitle = '';
      const tableContainer = row.closest('table, [role="table"], [role="grid"]') || row.parentElement;
      if (tableContainer) {
        let prev = tableContainer.previousElementSibling;
        while (prev && !sectionTitle) {
          if (/H[1-6]/.test(prev.tagName) || prev.matches('[role="heading"]')) {
            sectionTitle = getCleanElementText(prev);
          } else {
            const prevTxt = getCleanElementText(prev);
            for (const bDef of CRAWL_STATS_BREAKDOWNS) {
              if (bDef.regex.test(prevTxt)) {
                sectionTitle = bDef.section;
                break;
              }
            }
          }
          prev = prev.previousElementSibling;
        }
        if (!sectionTitle) {
          const card = tableContainer.closest('section, [role="region"], div[jsmodel], div[jscontroller]');
          if (card) {
            const heading = card.querySelector('h2, h3, h4, [role="heading"]');
            if (heading && isElementVisible(heading)) {
              sectionTitle = getCleanElementText(heading);
            }
          }
        }
      }

      if (!sectionTitle || sectionTitle === 'Breakdown') {
        if (reportInfo.reportType === 'page-indexing') sectionTitle = 'Why pages aren\'t indexed';
        else if (reportInfo.reportType === 'crawl-stats') {
          sectionTitle = detectCrawlStatsSectionBySignature(firstCellText) || 'Breakdown';
        }
        else if (reportInfo.reportType === 'core-web-vitals') sectionTitle = reportInfo.subView || 'Issues';
        else sectionTitle = 'Report Table';
      }

      const uniqueKey = `${sectionTitle}::${firstCellText}`;
      if (seenKeys.has(uniqueKey)) return;
      seenKeys.add(uniqueKey);

      discoveredRows.push({
        key: uniqueKey,
        section: sectionTitle,
        label: firstCellText,
        count: lastCellText,
        rowElement: row,
        firstCell: nonEmptyCells[0].el
      });
    });

    return discoveredRows;
  }

  /**
   * Builds the full list of native export tasks available from the current page.
   */
  function discoverExportTasks() {
    const reportInfo = detectReportInfo();
    if (!reportInfo.isGSC) return { reportInfo, tasks: [] };

    const tasks = [];
    const hasCurrentExportBtn = !!findVisibleExportButton();

    // Case 1: User is already inside a specific Drilldown view
    if (reportInfo.isDrilldown) {
      if (hasCurrentExportBtn) {
        tasks.push({
          id: 'current-drilldown',
          type: 'current-view',
          section: 'Drilldown',
          label: reportInfo.subView || reportInfo.pageTitle || 'Current Drilldown Report',
          count: 'Active View'
        });
      }
      return { reportInfo, tasks };
    }

    // Case 2: Page Indexing Overview (/search-console/index)
    if (reportInfo.reportType === 'page-indexing') {
      if (hasCurrentExportBtn) {
        tasks.push({
          id: 'main-overview',
          type: 'current-view',
          section: 'Overview',
          label: 'Page Indexing Overview (Summary)',
          count: 'Main'
        });
      }

      const indexedBtn = findIndexedPagesButton();
      if (indexedBtn) {
        tasks.push({
          id: 'indexed-pages',
          type: 'indexed-pages-btn',
          section: 'Indexed',
          label: 'Indexed Pages (View data about indexed pages)',
          count: 'Drilldown'
        });
      }

      const rows = findClickableTableRows(reportInfo);
      rows.forEach((r) => {
        tasks.push({
          id: `row::${r.key}`,
          type: 'table-row',
          rowKey: r.key,
          section: r.section,
          label: r.label,
          count: r.count
        });
      });

      return { reportInfo, tasks };
    }

    // Case 3: Crawl Stats Overview (/search-console/settings/crawl-stats)
    if (reportInfo.reportType === 'crawl-stats') {
      if (hasCurrentExportBtn) {
        tasks.push({
          id: 'main-overview',
          type: 'current-view',
          section: 'Overview',
          label: 'Crawl Stats Overview (90-Day Charts)',
          count: 'Main'
        });
      }

      // Include all discovered options & breakdown rows on the page (breakdowns, Host status, Hosts, etc.)
      const rows = findClickableTableRows(reportInfo);
      rows.forEach((r) => {
        tasks.push({
          id: `row::${r.key}`,
          type: 'table-row',
          rowKey: r.key,
          section: r.section,
          label: r.label,
          count: r.count
        });
      });

      return { reportInfo, tasks };
    }

    // Case 4: Core Web Vitals (/search-console/core-web-vitals)
    if (reportInfo.reportType === 'core-web-vitals') {
      const cwvButtons = findCwvOpenReportButtons();
      if (cwvButtons.length > 0 && reportInfo.subView === 'Overview') {
        cwvButtons.forEach((b) => {
          tasks.push({
            id: `cwv::${b.device}`,
            type: 'cwv-device',
            device: b.device,
            section: 'Core Web Vitals',
            label: `${b.device} Report (+ Good URLs & Issue Drilldowns)`,
            count: 'Full Report'
          });
        });

        // Also expose direct Good URLs reports for Mobile and Desktop
        tasks.push({
          id: 'cwv-good-urls-mobile',
          type: 'cwv-good-urls-btn',
          device: 'Mobile',
          section: 'Good URLs',
          label: 'Mobile Good URLs (View data about good URLs)',
          count: 'Mobile',
          targetUrl: buildCwvGoodUrlsUrl(2)
        });

        tasks.push({
          id: 'cwv-good-urls-desktop',
          type: 'cwv-good-urls-btn',
          device: 'Desktop',
          section: 'Good URLs',
          label: 'Desktop Good URLs (View data about good URLs)',
          count: 'Desktop',
          targetUrl: buildCwvGoodUrlsUrl(1)
        });

        return { reportInfo, tasks };
      }

      // Already inside Mobile or Desktop report
      if (hasCurrentExportBtn) {
        tasks.push({
          id: 'main-overview',
          type: 'current-view',
          section: reportInfo.subView,
          label: `${reportInfo.subView} Summary`,
          count: 'Main'
        });
      }

      // Dedicated Good URLs report for the active device
      const currentDevice = (reportInfo.subView && /desktop/i.test(reportInfo.subView)) ? 'Desktop' : 'Mobile';
      const deviceNum = currentDevice === 'Desktop' ? 1 : 2;
      tasks.push({
        id: `cwv-good-urls-${currentDevice.toLowerCase()}`,
        type: 'cwv-good-urls-btn',
        device: currentDevice,
        section: reportInfo.subView || 'Good URLs',
        label: `${currentDevice} Good URLs (View data about good URLs)`,
        count: currentDevice,
        targetUrl: buildCwvGoodUrlsUrl(deviceNum)
      });

      const rows = findClickableTableRows(reportInfo);
      rows.forEach((r) => {
        tasks.push({
          id: `row::${r.key}`,
          type: 'table-row',
          rowKey: r.key,
          section: r.section,
          label: r.label,
          count: r.count
        });
      });

      return { reportInfo, tasks };
    }

    // Case 5: Other GSC Report with an Export button (e.g. Performance)
    if (hasCurrentExportBtn) {
      tasks.push({
        id: 'main-overview',
        type: 'current-view',
        section: reportInfo.reportName,
        label: `${reportInfo.reportName} (${reportInfo.subView})`,
        count: 'Active View'
      });
    }

    return { reportInfo, tasks };
  }

  // --- SPA VIEW NAVIGATION & STATE MANAGEMENT ---

  function captureViewState() {
    return {
      url: window.location.href,
      cWiz: getActiveCWiz(),
      exportBtn: findVisibleExportButton(),
      backBtnVisible: !!isBackButtonVisible(),
      closeBtnVisible: !!isCloseButtonVisible(),
      headingText: getVisiblePageHeadingText(),
      breakdownCount: findCrawlStatsBreakdownHeadings().length
    };
  }

  function isAtViewState(targetState) {
    if (window.location.href !== targetState.url) return false;
    if (!!isBackButtonVisible() !== targetState.backBtnVisible) return false;
    if (!!isCloseButtonVisible() !== targetState.closeBtnVisible) return false;
    if (targetState.breakdownCount > 0 && findCrawlStatsBreakdownHeadings().length === 0) return false;
    const currentHeading = getVisiblePageHeadingText();
    if (targetState.headingText && currentHeading && currentHeading !== targetState.headingText) return false;
    return true;
  }

  async function waitForViewChange(prevState, timeoutMs = 7000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(200);
      const currentUrl = window.location.href;
      const currentCWiz = getActiveCWiz();
      const currentExportBtn = findVisibleExportButton();
      const hasBackBtn = !!isBackButtonVisible();
      const hasCloseBtn = !!isCloseButtonVisible();
      const currentHeading = getVisiblePageHeadingText();
      const currentBreakdownCount = findCrawlStatsBreakdownHeadings().length;

      const urlChanged = currentUrl !== prevState.url;
      const cWizChanged = currentCWiz !== prevState.cWiz;
      const exportBtnChanged = currentExportBtn && currentExportBtn !== prevState.exportBtn;
      const prevExportBtnHidden = prevState.exportBtn && !isElementVisible(prevState.exportBtn);
      const backBtnAppeared = !prevState.backBtnVisible && hasBackBtn;
      const closeBtnAppeared = !prevState.closeBtnVisible && hasCloseBtn;
      const headingChanged = prevState.headingText && currentHeading && currentHeading !== prevState.headingText;
      const breakdownsHidden = prevState.breakdownCount > 0 && currentBreakdownCount === 0;

      // Ensure the DOM view actually transitioned (not just URL change while old view is still visible)
      if (
        cWizChanged ||
        exportBtnChanged ||
        prevExportBtnHidden ||
        backBtnAppeared ||
        closeBtnAppeared ||
        headingChanged ||
        breakdownsHidden ||
        (urlChanged && (!prevState.exportBtn || !isElementVisible(prevState.exportBtn)))
      ) {
        // Give GSC's new view 600ms to finish rendering its toolbar & Export button
        await sleep(600);
        return true;
      }
    }
    return false;
  }

  async function returnToViewState(targetState, timeoutMs = 7500) {
    if (isAtViewState(targetState)) {
      return true;
    }

    // Prefer closing any flyout drawer/dialog first
    const initialCloseBtn = isCloseButtonVisible();
    if (initialCloseBtn && !targetState.closeBtnVisible) {
      dispatchRealClick(initialCloseBtn);
      try { initialCloseBtn.click(); } catch (e) {}
    } else {
      // Otherwise, prefer clicking GSC's in-page Back button or history.back()
      const initialBackBtn = isBackButtonVisible();
      if (initialBackBtn && !targetState.backBtnVisible) {
        dispatchRealClick(initialBackBtn);
      } else {
        window.history.back();
      }
    }

    let usedHistoryBack = false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(200);
      if (isAtViewState(targetState)) {
        await sleep(450);
        return true;
      }

      const elapsed = Date.now() - start;
      if (elapsed > 1200) {
        const curClose = isCloseButtonVisible();
        if (curClose && !targetState.closeBtnVisible) {
          dispatchRealClick(curClose);
          try { curClose.click(); } catch (e) {}
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        }
      }

      if (elapsed > 2000 && !usedHistoryBack) {
        const curClose = isCloseButtonVisible();
        if (curClose && !targetState.closeBtnVisible) {
          dispatchRealClick(curClose);
          try { curClose.click(); } catch (e) {}
        } else {
          usedHistoryBack = true;
          const backBtn = isBackButtonVisible();
          if (backBtn && !targetState.backBtnVisible) {
            try { backBtn.click(); } catch (e) {}
          }
          if (window.location.href !== targetState.url) {
            window.history.back();
          }
        }
      } else if (elapsed > 2800) {
        const curClose = isCloseButtonVisible();
        if (curClose && !targetState.closeBtnVisible) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        }
        const backBtn = isBackButtonVisible();
        if (backBtn && !targetState.backBtnVisible) {
          dispatchRealClick(backBtn);
          await sleep(500);
        }
      }
    }

    await sleep(400);
    return true;
  }

  /**
   * Clicks a drilldown row and ensures GSC navigates to the drilldown view.
   */
  async function openDrilldownRow(rowItem, prevState) {
    const { rowElement, firstCell } = rowItem;
    rowElement.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(180);

    // Check if there is a link inside or wrapping the row
    const link = rowElement.querySelector('a[href]') || rowElement.closest('a[href]');
    const primaryTarget = link || firstCell || rowElement;

    dispatchRealClick(primaryTarget);

    // Wait 400ms; if view hasn't started changing, also click rowElement directly and trigger Enter key
    await sleep(400);
    if (isAtViewState(prevState)) {
      if (rowElement !== primaryTarget) {
        dispatchRealClick(rowElement);
      }
      try { primaryTarget.click(); } catch (e) {}
      try { rowElement.click(); } catch (e) {}

      const keyOpts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      };
      rowElement.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      rowElement.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      rowElement.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    }

    return waitForViewChange(prevState, 7000);
  }

  // --- BATCH AUTOMATION RUNNER ---

  async function runBatchNativeExport(options = {}) {
    if (isBatchRunning) {
      return { success: false, error: 'An export batch is already in progress.' };
    }

    const format = options.format || 'excel'; // 'excel' or 'csv'
    const selectedTaskIds = options.selectedTaskIds || null; // null = run all discovered tasks
    const currentViewOnly = options.currentViewOnly === true;

    let { reportInfo, tasks: allTasks } = discoverExportTasks();

    if (currentViewOnly) {
      showProgressPanel(1, 1, `Exporting ${reportInfo.reportName} (${format.toUpperCase()})...`);
      const res = await triggerSingleNativeExport(format, {
        reportName: reportInfo.reportName,
        section: reportInfo.subView,
        label: reportInfo.pageTitle || reportInfo.subView || 'Current_View',
        index: 1
      });
      hideProgressPanel();
      if (res.success) {
        showToast(`Exported current view (${format.toUpperCase()})!`, 'success');
      } else {
        showToast(res.error || 'Export button not available on this view.', 'error');
      }
      return res;
    }

    // On Crawl Stats, at the very beginning expand all breakdown tables to 25 rows per page
    if (reportInfo.reportType === 'crawl-stats' && !reportInfo.isDrilldown) {
      showProgressPanel(1, 1, 'Expanding breakdown tables to 25 rows per page...');
      await expandAllCrawlStatsBreakdownsTo25();
      const refreshed = discoverExportTasks();
      reportInfo = refreshed.reportInfo;
      allTasks = refreshed.tasks;
    }

    const tasksToRun = selectedTaskIds
      ? allTasks.filter((t) => selectedTaskIds.includes(t.id))
      : allTasks;

    if (tasksToRun.length === 0) {
      showToast('No exportable reports or drilldowns found on this page.', 'error');
      return { success: false, error: 'No exportable items found on this page.' };
    }

    isBatchRunning = true;
    cancelBatchRequested = false;
    let exportedCount = 0;
    let skippedCount = 0;
    let fileIndex = 1;

    try {
      for (let i = 0; i < tasksToRun.length; i++) {
        if (cancelBatchRequested) {
          showToast(`Export stopped (${exportedCount} file(s) downloaded).`, 'info');
          break;
        }

        const task = tasksToRun[i];
        showProgressPanel(i + 1, tasksToRun.length, `${task.section}: ${task.label}`);

        // 1. Current View Export (e.g., Main Crawl Stats overview or active drilldown)
        if (task.type === 'current-view') {
          const res = await triggerSingleNativeExport(format, {
            reportName: reportInfo.reportName,
            section: task.section,
            label: task.label,
            index: fileIndex
          });
          if (res.success) {
            exportedCount++;
            fileIndex++;
          } else {
            skippedCount++;
          }
          await sleep(400);
          continue;
        }

        // 2. "View data about indexed pages" button on Page Indexing Overview
        if (task.type === 'indexed-pages-btn') {
          const overviewState = captureViewState();
          const indexedBtn = findIndexedPagesButton();
          if (!indexedBtn) {
            skippedCount++;
            continue;
          }

          dispatchRealClick(indexedBtn);
          await sleep(400);
          if (isAtViewState(overviewState)) {
            try { indexedBtn.click(); } catch (e) {}
          }

          const changed = await waitForViewChange(overviewState, 7000);
          if (changed) {
            const res = await triggerSingleNativeExport(
              format,
              {
                reportName: reportInfo.reportName,
                section: 'Indexed_Pages',
                label: 'Indexed_Pages',
                index: fileIndex
              },
              overviewState.exportBtn
            );
            if (res.success) {
              exportedCount++;
              fileIndex++;
            } else {
              skippedCount++;
            }
            await returnToViewState(overviewState);
          } else {
            skippedCount++;
          }
          continue;
        }

        // 2b. "View data about good URLs" button on Core Web Vitals
        if (task.type === 'cwv-good-urls-btn') {
          const overviewState = captureViewState();
          const targetDevice = task.device || (task.id.includes('desktop') ? 'Desktop' : 'Mobile');
          const targetDeviceNum = targetDevice === 'Desktop' ? 1 : 2;
          const targetUrl = task.targetUrl || buildCwvGoodUrlsUrl(targetDeviceNum);

          showProgressPanel(i + 1, tasksToRun.length, `Loading ${targetDevice} Good URLs report...`);

          let navigated = false;
          const goodBtn = findCwvGoodUrlsButton(targetDeviceNum);
          if (goodBtn) {
            dispatchRealClick(goodBtn);
            await sleep(400);
            if (isAtViewState(overviewState)) {
              try { goodBtn.click(); } catch (e) {}
            }
            navigated = await waitForViewChange(overviewState, 5000);
          }

          // If button click didn't navigate or button was not found, trigger navigation to targetUrl!
          if (!navigated && targetUrl) {
            const anchor = Array.from(document.querySelectorAll('a[href*="/core-web-vitals/drilldown"]'))
              .find((a) => isElementVisible(a) && a.href.includes(`device=${targetDeviceNum}`) && !a.href.includes('item_key='));
            if (anchor) {
              dispatchRealClick(anchor);
              try { anchor.click(); } catch (e) {}
              navigated = await waitForViewChange(overviewState, 5000);
            }
            if (!navigated) {
              window.location.href = targetUrl;
              return { success: true, navigated: true };
            }
          }

          if (navigated) {
            const res = await triggerSingleNativeExport(
              format,
              {
                reportName: 'Core_Web_Vitals',
                section: targetDevice,
                label: 'Good_URLs',
                index: fileIndex
              },
              overviewState.exportBtn
            );
            if (res.success) {
              exportedCount++;
              fileIndex++;
            } else {
              skippedCount++;
            }
            await returnToViewState(overviewState);
          } else {
            skippedCount++;
          }
          continue;
        }

        // 3. Table Row Drilldown (Page Indexing reasons, Crawl Stats 4 breakdowns, CWV issues)
        if (task.type === 'table-row') {
          const overviewState = captureViewState();
          const currentRows = findClickableTableRows(detectReportInfo());
          const matchingRow =
            currentRows.find((r) => r.key === task.rowKey) ||
            currentRows.find((r) => r.section === task.section && r.label === task.label) ||
            currentRows.find((r) => r.label === task.label);

          if (!matchingRow) {
            skippedCount++;
            continue;
          }

          const navigated = await openDrilldownRow(matchingRow, overviewState);
          if (navigated) {
            const res = await triggerSingleNativeExport(
              format,
              {
                reportName: reportInfo.reportName,
                section: task.section,
                label: task.label,
                index: fileIndex
              },
              overviewState.exportBtn
            );
            if (res.success) {
              exportedCount++;
              fileIndex++;
            } else {
              skippedCount++;
            }
            await returnToViewState(overviewState);
          } else {
            skippedCount++;
          }
          continue;
        }

        // 4. Core Web Vitals Device Report (Mobile / Desktop) + its inner issue drilldowns
        if (task.type === 'cwv-device') {
          const cwvOverviewState = captureViewState();
          const deviceBtns = findCwvOpenReportButtons();
          const targetBtnObj = deviceBtns.find((b) => b.device === task.device);

          if (!targetBtnObj) {
            skippedCount++;
            continue;
          }

          dispatchRealClick(targetBtnObj.element);
          await sleep(400);
          if (isAtViewState(cwvOverviewState)) {
            try { targetBtnObj.element.click(); } catch (e) {}
          }

          const enteredDeviceReport = await waitForViewChange(cwvOverviewState, 7000);
          if (enteredDeviceReport) {
            // Export the Device Summary Report
            showProgressPanel(i + 1, tasksToRun.length, `CWV ${task.device}: Summary Report`);
            const summaryRes = await triggerSingleNativeExport(
              format,
              {
                reportName: 'Core_Web_Vitals',
                section: task.device,
                label: `${task.device}_Summary`,
                index: fileIndex
              },
              cwvOverviewState.exportBtn
            );
            if (summaryRes.success) {
              exportedCount++;
              fileIndex++;
            }

            // Also check for and export Good URLs report if available for this device
            const deviceNum = task.device === 'Desktop' ? 1 : 2;
            const goodUrlsBtn = findCwvGoodUrlsButton(deviceNum);
            const goodUrlsTarget = buildCwvGoodUrlsUrl(deviceNum);
            if (goodUrlsBtn || goodUrlsTarget) {
              showProgressPanel(i + 1, tasksToRun.length, `CWV ${task.device}: Good URLs Report`);
              const preGoodState = captureViewState();
              let enteredGood = false;
              if (goodUrlsBtn) {
                dispatchRealClick(goodUrlsBtn);
                await sleep(400);
                if (isAtViewState(preGoodState)) {
                  try { goodUrlsBtn.click(); } catch (e) {}
                }
                enteredGood = await waitForViewChange(preGoodState, 5000);
              }
              if (!enteredGood && goodUrlsTarget) {
                const anchor = Array.from(document.querySelectorAll('a[href*="/core-web-vitals/drilldown"]'))
                  .find((a) => isElementVisible(a) && a.href.includes(`device=${deviceNum}`) && !a.href.includes('item_key='));
                if (anchor) {
                  dispatchRealClick(anchor);
                  try { anchor.click(); } catch (e) {}
                  enteredGood = await waitForViewChange(preGoodState, 5000);
                }
              }

              if (enteredGood) {
                const goodRes = await triggerSingleNativeExport(
                  format,
                  {
                    reportName: 'Core_Web_Vitals',
                    section: task.device,
                    label: 'Good_URLs',
                    index: fileIndex
                  },
                  preGoodState.exportBtn
                );
                if (goodRes.success) {
                  exportedCount++;
                  fileIndex++;
                }
                await returnToViewState(preGoodState);
              }
            }

            // Also export each issue drilldown row inside this Device Report
            const deviceState = captureViewState();
            const issueRows = findClickableTableRows({ ...reportInfo, isDrilldown: false, subView: task.device });

            for (let j = 0; j < issueRows.length; j++) {
              if (cancelBatchRequested) break;
              const issueTarget = issueRows[j];
              showProgressPanel(
                i + 1,
                tasksToRun.length,
                `CWV ${task.device} (${j + 1}/${issueRows.length}): ${issueTarget.label}`
              );

              const freshRows = findClickableTableRows({ ...reportInfo, isDrilldown: false, subView: task.device });
              const rowToClick = freshRows.find((r) => r.label === issueTarget.label) || freshRows[j];
              if (!rowToClick) continue;

              const enteredIssue = await openDrilldownRow(rowToClick, deviceState);
              if (enteredIssue) {
                const issueRes = await triggerSingleNativeExport(
                  format,
                  {
                    reportName: 'Core_Web_Vitals',
                    section: task.device,
                    label: issueTarget.label,
                    index: fileIndex
                  },
                  deviceState.exportBtn
                );
                if (issueRes.success) {
                  exportedCount++;
                  fileIndex++;
                }
                await returnToViewState(deviceState);
              }
            }

            // Return back to the CWV Overview page
            await returnToViewState(cwvOverviewState);
          } else {
            skippedCount++;
          }
          continue;
        }
      }

      hideProgressPanel();
      if (!cancelBatchRequested) {
        showToast(
          `Finished! Downloaded ${exportedCount} ${format === 'csv' ? 'CSV (.zip)' : 'Excel (.xlsx)'} file(s).`,
          exportedCount > 0 ? 'success' : 'error'
        );
      }

      return {
        success: exportedCount > 0,
        exportedCount,
        skippedCount
      };
    } finally {
      isBatchRunning = false;
      batchProgressState = null;
      hideProgressPanel();
    }
  }

  // --- IN-PAGE UI: FLOATING BUTTON, PROGRESS PANEL & TOAST ---

  function showProgressPanel(current, total, stepLabel) {
    batchProgressState = { current, total, stepLabel };
    let panel = document.getElementById('gsc-downloader-progress-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'gsc-downloader-progress-panel';
      panel.className = 'gsc-downloader-progress-panel';
      panel.innerHTML = `
        <div class="gsc-downloader-progress-header">
          <div class="gsc-downloader-progress-title">
            <div class="gsc-downloader-spinner"></div>
            <span id="gsc-prog-title-text">Exporting GSC Reports...</span>
          </div>
          <button id="gsc-prog-stop-btn" class="gsc-downloader-stop-btn">Stop</button>
        </div>
        <div id="gsc-prog-step-text" class="gsc-downloader-progress-step">Preparing...</div>
        <div class="gsc-downloader-progress-bar-bg">
          <div id="gsc-prog-bar-fill" class="gsc-downloader-progress-bar-fill"></div>
        </div>
      `;
      document.body.appendChild(panel);

      panel.querySelector('#gsc-prog-stop-btn').addEventListener('click', () => {
        cancelBatchRequested = true;
        panel.querySelector('#gsc-prog-step-text').textContent = 'Stopping after current step...';
      });
    }

    panel.style.display = 'flex';
    const pct = total > 0 ? Math.round((current / total) * 100) : 50;
    panel.querySelector('#gsc-prog-title-text').textContent = `Exporting (${current} of ${total})`;
    panel.querySelector('#gsc-prog-step-text').textContent = stepLabel;
    panel.querySelector('#gsc-prog-bar-fill').style.width = `${pct}%`;
  }

  function hideProgressPanel() {
    const panel = document.getElementById('gsc-downloader-progress-panel');
    if (panel) {
      panel.style.display = 'none';
    }
  }

  function updateFloatingButtonFormat(format) {
    activeFloatingExportFormat = format === 'csv' ? 'csv' : 'excel';
    const btn = document.querySelector('.gsc-downloader-floating-btn');
    if (!btn) return;
    const labelSuffix = activeFloatingExportFormat === 'csv' ? 'CSV' : 'Excel';
    btn.title = `1-Click Export All Report Files (${labelSuffix}) • Drag to reposition`;
    const textSpan = btn.querySelector('.gsc-floating-btn-text');
    if (textSpan) {
      textSpan.textContent = `1-Click Export Report (${labelSuffix})`;
    }
  }

  function injectFloatingButton() {
    const existing = document.getElementById('gsc-downloader-floating-root');
    if (existing) {
      existing.remove();
    }
    const reportInfo = detectReportInfo();
    if (!reportInfo.isGSC) return;

    const container = document.createElement('div');
    container.id = 'gsc-downloader-floating-root';

    const btn = document.createElement('button');
    btn.className = 'gsc-downloader-floating-btn';
    btn.setAttribute('type', 'button');
    const labelSuffix = activeFloatingExportFormat === 'csv' ? 'CSV' : 'Excel';
    btn.title = `1-Click Export All Report & Drilldown Files (${labelSuffix}) • Drag to reposition`;
    btn.innerHTML = `
      <span class="gsc-drag-grip" title="Drag to reposition">⋮⋮</span>
      <svg viewBox="0 0 24 24" class="gsc-floating-btn-icon">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>
      <span class="gsc-floating-btn-text">1-Click Export Report (${labelSuffix})</span>
    `;

    // Apply saved in-memory position if user moved it earlier during this window session
    if (inMemoryFloatingBtnPosition) {
      btn.style.left = `${inMemoryFloatingBtnPosition.left}px`;
      btn.style.top = `${inMemoryFloatingBtnPosition.top}px`;
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    }

    // --- DRAGGABLE IMPLEMENTATION ---
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let btnInitialLeft = 0;
    let btnInitialTop = 0;
    let hasMovedSignificantly = false;
    let suppressNextClick = false;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // Only primary mouse button or touch

      const rect = btn.getBoundingClientRect();
      btnInitialLeft = rect.left;
      btnInitialTop = rect.top;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      isDragging = true;
      hasMovedSignificantly = false;

      try {
        btn.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    btn.addEventListener('pointermove', (e) => {
      if (!isDragging) return;

      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      if (!hasMovedSignificantly && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        hasMovedSignificantly = true;
        btn.classList.add('is-dragging');
      }

      if (hasMovedSignificantly) {
        e.preventDefault();
        const btnRect = btn.getBoundingClientRect();
        const btnWidth = btnRect.width || 220;
        const btnHeight = btnRect.height || 42;

        let newLeft = btnInitialLeft + dx;
        let newTop = btnInitialTop + dy;

        // Keep inside window bounds with 8px margin
        const maxLeft = Math.max(8, window.innerWidth - btnWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - btnHeight - 8);

        newLeft = Math.max(8, Math.min(newLeft, maxLeft));
        newTop = Math.max(8, Math.min(newTop, maxTop));

        btn.style.left = `${newLeft}px`;
        btn.style.top = `${newTop}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';

        inMemoryFloatingBtnPosition = { left: newLeft, top: newTop };
      }
    });

    const finishDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;

      try {
        btn.releasePointerCapture(e.pointerId);
      } catch (_) {}

      btn.classList.remove('is-dragging');

      if (hasMovedSignificantly) {
        suppressNextClick = true;
        setTimeout(() => {
          suppressNextClick = false;
        }, 120);
      }
    };

    btn.addEventListener('pointerup', finishDrag);
    btn.addEventListener('pointercancel', finishDrag);

    // Click handler for exporting
    btn.addEventListener('click', (e) => {
      if (suppressNextClick || hasMovedSignificantly) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (isExtensionValid()) {
        try {
          chrome.storage.local.get({ exportFormat: 'excel' }, (res) => {
            const formatToUse = (res && res.exportFormat) ? res.exportFormat : activeFloatingExportFormat;
            runBatchNativeExport({ format: formatToUse });
          });
          return;
        } catch (err) {
          console.warn('GSC non-API Downloader: using cached format', err);
        }
      } else {
        showToast('Extension was updated. Please refresh the page (F5) to enable full features.', 'warning');
      }
      runBatchNativeExport({ format: activeFloatingExportFormat });
    });

    container.appendChild(btn);
    document.body.appendChild(container);

    // Load initial format & visibility settings from storage
    if (isExtensionValid()) {
      try {
        chrome.storage.local.get({ exportFormat: 'excel', showFloatingButton: true }, (res) => {
          if (!chrome.runtime?.lastError && res) {
            if (res.exportFormat) {
              updateFloatingButtonFormat(res.exportFormat);
            }
            if (res.showFloatingButton === false) {
              container.style.display = 'none';
            }
          }
        });
      } catch (e) {}
    }
  }

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
    }, 4000);
  }

  // Window resize listener to keep custom button position visible
  window.addEventListener('resize', () => {
    if (inMemoryFloatingBtnPosition) {
      const btn = document.querySelector('.gsc-downloader-floating-btn');
      if (btn) {
        const btnRect = btn.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - btnRect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - btnRect.height - 8);
        const newLeft = Math.max(8, Math.min(inMemoryFloatingBtnPosition.left, maxLeft));
        const newTop = Math.max(8, Math.min(inMemoryFloatingBtnPosition.top, maxTop));
        btn.style.left = `${newLeft}px`;
        btn.style.top = `${newTop}px`;
        inMemoryFloatingBtnPosition = { left: newLeft, top: newTop };
      }
    }
  });

  // Storage listener to reactively update format and visibility across tabs
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (changes.exportFormat && changes.exportFormat.newValue) {
            updateFloatingButtonFormat(changes.exportFormat.newValue);
          }
          if (changes.showFloatingButton !== undefined) {
            const container = document.getElementById('gsc-downloader-floating-root');
            if (container) {
              container.style.display = changes.showFloatingButton.newValue ? 'block' : 'none';
            }
          }
        }
      });
    } catch (e) {}
  }

  // --- MESSAGE LISTENER FOR POPUP ---

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const action = request.action;

      if (action === 'PING') {
        const ver = (isExtensionValid() && chrome.runtime?.getManifest) ? chrome.runtime.getManifest().version : '3.1.5';
        sendResponse({ pong: true, version: ver });
        return true;
      }

      if (action === 'SET_EXPORT_FORMAT') {
        if (request.format) {
          updateFloatingButtonFormat(request.format);
        }
        sendResponse({ success: true });
        return true;
      }

      if (action === 'GET_STATUS') {
        const { reportInfo, tasks } = discoverExportTasks();
        sendResponse({
          reportInfo,
          tasks,
          nativeExportAvailable: !!findVisibleExportButton(),
          isBatchRunning,
          batchProgressState
        });
        return true;
      }

      if (action === 'START_BATCH_EXPORT') {
        runBatchNativeExport({
          format: request.format || activeFloatingExportFormat || 'excel',
          selectedTaskIds: request.selectedTaskIds || null,
          currentViewOnly: request.currentViewOnly === true
        })
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      if (action === 'STOP_BATCH_EXPORT') {
        cancelBatchRequested = true;
        sendResponse({ success: true });
        return true;
      }

      if (action === 'NAVIGATE_TO') {
        const target = request.target;
        const searchQuery = window.location.search || '';
        const userMatch = window.location.pathname.match(/^(\/u\/\d+|\/b\/\d+)?\/search-console/);
        const prefix = userMatch ? userMatch[0] : '/search-console';
        let newPath = '';

        if (target === 'page-indexing') {
          newPath = `${prefix}/index${searchQuery}`;
        } else if (target === 'crawl-stats') {
          newPath = `${prefix}/settings/crawl-stats${searchQuery}`;
        } else if (target === 'core-web-vitals') {
          newPath = `${prefix}/core-web-vitals${searchQuery}`;
        } else if (target === 'cwv-good-urls-mobile' || target === 'cwv-good-urls') {
          const resId = new URLSearchParams(searchQuery).get('resource_id') || '';
          newPath = `${prefix}/core-web-vitals/drilldown?resource_id=${encodeURIComponent(resId)}&device=2`;
        } else if (target === 'cwv-good-urls-desktop') {
          const resId = new URLSearchParams(searchQuery).get('resource_id') || '';
          newPath = `${prefix}/core-web-vitals/drilldown?resource_id=${encodeURIComponent(resId)}&device=1`;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFloatingButton);
  } else {
    injectFloatingButton();
  }
})();
