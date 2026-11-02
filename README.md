# GSC non-API Data Downloader

A lightweight, zero-dependency Chrome extension (Manifest V3) that allows **1-click data export and download** from Google Search Console (GSC) reports that are **not supported by the official Search Console API**:
1. **Page Indexing Report** (`/index`, `/index/drilldown`, `/indexation`)
2. **Crawl Stats Report** (`/settings/crawl-stats`)
3. **Core Web Vitals Report** (`/core-web-vitals`, Mobile & Desktop subreports, Drilldowns)

---

## 💡 Why This Extension Exists

The official Google Search Console API only supports Search Analytics (clicks, impressions, ctr, position), Sitemaps, and single-URL inspections. **Google does not provide public API endpoints for Crawl Stats, Core Web Vitals aggregates, or complete Page Indexing failure breakdowns.**

Webmasters and technical SEOs often need to download and archive this data regularly (Crawl Stats data is only retained for 90 days by Google!). This extension bridges that gap without requiring OAuth setup, cloud credentials, or manual clicking through dozens of sub-reports.

---

## 🚀 Key Features

* **📦 1-Click ZIP Bundle Export**:
  * Extracts all visible report tables as cleanly structured individual `.csv` files.
  * Formats numbers and dates cleanly.
  * Adds UTF-8 BOM (`\uFEFF`) so files open immediately in **Microsoft Excel** without character encoding glitches.
  * Includes a consolidated `all_report_data.json` file for automation scripts.
  * Includes a `README_export_summary.txt` with metadata, timestamps, and property URLs.
* **📊 CSVs Only or Raw JSON**:
  * Download individual CSVs or raw structured JSON with 1 click.
* **⚡ Native Google Export Automation**:
  * Programmatically triggers GSC's official "Export" button and clicks "Download CSV" with zero manual menus.
* **🕷️ Comprehensive Crawl Stats Extraction**:
  * Extracts all 4 breakdown tables: **By response** (200, 301, 404, etc.), **By file type** (HTML, Image, JS, CSS, etc.), **By purpose** (Refresh vs Discovery), and **By Googlebot type** (Smartphone, Desktop, Image, PageSpeed, etc.).
  * Extracts Top Summary Cards (Total crawl requests, Total download size, Average response time) and Host Status checks.
* **📑 Page Indexing Extraction**:
  * Extracts Indexed vs Not Indexed summary numbers.
  * Extracts the complete "Why pages aren't indexed" reason table (Reason, Source, Validation, Pages count).
  * Extracts example URLs when viewing drilldowns (up to 1,000 URLs).
* **⚡ Core Web Vitals Extraction**:
  * Extracts Mobile and Desktop status overviews (Poor, Needs Improvement, Good).
  * Extracts issue tables (LCP, INP, CLS) and URL group drilldown tables.
* **🔀 Quick Report Switcher**:
  * One-click navigation buttons to jump directly between Page Indexing, Crawl Stats, and Core Web Vitals for the active property.
* **🪶 Floating 1-Click Button (Optional)**:
  * Injects a subtle, non-intrusive "⚡ 1-Click Export" pill directly inside Google Search Console for instant downloads without even opening the extension popup (can be toggled in settings).

---

## 📥 Installation Guide (Quick 1-Minute Setup)

1. Open **Google Chrome**.
2. In the URL address bar, enter:
   ```text
   chrome://extensions/
   ```
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button in the top left.
5. Select the project folder:
   ```text
   c:\Users\gasto\VS-Code-Projects-folder\GSC-nonAPI-DataDownloader
   ```
6. The **GSC non-API Data Downloader** icon will appear in your Chrome toolbar. Pin it for quick access!

---

## 🖥️ How to Use (First Iteration Workflow)

1. Open [Google Search Console](https://search.google.com/search-console) in Chrome.
2. Navigate to any of the 3 target reports:
   * **Page Indexing**: `https://search.google.com/search-console/index?resource_id=...`
   * **Crawl Stats**: `https://search.google.com/search-console/settings/crawl-stats?resource_id=...`
   * **Core Web Vitals**: `https://search.google.com/search-console/core-web-vitals?resource_id=...`
3. Click the **GSC Data Downloader** extension icon in your Chrome toolbar (or click the floating button at the bottom right).
4. The popup automatically detects:
   * Current Property domain/URL
   * Active Report and View
   * Summary metric chips
   * Detected table inventory and row counts
5. Click **"1-Click Export All (.ZIP)"** (or choose CSV / JSON / Native Google Export).
6. Your browser immediately downloads the complete report bundle!

---

## 📁 Project Structure

```text
GSC-nonAPI-DataDownloader/
├── manifest.json              # Manifest V3 extension configuration
├── popup/
│   ├── popup.html             # Extension action popup interface
│   ├── popup.css              # Material Design 3 inspired styles
│   └── popup.js               # Popup logic & message dispatcher
├── content/
│   ├── content.js             # Core data extraction engine & GSC scraper
│   └── page-injected.css      # Floating button & toast notification styles
├── background/
│   └── background.js          # Service worker for lifecycle & tab management
├── lib/
│   └── zip-writer.js          # Zero-dependency, pure JS ZIP archive builder
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 🏷️ Versioning Strategy

This project follows a strict three-tier versioning system (`MAJOR.MINOR.PATCH`):

* **Patch / 3rd digit (e.g., `1.0.0` → `1.0.1`):** Applied for **cosmetic changes** — the smallest modifications such as styling adjustments, typography/color tweaks, wording fixes, or setting/menu arrangement changes.
* **Medium / 2nd digit (e.g., `1.0.0` → `1.1.0`):** Applied for **medium changes** — introducing new capabilities, new filters, new export formats, or feature additions without rewriting core architecture.
* **Major / 1st digit (e.g., `1.0.0` → `2.0.0`):** Applied for **major changes** — fundamental code rework, major architectural refactoring, or introducing entirely new core feature suites.

---

## 🔒 Security & Privacy

* **Zero external dependencies**: Built in pure vanilla JavaScript without external npm packages or CDNs.
* **100% Client-Side**: All data extraction and ZIP packaging occurs locally in your browser memory. No data is ever transmitted to third-party servers.
* **Respects Authentication**: Operates entirely within your already logged-in Google Search Console session. No passwords, credentials, or API tokens are stored.
