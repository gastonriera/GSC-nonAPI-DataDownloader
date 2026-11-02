# GSC non-API Data Downloader (`v3.0.0`)

A property-agnostic Chrome extension (Manifest V3) that automates **1-click native file exports (`Download Excel` / `Download CSV`)** across Google Search Console reports and all of their sub-reports/drilldowns:
1. **Page Indexing Report** (`/index` — exports Indexed Pages + cycles through every reason in *"Why pages aren't indexed"*)
2. **Crawl Stats Report** (`/settings/crawl-stats` — major rework with universal multilingual 25-row pagination expansion; exports the main 90-day overview chart, all 4 breakdown tables [*By response*, *By file type*, *By purpose*, *By Googlebot type*], Host status options [*Robots.txt fetch*, *DNS resolution*, *Server connectivity*], and the Hosts table)
3. **Core Web Vitals Report** (`/core-web-vitals` — opens *Mobile* and *Desktop* reports, exports their summaries, exports *Good URLs*, and cycles through every issue drilldown)

---

## 💡 Why This Extension Exists

The official Google Search Console API does not provide endpoints for Crawl Stats, Core Web Vitals aggregates, or full Page Indexing drilldowns. In the GSC web interface, downloading all of these requires manually clicking into dozens of sub-reports and clicking `Export` → `Download Excel` one by one.

**GSC non-API Data Downloader (`v3.0.0`)** automates that entire process with a single click—regardless of which domain, language, or property type is open—downloading the official Google Search Console `.xlsx` (or `.zip` CSV) files and organizing them into a clean folder in your `Downloads` directory.

---

## 🚀 Key Features (`v3.0.0`)

* **🌐 100% Property- & Language-Agnostic**:
  * Works on any GSC property (Domain property, URL-prefix property, subfolder, etc.) without inspecting or depending on the domain name.
  * Fully supports multilingual interfaces (English, Spanish, French, German, Italian, Portuguese, etc.), matching localized navigation, headings, and pagination controls.
* **📊 Native Excel (`.xlsx`) & CSV (`.zip`) Export**:
  * Triggers Google Search Console's official `Export` → `Download Excel` (default) or `Download CSV` menu option on each report.
* **🔄 Automated Sub-Report & Drilldown Crawler**:
  * **Page Indexing**: Clicks into *"View data about indexed pages"* and each row in *"Why pages aren't indexed"*, triggers the native export on each drilldown, and navigates back automatically.
  * **Crawl Stats (Reworked in v3.0.0)**:
    * **Universal 25-Row Pagination Expansion**: At the very start, automatically detects and expands every pagination block across all breakdown cards and tables to **25 rows per page** via universal range and combobox detection, exposing all available data rows.
    * **Includes All Page Options**: Discovers and exports the main 90-day overview chart, all rows across the 4 breakdown categories (*By response*, *By file type*, *By purpose*, *By Googlebot type*), Host status options (*Robots.txt fetch*, *DNS resolution*, *Server connectivity*), and the Hosts table.
  * **Core Web Vitals**: Opens *Mobile* and *Desktop* reports, exports their summaries, exports the dedicated **Good URLs** report (passing pages), and cycles through every CWV issue drilldown.
* **☑️ Interactive Checklist in Popup**:
  * Preview every detected sub-report and drilldown before exporting, with checkboxes to select all or pick specific items.
* **📁 Automatic File Naming & Subfolder Organization**:
  * Saves all downloaded files into `Downloads/GSC-Exports/<date>/` with descriptive, numbered filenames (e.g., `01_Crawl_Stats__Overview.xlsx`, `02_Crawl_Stats__Host_status__Robots_txt_fetch.xlsx`, `03_Crawl_Stats__By_response__200_OK.xlsx`) so files never overwrite each other and are ready to be merged by a Python script.
* **📈 Live In-Page Progress Panel**:
  * Shows real-time progress (`Exporting 3 of 12...`) with a `Stop` button directly in the bottom-right corner of the GSC page.

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

* **Patch / 3rd digit (e.g., `1.0.0` → `1.0.1`):** Applied for **cosmetic changes** — the smallest modifications such as styling adjustments, typography/color tweaks, wording fixes, or setting/menu arrangement changes.
* **Medium / 2nd digit (e.g., `1.0.0` → `1.1.0`):** Applied for **medium changes** — introducing new capabilities, new filters, new export formats, or feature additions without rewriting core architecture.
* **Major / 1st digit (e.g., `2.2.0` → `3.0.0`):** Applied for **major changes** — fundamental code rework, major architectural refactoring, or introducing entirely new core feature suites.
