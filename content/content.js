/**
 * GSC non-API Data Downloader - Content Script (v2.1.1)
 * Automates Google Search Console's native Export menu ("Download Excel" / "Download CSV")
 * across the main report AND all sub-reports/drilldowns for:
 * 1. Page Indexing (Indexed pages + all "Why pages aren't indexed" reason drilldowns)
 * 2. Crawl Stats (Main 90-day chart export + all 4 breakdown table drilldowns:
 *    By response, By file type, By purpose, and By Googlebot type)
 * 3. Core Web Vitals (Mobile & Desktop reports + all issue drilldowns)
 */

(function () {
  'use strict';

  if (window.__GSC_DOWNLOADER_V211_INITIALIZED__) return;
  window.__GSC_DOWNLOADER_V211_INITIALIZED__ = true;

  let isBatchRunning = false;
  let cancelBatchRequested = false;
  let batchProgressState = null;

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
      'button[aria-label="Back" i], [role="button"][aria-label="Back" i], button[title="Back" i], [role="button"][data-tooltip="Back" i]'
    )).filter((el) => isElementVisible(el) && !el.closest('#gsc-downloader-floating-root'));
    return backBtns.length > 0 ? backBtns[0] : null;
  }

  function isCloseButtonVisible() {
    const closeBtns = Array.from(document.querySelectorAll(
      'button[aria-label*="close" i], [role="button"][aria-label*="close" i], button[title*="close" i], [data-tooltip*="close" i]'
    )).filter((el) => {
      if (!isElementVisible(el)) return false;
      if (el.closest('#gsc-downloader-floating-root')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width > 120 || rect.height > 120) return false;
      return true;
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
      // In Crawl Stats, clicking a breakdown row shows a Back button or flyout drawer Close button
      const backBtn = isBackButtonVisible();
      const closeBtn = isCloseButtonVisible();
      if (
        url.includes('response_code=') ||
        url.includes('file_type=') ||
        url.includes('purpose=') ||
        url.includes('bot_type=') ||
        ((backBtn || closeBtn) && pageTitle && !/crawl stats/i.test(pageTitle))
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
      if (url.includes('/drilldown') || url.includes('item_key=')) {
        isDrilldown = true;
        subView = pageTitle || 'Issue Drilldown';
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
        aria.includes('export') ||
        cleanTxt === 'export' ||
        rawTxt === 'export' ||
        rawTxt.endsWith('export')
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
        attempt >= 12 &&
        (isBackButtonVisible() || isCloseButtonVisible()) &&
        findCrawlStatsBreakdownHeadings().length === 0
      ) {
        exportBtn = findVisibleExportButton(null);
      }
      if (exportBtn) break;
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
   * The 4 standard Crawl Stats breakdown tables in Google Search Console:
   * 1. By response
   * 2. By file type
   * 3. By purpose
   * 4. By Googlebot type (or By Googlebot)
   */
  const CRAWL_STATS_BREAKDOWNS = [
    { id: 'by-response', section: 'By response', regex: /(?:crawl requests:?\s*)?(?:by\s+)?response(s)?/i },
    { id: 'by-file-type', section: 'By file type', regex: /(?:crawl requests:?\s*)?(?:by\s+)?file\s+type(s)?/i },
    { id: 'by-purpose', section: 'By purpose', regex: /(?:crawl requests:?\s*)?(?:by\s+)?purpose/i },
    { id: 'by-googlebot', section: 'By Googlebot type', regex: /(?:crawl requests:?\s*)?(?:by\s+)?googlebot(\s+type)?/i }
  ];

  /**
   * Signature pattern matching for Crawl Stats rows to accurately categorize them
   * even when headings are nested, translated, or styled in custom layouts.
   */
  function detectCrawlStatsSectionBySignature(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.trim();
    // HTTP status codes or status strings: 200, 301, 302, 304, 404, 500, etc.
    if (
      /\b(200|301|302|304|307|308|400|401|403|404|410|429|500|502|503|504)\b/.test(clean) ||
      /^(OK|Moved permanently|Temporary redirect|Redirect|Not found|Server error|Blocked|Other client error)\s*\(/i.test(clean)
    ) {
      return 'By response';
    }
    // File types
    if (
      /^(HTML|Image|JavaScript|CSS|JSON|PDF|Video|Audio|XML|Font|Other file type|Syndication)$/i.test(clean) ||
      /\b(HTML|Image|JavaScript|CSS|JSON|PDF|Video|Audio)\b/i.test(clean)
    ) {
      return 'By file type';
    }
    // Purpose
    if (/^(Refresh|Discovery)$/i.test(clean)) {
      return 'By purpose';
    }
    // Googlebot types
    if (
      /googlebot/i.test(clean) ||
      /^(Smartphone|Desktop|Page resource load|AdsBot|StoreBot|Feedfetcher)$/i.test(clean)
    ) {
      return 'By Googlebot type';
    }
    return null;
  }

  /**
   * Finds the visible heading elements for each of the 4 Crawl Stats breakdowns on the page.
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
   * Isolates the DOM container(s) belonging specifically to a single Crawl Stats breakdown card
   * so rows from "By response", "By file type", "By purpose", and "By Googlebot type" are cleanly separated.
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
      const parentText = getCleanElementText(parent);
      if (/host status/i.test(parentText) && !/host status/i.test(getCleanElementText(cardRoot))) {
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
    } else {
      const fullText = nonEmptyCells.length === 1 ? nonEmptyCells[0].text : getCleanElementText(row);
      const match = fullText.match(/^(.+?)\s+(\d[\d,.]*%?)$/);
      if (!match) return null;
      label = match[1].trim();
      count = match[2].trim();
      firstCell = nonEmptyCells.length === 1 ? nonEmptyCells[0].el : row;
    }

    if (!label || label.length > 140) return null;

    // Skip table header labels, breakdown titles, or pagination controls
    if (/^(reason|response|file type|purpose|googlebot(\s+type)?|metric|status|url|rows per page|by response|by file type|by purpose|by googlebot(\s+type)?)$/i.test(label)) {
      return null;
    }

    // Skip Crawl Stats Host Status rows (Robots.txt fetch, DNS resolution, Server connectivity)
    if (/^(robots\.txt fetch|dns resolution|server connectivity)$/i.test(label)) {
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
   * Discovers all clickable breakdown rows across all 4 Crawl Stats breakdowns:
   * By response, By file type, By purpose, and By Googlebot type.
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
        // Determine whether this button belongs to the Mobile or Desktop card
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
   * Finds all clickable drilldown rows in tables on the current Overview page:
   * - Page Indexing: "Why pages aren't indexed", "Improve page experience"
   * - Crawl Stats: "By response", "By file type", "By purpose", "By Googlebot type"
   * - Core Web Vitals (Mobile/Desktop): "Why URLs aren't considered good"
   */
  function findClickableTableRows(reportInfo) {
    // Do not treat example URL lists inside a single drilldown as sub-report drilldowns
    if (reportInfo.isDrilldown) return [];

    const discoveredRows = [];
    const seenKeys = new Set();

    // On Crawl Stats, first run the dedicated 4-breakdown scanner (By response, By file type, By purpose, By Googlebot type)
    if (reportInfo.reportType === 'crawl-stats') {
      const breakdownRows = findCrawlStatsBreakdownRows();
      breakdownRows.forEach((r) => {
        seenKeys.add(r.key);
        discoveredRows.push(r);
      });
    }

    // Query document directly (filtered by isElementVisible) so nested <c-wiz> cards are never missed
    const rowElements = Array.from(document.querySelectorAll('tbody tr, tr[role="row"], [role="row"]'))
      .filter((row) => {
        if (!isElementVisible(row)) return false;
        if (row.closest('thead')) return false;
        if (row.querySelector('th, [role="columnheader"]')) return false;
        if (row.closest('#gsc-downloader-floating-root')) return false;
        return true;
      });

    rowElements.forEach((row) => {
      // Skip if this DOM row was already captured by findCrawlStatsBreakdownRows
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

      if (nonEmptyCells.length < 2) return;

      const firstCellText = nonEmptyCells[0].text;
      const lastCellText = nonEmptyCells[nonEmptyCells.length - 1].text;

      if (!firstCellText || firstCellText.length > 140) return;

      // Skip table header labels or pagination rows
      if (/^(reason|response|file type|purpose|googlebot(\s+type)?|metric|status|url|rows per page)$/i.test(firstCellText)) {
        return;
      }

      // Skip Crawl Stats Host Status rows (Robots.txt fetch, DNS resolution, Server connectivity)
      // because Host Status sub-views do not have an Export button in GSC.
      if (/^(robots\.txt fetch|dns resolution|server connectivity)$/i.test(firstCellText)) {
        return;
      }

      // Determine which table/section this row belongs to
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
            label: `${b.device} Report (+ Issue Drilldowns)`,
            count: 'Full Report'
          });
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

    const { reportInfo, tasks: allTasks } = discoverExportTasks();

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
    btn.title = '1-Click Export All Report & Drilldown Files (Excel)';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>
      <span>1-Click Export Report (Excel)</span>
    `;

    btn.addEventListener('click', () => {
      let format = 'excel';
      if (isExtensionValid()) {
        try {
          chrome.storage.local.get({ exportFormat: 'excel' }, (res) => {
            if (chrome.runtime?.lastError) {
              runBatchNativeExport({ format: 'excel' });
            } else {
              runBatchNativeExport({ format: res?.exportFormat || 'excel' });
            }
          });
          return;
        } catch (err) {
          console.warn('GSC non-API Downloader: Extension context invalidated, using default settings.', err);
        }
      } else {
        showToast('Extension was updated. Please refresh the page (F5) to enable full features.', 'warning');
      }
      runBatchNativeExport({ format });
    });

    container.appendChild(btn);
    document.body.appendChild(container);

    if (isExtensionValid()) {
      try {
        chrome.storage.local.get({ showFloatingButton: true }, (res) => {
          if (!chrome.runtime?.lastError && res && !res.showFloatingButton) {
            container.style.display = 'none';
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

  // --- MESSAGE LISTENER FOR POPUP ---

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const action = request.action;

      if (action === 'PING') {
        const ver = (isExtensionValid() && chrome.runtime?.getManifest) ? chrome.runtime.getManifest().version : '2.1.1';
        sendResponse({ pong: true, version: ver });
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
          format: request.format || 'excel',
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
