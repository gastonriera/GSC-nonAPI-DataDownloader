# GSC non-API Data Downloader (`v3.1.9`)

A property-agnostic Chrome extension (Manifest V3) that automates **1-click native file exports (`Download Excel` / `Download CSV`)** across Google Search Console reports and all of their sub-reports/drilldowns:
1. **Page Indexing Report** (`/index` — exports Indexed Pages + cycles through every reason in *"Why pages aren't indexed"*)
2. **Crawl Stats Report** (`/settings/crawl-stats` — section-by-section 25-row expansion and download workflow: exports the 90-day charts overview, jumps straight to the Crawl requests breakdown, expands *"By response"* to 25 rows and downloads its data, then expands *"By file type"* to 25 rows and downloads its data, then *"By purpose"*, and *"By Googlebot type"* — strictly targeting only the 4 breakdown categories without clicking unrelated page buttons)
3. **Core Web Vitals Report** (`/core-web-vitals` — opens *Mobile* and *Desktop* reports, exports summaries, issue drilldowns, and directly loads/exports the canonical **Good URLs** drilldown report for Mobile (`&device=2`) and Desktop (`&device=1`))

---

## 💡 Why This Extension Exists

The official Google Search Console API does not provide endpoints for Crawl Stats, Core Web Vitals aggregates, or full Page Indexing drilldowns. In the GSC web interface, downloading all of these requires manually clicking into dozens of sub-reports and clicking `Export` → `Download Excel` one by one.

**GSC non-API Data Downloader (`v3.1.9`)** automates that entire process with a single click—regardless of which domain, language, or property type is open—downloading the official Google Search Console `.xlsx` (or `.zip` CSV) files and automatically organizing all exports into a dedicated date-stamped folder (`Downloads/GSC-Exports-YYYY-MM-DD/`) without any save dialogs or manual confirmations.

---

## 🚀 Key Features (`v3.1.9`)

* **📁 Automatic Single Date Folder (`v3.1.9`)**:
  * **Unified Current-Date Folder**: Automatically groups every downloaded file (the main overview plus all 4 crawl breakdown drilldowns) into a single folder stamped with the current local date: `Downloads/GSC-Exports-YYYY-MM-DD/` (e.g., `GSC-Exports-2026-11-04/`).
  * **Zero Manual "Save As" Dialogs**: Downloads run 100% automatically in the background without prompting you to pick a folder, click Save, or confirm multi-file downloads.
  * **Queue-Based Interception & Robust Fallback**: A FIFO download queue in the background service worker pairs sequential metadata (e.g., `01_...`, `02_...`) with incoming browser downloads. Even if Google routes files through redirected Google Cloud storage endpoints (`*.googleusercontent.com`), the extension guarantees that every file is directed into the active date folder with `conflictAction: 'uniquify'`.
* **🌐 100% Property- & Language-Agnostic**:
  * Works on any GSC property (Domain property, URL-prefix property, subfolder, etc.) without inspecting or depending on the domain name.
  * Fully supports multilingual interfaces (English, Spanish, French, German, Italian, Portuguese, etc.), matching localized navigation, headings, and pagination controls.
* **🎯 Draggable Floating Export Button (`v3.1.4+`)**:
  * **Free-Floating Window Positioning**: Move the in-page export button anywhere on the screen by dragging its grip `⋮⋮` or button body. It stays at your chosen position across single-page report navigation until you refresh the window.
  * **Dynamic Format Reflection**: Instantly reflects your chosen export format (`Excel` or `CSV`) directly on the button label, updating in real time whenever you switch formats in the popup.
* **⚡ Silent Downloads & macOS Save Dialog Prevention**:
  * **Automatic Multi-File Downloads**: Grants `contentSettings.automaticDownloads` permission to `https://search.google.com/*`, `https://*.google.com/*`, and `https://*.googleusercontent.com/*`, permanently preventing Chrome from prompting *"This site is attempting to download multiple files. Allow / Block"*.
  * **Zero Collision Prompts**: Enforces `conflictAction: 'uniquify'` on all Google Search Console exports so Chrome never prompts to overwrite or pick duplicate filenames.
  * **Dedicated macOS Helper & Quick Settings**: Popup detects macOS and displays a 1-click shortcut to disable Chrome's global *"Ask where to save each file before downloading"* toggle (`chrome://settings/downloads`).
  * **Configurable Date Folder Toggle**: Toggle between date-stamped folders (`Downloads/GSC-Exports-YYYY-MM-DD/`) and direct flat downloads in your root `Downloads/` folder.
* **📊 Native Excel (`.xlsx`) & CSV (`.zip`) Export**:
  * Triggers Google Search Console's official `Export` → `Download Excel` (default) or `Download CSV` menu option on each report.
