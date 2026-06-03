/**
 * background.js — Manifest V3 Service Worker
 *
 * Responsibilities:
 *  1. Configure the Side Panel to open on toolbar icon click.
 *  2. Manage the lifecycle of the Offscreen Document (clipboard backup polling).
 *  3. Receive CLIPBOARD_CHANGE messages from content.js and offscreen.js.
 *  4. Persist a rolling history of the last 5 clipboard items.
 *  5. Forward new items to the Side Panel (if it is currently open).
 *  6. Manage the toolbar badge as a "new item" indicator.
 */

'use strict';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const MAX_HISTORY = 5;

// ─── Side Panel Configuration ─────────────────────────────────────────────────

// Automatically open the side panel whenever the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[BG] setPanelBehavior failed:', err));

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'CLIPBOARD_CHANGE':
      handleClipboardChange(message)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // keep the message channel open for the async response

    case 'GET_HISTORY':
      chrome.storage.local
        .get({ searchHistory: [] })
        .then(({ searchHistory }) => sendResponse({ history: searchHistory }))
        .catch(() => sendResponse({ history: [] }));
      return true;

    case 'CLEAR_HISTORY':
      chrome.storage.local
        .set({ searchHistory: [], currentItem: null })
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;

    case 'DISMISS_BADGE':
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

// ─── Clipboard Change Handler ─────────────────────────────────────────────────

/**
 * Processes an incoming clipboard change event.
 * De-duplicates against the last known value, then persists the item and
 * notifies the side panel.
 *
 * @param {object} clipboardData - { data, contentType, timestamp, source? }
 */
async function handleClipboardChange(clipboardData) {
  const { data, contentType, timestamp } = clipboardData;

  if (!data || !String(data).trim()) return;

  // De-duplicate: ignore if identical to the last stored item
  const { lastClipboard = null } = await chrome.storage.local.get('lastClipboard');
  if (lastClipboard && lastClipboard.data === data) return;

  const newItem = {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    // Truncate very long text to avoid filling storage
    data: contentType === 'text' ? String(data).slice(0, 1000) : data,
    contentType: contentType || 'text',
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
    query: contentType === 'text' ? String(data).slice(0, 150) : '[Image]',
  };

  // Persist history (rolling window of MAX_HISTORY items)
  const { searchHistory = [] } = await chrome.storage.local.get('searchHistory');
  const updatedHistory = [newItem, ...searchHistory].slice(0, MAX_HISTORY);

  await chrome.storage.local.set({
    searchHistory: updatedHistory,
    lastClipboard: newItem,
    currentItem: newItem,
  });

  // Badge: show a blue dot to indicate new content
  await chrome.action.setBadgeText({ text: '●' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#4285F4' }).catch(() => {});

  // Forward to side panel — fails silently when the panel is not open
  chrome.runtime.sendMessage({ type: 'NEW_CLIPBOARD_ITEM', item: newItem }).catch(() => {});
}

// ─── Offscreen Document Lifecycle ─────────────────────────────────────────────

/**
 * Ensures exactly one offscreen document exists for clipboard backup polling.
 * The content script handles primary copy detection; the offscreen document
 * acts as a secondary monitor (e.g., copies made in non-web contexts or PDFs).
 */
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification:
        'Polls navigator.clipboard.readText() as a fallback detector ' +
        'for copies made outside normal web page contexts.',
    });
    console.log('[BG] Offscreen document created.');
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

ensureOffscreenDocument().catch((err) =>
  console.warn('[BG] Could not create offscreen document:', err)
);

// Recreate the offscreen document each time the service worker wakes up
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch(console.warn);
});
