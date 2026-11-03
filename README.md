# GSC non-API Data Downloader (`v3.1.3`)

A property-agnostic Chrome extension (Manifest V3) that automates **1-click native file exports (`Download Excel` / `Download CSV`)** across Google Search Console reports and all of their sub-reports/drilldowns:
1. **Page Indexing Report** (`/index` — exports Indexed Pages + cycles through every reason in *"Why pages aren't indexed"*)
2. **Crawl Stats Report** (`/settings/crawl-stats` — universal multilingual 25-row pagination expansion triggered strictly upon clicking the Export button; exports the main 90-day overview chart, all 4 breakdown tables [*By response*, *By file type*, *By purpose*, *By Googlebot type*], Host status options [*Robots.txt fetch*, *DNS resolution*, *Server connectivity*], and the Hosts table)
3. **Core Web Vitals Report** (`/core-web-vitals` — opens *Mobile* and *Desktop* reports, exports summaries, issue drilldowns, and directly loads/exports the canonical **Good URLs** drilldown report for Mobile (`&device=2`) and Desktop (`&device=1`))

---

## 💡 Why This Extension Exists

The official Google Search Console API does not provide endpoints for Crawl Stats, Core Web Vitals aggregates, or full Page Indexing drilldowns. In the GSC web interface, downloading all of these requires manually clicking into dozens of sub-reports and clicking `Export` → `Download Excel` one by one.

**GSC non-API Data Downloader (`v3.1.3`)** automates that entire process with a single click—regardless of which domain, language, or property type is open—downloading the official Google Search Console `.xlsx` (or `.zip` CSV) files and organizing them into a clean folder in your `Downloads` directory without interrupting dialogs.

---

## 🚀 Key Features (`v3.1.3`)

* **🌐 100% Property- & Language-Agnostic**:
  * Works on any GSC property (Domain property, URL-prefix property, subfolder, etc.) without inspecting or depending on the domain name.
  * Fully supports multilingual interfaces (English, Spanish, French, German, Italian, Portuguese, etc.), matching localized navigation, headings, and pagination controls.
* **⚡ Silent Downloads & macOS Save Dialog Prevention**:
  * **Automatic Multi-File Downloads**: Grants `contentSettings.automaticDownloads` permission to `https://search.google.com/*`, permanently preventing Chrome from prompting *"This site is attempting to download multiple files. Allow / Block"*.
  * **Zero Collision Prompts**: Enforces `conflictAction: 'uniquify'` on all Google Search Console exports so Chrome never prompts to overwrite or pick duplicate filenames.
  * **Dedicated macOS Helper & Quick Settings**: Popup detects macOS and displays a 1-click shortcut to disable Chrome's global *"Ask where to save each file before downloading"* toggle (`chrome://settings/downloads`).
  * **Configurable Subfolder Organization**: Toggle between nested folders (`Downloads/GSC-Exports/<date>/`) and direct flat downloads in your root `Downloads/` folder.
* **📊 Native Excel (`.xlsx`) & CSV (`.zip`) Export**:
  * Triggers Google Search Console's official `Export` → `Download Excel` (default) or `Download CSV` menu option on each report.
* **🔄 Automated Sub-Report & Drilldown Crawler**:
  * **Page Indexing**: Clicks into *"View data about indexed pages"* and each row in *"Why pages aren't indexed"*, triggers the native export on each drilldown, and navigates back automatically.
  * **Crawl Stats (Reworked in v3.1.3)**:
    * **Reworked 25-Row Pagination Selection**: Scopes option matching directly inside Angular Material CDK overlay panels (`.cdk-overlay-pane`, `mat-select-panel`, `[role="listbox"]`), preventing table cells or other page elements from intercepting clicks.
    * **Reliable Option Activation**: Dispatches complete pointer (`pointerdown`, `pointerup`), mouse (`mousedown`, `mouseup`, `click`), and keyboard (`Enter`, `Space`) event sequences on both the `<mat-option>` host and inner text spans without disruptive window scrolling that could dismiss overlays.
    * **Includes All Page Options**: Discovers and exports the main 90-day overview chart, all rows across the 4 breakdown categories (*By response*, *By file type*, *By purpose*, *By Googlebot type*), Host status options (*Robots.txt fetch*, *DNS resolution*, *Server connectivity*), and the Hosts table.
  * **Core Web Vitals**:
    * **Canonical Good URLs Drilldown Loading**: When selecting *"View data about good URLs"*, the extension directly loads the exact canonical report URL (`/core-web-vitals/drilldown?resource_id=<property>&device=2` for Mobile, or `device=1` for Desktop).
    * **Multilingual Good URLs Detection**: Matches English (*"View data about good URLs"*), Spanish (*"Ver datos sobre las URLs correctas"*, *"URLs correctas"*), and other language variations, plus direct `href` extraction.
    * **Direct "Load ↗" and Quick Switch**: Each task in the popup displays a dedicated `Load ↗` button to jump straight to that report view, and a quick switch button `✨ Good URLs (Mobile)` is available in the popup.
    * Cycles through *Mobile* and *Desktop* summaries, Good URLs, and all issue drilldowns.
* **☑️ Interactive Checklist in Popup**:
  * Preview every detected sub-report and drilldown before exporting, with checkboxes to select all or pick specific items, and direct navigation links to any report.
* **📈 Live In-Page Progress Panel**:
  * Shows real-time progress (`Exporting 3 of 12...`) with a `Stop` button directly in the bottom-right corner of the GSC page.

---

## 🍎 macOS Silent Downloads Setup

To ensure batch exports run completely in the background on macOS without Chrome opening an OS "Save As" sheet for every file:

1. In Google Chrome, go to **`chrome://settings/downloads`** (or click the *Copy* button inside the extension popup).
2. Ensure **"Ask where to save each file before downloading"** is toggled **OFF**.
3. All exported `.xlsx` and `.zip` files will download directly into your default folder (e.g. `Downloads/GSC-Exports/<date>/`).

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

* **Patch / 3rd digit (e.g., `3.1.2` → `3.1.3`):** Applied for **cosmetic changes, timing, and platform/browser behavior adjustments** — fine-tuning behavior, adjusting trigger moments, rows-per-page selection, download dialog suppression, typography/color tweaks, or setting/menu arrangement changes.
* **Medium / 2nd digit (e.g., `3.0.0` → `3.1.0`):** Applied for **medium changes** — introducing new capabilities, new filters, new export formats, or feature additions without rewriting core architecture.
* **Major / 1st digit (e.g., `2.2.0` → `3.0.0`):** Applied for **major changes** — fundamental code rework, major architectural refactoring, or introducing entirely new core feature suites.
