# GSC non-API Data Downloader (`v2.0.1`)

A property-agnostic Chrome extension (Manifest V3) that automates **1-click native file exports (`Download Excel` / `Download CSV`)** across Google Search Console reports and all of their sub-reports/drilldowns:
1. **Page Indexing Report** (`/index` — exports Indexed Pages + cycles through every reason in *"Why pages aren't indexed"*)
2. **Crawl Stats Report** (`/settings/crawl-stats` — exports the main 90-day overview + cycles through all 4 breakdown tables: *By response*, *By file type*, *By purpose*, and *By Googlebot type*)
3. **Core Web Vitals Report** (`/core-web-vitals` — opens *Mobile* and *Desktop* reports and exports their summaries + every issue drilldown)

---

## 💡 Why This Extension Exists

The official Google Search Console API does not provide endpoints for Crawl Stats, Core Web Vitals aggregates, or full Page Indexing drilldowns. In the GSC web interface, downloading all of these requires manually clicking into dozens of sub-reports and clicking `Export` → `Download Excel` one by one.

**GSC non-API Data Downloader (`v2.0.1`)** automates that entire process with a single click—regardless of which domain or property type is open—downloading the official Google Search Console `.xlsx` (or `.zip` CSV) files and organizing them into a clean folder in your `Downloads` directory.

---

## 🚀 Key Features (`v2.0.1`)

* **🌐 100% Property-Agnostic**:
  * Works on any GSC property (Domain property, URL-prefix property, subfolder, etc.) without inspecting or depending on the domain name.
* **📊 Native Excel (`.xlsx`) & CSV (`.zip`) Export**:
  * Triggers Google Search Console's official `Export` → `Download Excel` (default) or `Download CSV` menu option on each report.
* **🔄 Automated Sub-Report & Drilldown Crawler**:
  * **Page Indexing**: Clicks into *"View data about indexed pages"* and each row in *"Why pages aren't indexed"*, triggers the native export on each drilldown, and navigates back automatically.
  * **Crawl Stats**: Exports the main 90-day overview charts first, then clicks into every breakdown row (*By response*, *By file type*, *By purpose*, *By Googlebot type*) to export each sub-report's daily chart and example URLs.
  * **Core Web Vitals**: Opens both *Mobile* and *Desktop* reports, exports their summaries, and cycles through every CWV issue drilldown.
* **☑️ Interactive Checklist in Popup**:
  * Preview every detected sub-report and drilldown before exporting, with checkboxes to select all or pick specific items.
* **📁 Automatic File Naming & Subfolder Organization**:
  * Saves all downloaded files into `Downloads/GSC-Exports/<date>/` with descriptive, numbered filenames (e.g., `01_Page_Indexing__Indexed_Pages.xlsx`, `02_Page_Indexing__Not_found_404.xlsx`) so files never overwrite each other and are ready to be merged by a Python script.
* **📈 Live In-Page Progress Panel**:
  * Shows real-time progress (`Exporting 3 of 8...`) with a `Stop` button directly in the bottom-right corner of the GSC page.

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
* **Major / 1st digit (e.g., `1.0.1` → `2.0.0`):** Applied for **major changes** — fundamental code rework, major architectural refactoring, or introducing entirely new core feature suites.
