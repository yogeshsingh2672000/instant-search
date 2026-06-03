# Instant Search — Chrome Extension

A production-ready **Manifest V3** Chrome Extension that monitors your clipboard and instantly surfaces search results inside the native Chrome **Side Panel** whenever you copy text.

---

## Project Structure

```
instant-search/
├── manifest.json          ← MV3 manifest (permissions, entry points)
├── background.js          ← Service Worker: lifecycle + message routing
├── content.js             ← Injected script: DOM copy/cut event listener
├── offscreen.html         ← Invisible DOM context (clipboard backup polling)
├── offscreen.js           ← navigator.clipboard.readText() poller
├── sidepanel.html         ← Side Panel markup
├── sidepanel.css          ← Side Panel styles
├── sidepanel.js           ← Side Panel controller (search, history, UI)
├── icons/
│   ├── icon16.png         ← Required (generate with tools/generate-icons.html)
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── tools/
    └── generate-icons.html  ← One-click PNG icon generator (open in browser)
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web Page (any tab)                                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  content.js                                                  │   │
│  │  Listens: document copy / cut events                         │   │
│  │  Extracts: text/plain or image flag from event.clipboardData │   │
│  └──────────────────────┬─────────────────────────────────────-┘   │
└─────────────────────────┼────────────────────────────────────────────┘
                          │ chrome.runtime.sendMessage
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  background.js (Service Worker)                                     │
│  • De-duplicates incoming items                                     │
│  • Persists rolling history (max 5) to chrome.storage.local         │
│  • Sets toolbar badge (●) to alert user                             │
│  • Broadcasts NEW_CLIPBOARD_ITEM to side panel (if open)            │
│  • Manages offscreen document lifecycle                             │
└──────┬────────────────────────────────────────────────────┬─────────┘
       │ createDocument / getContexts                       │ sendMessage
       ▼                                                    ▼
┌──────────────────┐                          ┌─────────────────────────┐
│  offscreen.js    │                          │  sidepanel.js           │
│  Backup polling: │  chrome.runtime          │  • Receives messages    │
│  readText() q2s  │─────────────────────────▶│  • Reads storage        │
└──────────────────┘                          │  • Fetches DDG API      │
                                              │  • Renders results      │
                                              │  • Shows history        │
                                              └─────────────────────────┘
```

### Why two clipboard detection paths?

| Path                      | Mechanism                                          | Coverage                                                                         |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| **content.js** (primary)  | DOM `copy`/`cut` event → `event.clipboardData`     | All normal web page copies, zero latency                                         |
| **offscreen.js** (backup) | `navigator.clipboard.readText()` polling every 2 s | Copies from Chrome's own pages (New Tab, Settings), PDFs, other non-web contexts |

The background service worker de-duplicates both paths, so an item is never processed twice.

---

## Search Results

Google blocks all third-party iframes via `X-Frame-Options: SAMEORIGIN`, making Google Search un-embeddable. Instead, the extension uses the **DuckDuckGo Instant Answer API** (free, no API key, CORS-enabled) to display structured results inline:

- **Instant Answer** — calculations, conversions, fast facts
- **Definition** — dictionary / Wiktionary entries
- **Abstract** — Wikipedia / knowledge-base summary with thumbnail
- **Related Topics** — up to 5 linked subtopics

For queries with no instant data, prominent **Search Google / DuckDuckGo / Bing** buttons are shown. For image copies, a direct **Google Lens** link is provided.

---

## Step 1 — Generate Icons

1. Open `tools/generate-icons.html` in any browser (double-click the file).
2. Click **Generate & Download Icons**.
3. Four PNG files (`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`) will download automatically.
4. Move all four files into the `icons/` folder inside this extension directory.

```
instant-search/
└── icons/
    ├── icon16.png   ✓
    ├── icon32.png   ✓
    ├── icon48.png   ✓
    └── icon128.png  ✓
```

---

## Step 2 — Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `instant-search/` folder (the root folder containing `manifest.json`).
5. The extension will appear in your extensions list.

> **Tip:** Pin the extension to your toolbar by clicking the puzzle-piece icon → Pin next to "Instant Search".

---

## Step 3 — Use the Extension

1. Click the **Instant Search** icon in the toolbar to open the Side Panel.
2. **Copy any text** on any webpage — the side panel will immediately:
   - Display the copied text in the "Copied" card.
   - Run a DuckDuckGo Instant Answer search.
   - Show structured results (or search-engine links as a fallback).
   - Log the item to the 5-item history at the bottom.
3. A blue **●** badge appears on the toolbar icon when a new item is detected (even if the panel is closed). Click the icon to open the panel and dismiss it.
4. Use the **search bar** at the top to run manual queries at any time.
5. Click any **history row** or its arrow button to re-run that search.
6. Click **Clear all** to reset history.

---

## Permissions Explained

| Permission                                       | Why it's needed                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `clipboardRead`                                  | Allows the offscreen document to call `navigator.clipboard.readText()` for backup polling |
| `sidePanel`                                      | Required to register and open the Chrome Side Panel                                       |
| `offscreen`                                      | Required to create the invisible offscreen document                                       |
| `storage`                                        | Persists clipboard history and current item across panel open/close cycles                |
| `activeTab`                                      | Reserved for future use; needed if `sidePanel.open({ tabId })` is called                  |
| `host_permissions: https://api.duckduckgo.com/*` | Allows the side panel to fetch instant-answer results from the DDG API                    |

---

## Reloading After Code Changes

1. Go to `chrome://extensions`.
2. Click the **refresh icon** (↺) on the Instant Search card.
3. Reload any open tabs to pick up content script changes.

---

## Known Limitations

| Limitation                              | Details                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Side panel cannot auto-open             | MV3 restricts `chrome.sidePanel.open()` to user-gesture contexts. The panel must be opened manually once; after that it stays open and updates automatically. |
| Google Search cannot be embedded        | `X-Frame-Options` blocks Google iframes everywhere. DDG Instant Answers + direct links are used instead.                                                      |
| Image reverse search                    | Raw image bytes are not forwarded through the extension messaging bus (size limits). Google Lens is linked instead, and the user pastes the image there.      |
| Clipboard polling blocked on some pages | `navigator.clipboard.readText()` is rejected on pages that do not grant clipboard permission. The content script `copy` event covers these cases.             |
