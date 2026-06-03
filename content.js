/**
 * content.js — Injected into every web page (all_frames: false)
 *
 * Primary clipboard detection strategy:
 *  - Listens for the native DOM `copy` and `cut` events.
 *  - `event.clipboardData` is populated by the browser at the moment of the
 *    copy action, giving us direct, permission-free access to the copied data.
 *  - For text: reads `text/plain` or falls back to window.getSelection().
 *  - For images: detects a MIME type starting with "image/" and signals the
 *    background without transmitting raw image bytes (avoids message-size limits).
 *
 * A 150 ms debounce prevents duplicate messages on rapid copy sequences.
 */

'use strict';

let lastSentData = null;
let debounceTimer = null;

document.addEventListener('copy', onCopyOrCut, true);
document.addEventListener('cut', onCopyOrCut, true);

function onCopyOrCut(event) {
  clearTimeout(debounceTimer);
  // Capture event reference before the async debounce fires
  const clipboardData = event.clipboardData;
  const selection = window.getSelection()?.toString()?.trim() || '';

  debounceTimer = setTimeout(() => {
    processCopy(clipboardData, selection);
  }, 150);
}

/**
 * Decides whether the copied content is text or image and dispatches
 * an appropriate message to the background service worker.
 *
 * @param {DataTransfer|null} clipboardData
 * @param {string} selection - Current window text selection (fallback)
 */
function processCopy(clipboardData, selection) {
  if (!clipboardData) {
    // Fallback: no DataTransfer available — use selection
    if (selection && selection !== lastSentData) {
      lastSentData = selection;
      sendToBackground({
        type: 'CLIPBOARD_CHANGE',
        contentType: 'text',
        data: selection,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // ── Image detection ──────────────────────────────────────────────────────
  const items = Array.from(clipboardData.items || []);
  const imageItem = items.find((item) => item.type.startsWith('image/'));

  if (imageItem) {
    const sentinel = `__image__${Date.now()}`;
    if (sentinel === lastSentData) return; // Should not happen, but guard anyway
    lastSentData = sentinel;

    // Do NOT send raw image bytes — they can exceed the 64 MB message limit.
    // The side panel will show a "use Google Lens" prompt instead.
    sendToBackground({
      type: 'CLIPBOARD_CHANGE',
      contentType: 'image',
      data: '[Image copied]',
      timestamp: Date.now(),
    });
    return;
  }

  // ── Text detection ───────────────────────────────────────────────────────
  const text =
    (clipboardData.getData('text/plain') || selection).trim();

  if (text && text !== lastSentData) {
    lastSentData = text;
    sendToBackground({
      type: 'CLIPBOARD_CHANGE',
      contentType: 'text',
      data: text,
      timestamp: Date.now(),
    });
  }
}

/**
 * Sends a message to the background service worker.
 * Swallows errors that occur when the extension reloads mid-session.
 *
 * @param {object} message
 */
function sendToBackground(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    // "Extension context invalidated" is expected after a hot reload — ignore.
    if (!err?.message?.includes('Extension context invalidated')) {
      console.warn('[InstantSearch CS] Failed to send message:', err);
    }
  });
}
