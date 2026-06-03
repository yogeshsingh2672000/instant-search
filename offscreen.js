/**
 * offscreen.js — Offscreen Document Script
 *
 * Reason: chrome.offscreen.Reason.CLIPBOARD
 *
 * This script polls `navigator.clipboard.readText()` every 2 seconds as a
 * secondary detection path. It catches copies made in contexts where the
 * content script is not injected (e.g., the Chrome New Tab page, PDF viewer,
 * extension pages, or desktop applications).
 *
 * The content script `copy` event is the primary (zero-latency) path.
 * Both paths send identical CLIPBOARD_CHANGE messages; the background service
 * worker de-duplicates them automatically.
 */

'use strict';

const POLL_INTERVAL_MS = 2000;

let lastKnownText = '';
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Attempts to read the clipboard text.
 * If it has changed since the last poll, notifies the background service worker.
 */
async function pollClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    consecutiveErrors = 0; // reset on success

    const trimmed = (text || '').trim();
    if (trimmed && trimmed !== lastKnownText) {
      lastKnownText = trimmed;
      chrome.runtime.sendMessage({
        type: 'CLIPBOARD_CHANGE',
        contentType: 'text',
        data: trimmed,
        timestamp: Date.now(),
        source: 'offscreen',
      }).catch(() => {
        // Background may be temporarily unavailable during reload — ignore.
      });
    }
  } catch {
    // navigator.clipboard.readText() can fail when:
    //   • The clipboard contains non-text data (image, file, etc.)
    //   • The clipboard is empty
    //   • The browser blocks the read for security reasons
    // These are expected and not actionable — suppress the error.
    consecutiveErrors++;

    // If we keep getting errors, back off to avoid log spam
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Errors are expected — just wait for the next interval
      consecutiveErrors = 0;
    }
  }
}

// Start polling immediately, then repeat on the defined interval
pollClipboard();
setInterval(pollClipboard, POLL_INTERVAL_MS);