* **🔄 Automated Sub-Report & Drilldown Crawler**:
  * **Page Indexing**: Clicks into *"View data about indexed pages"* and each row in *"Why pages aren't indexed"*, triggers the native export on each drilldown, and navigates back automatically.
  * **Crawl Stats (Strictly Crawl Breakdowns Workflow in v3.1.8+)**:
    * **Jump to Breakdown Section**: Once the main overview file (90-day charts) is exported, the page smoothly scrolls straight down to the *"Crawl requests breakdown"* section.
    * **Strictly Scoped to Breakdown Tables**: Discovers and exports only rows belonging to the 4 crawl breakdown tables (*By response*, *By file type*, *By purpose*, *By Googlebot type*), completely eliminating attempts to click unrelated buttons, status cards, or non-breakdown options on the page.
    * **Multi-Strategy Paginator & Dropdown Expansion**: Overhauled 25-row selector targeting utilizing ancestor containment, document order heading proximity (`compareDocumentPosition`), and positional index mapping across `findAllPaginationBlocks()`.
    * **Reliable Angular Material `<mat-select>` Activation**: Focuses host containers, triggers synthetic pointer and mouse events on both trigger and host elements, and provides keyboard `Space`/`Enter` fallbacks to reliably open Angular CDK overlay panels and select option `25`.
    * **Streamlined "By purpose" Handling**: Automatically detects that *"By purpose"* contains at most 2 rows (*Discovery* and *Refresh*), bypassing unnecessary dropdown interactions.
    * **Interleaved Section-by-Section Processing**: Starts by expanding *"By response"* to 25 rows and immediately downloading all data from that section; then proceeds to expand *"By file type"* to 25 rows and downloads its data; then expands and downloads *"By purpose"*; and finally expands and downloads *"By Googlebot type"*.
    * **State-Preserving Resiliency**: Automatically detects if GSC resets table pagination back to 10 rows when returning from drilldown pages, immediately re-expanding to 25 rows so all rows 1–25 are always clickable and exported.
    * **CDK Overlay & Backdrop Lifecycle Management**: Uses `waitForOverlaysToClose()` to ensure any lingering Angular CDK overlay panels or backdrops (`.cdk-overlay-backdrop-showing`) from previous cards are completely detached before opening subsequent dropdowns, eliminating click interception.
  * **Core Web Vitals**:
    * **Canonical Good URLs Drilldown Loading**: When selecting *"View data about good URLs"*, the extension directly loads the exact canonical report URL (`/core-web-vitals/drilldown?resource_id=<property>&device=2` for Mobile, or `device=1` for Desktop).
    * **Multilingual Good URLs Detection**: Matches English (*"View data about good URLs"*), Spanish (*"Ver datos sobre las URLs correctas"*, *"URLs correctas"*), and other language variations, plus direct `href` extraction.
    * **Direct "Load ↗" and Quick Switch**: Each task in the popup displays a dedicated `Load ↗` button to jump straight to that report view, and a quick switch button `✨ Good URLs (Mobile)` is available in the popup.
    * Cycles through *Mobile* and *Desktop* summaries, Good URLs, and all issue drilldowns.
* **☑️ Interactive Checklist in Popup**:
  * Preview every detected sub-report and drilldown before exporting, with checkboxes to select all or pick specific items, and direct navigation links to any report.
* **📈 Live In-Page Progress Panel**:
  * Shows real-time progress (`Exporting file #3: By response (3/8)...`) with a `Stop` button directly in the bottom-right corner of the GSC page.

---

## 🍎 macOS Silent Downloads Setup

To ensure batch exports run completely in the background on macOS without Chrome opening an OS "Save As" sheet for every file:

1. In Google Chrome, go to **`chrome://settings/downloads`** (or click the *Copy* button inside the extension popup).
2. Ensure **"Ask where to save each file before downloading"** is toggled **OFF**.
3. All exported `.xlsx` and `.zip` files will download directly into your default folder stamped by date (e.g. `Downloads/GSC-Exports-YYYY-MM-DD/`).

---

## 📥 Installation & Updating in Chrome

1. Open **Google Chrome** and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select:
   ```text
   c:\Users\gasto\VS-Code-Projects-folder\GSC-nonAPI-DataDownloader
   ```
   *(If already loaded, click the 🔄 **Reload** icon on the extension card and refresh your Google Search Console tab with `F5`).*

---

## 🏷️ Versioning Strategy

This project follows a strict three-tier versioning system (`MAJOR.MINOR.PATCH`):

* **Patch / 3rd digit (e.g., `3.1.8` → `3.1.9`):** Applied for **cosmetic changes, timing, and platform/browser behavior adjustments** — fine-tuning behavior, adjusting trigger moments, date-stamped folder grouping (`GSC-Exports-YYYY-MM-DD/`), draggable floating button, format synchronization, rows-per-page selection, download dialog suppression, typography/color tweaks, or setting/menu arrangement changes.
* **Medium / 2nd digit (e.g., `3.0.0` → `3.1.0`):** Applied for **medium changes** — introducing new capabilities, new filters, new export formats, or feature additions without rewriting core architecture.
* **Major / 1st digit (e.g., `2.2.0` → `3.0.0`):** Applied for **major changes** — fundamental code rework, major architectural refactoring, or introducing entirely new core feature suites.
