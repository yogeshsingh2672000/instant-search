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

const POPUP_ID = 'instant-search-approve-popup';
const POPUP_LIFETIME_MS = 9000;
const DEDUPE_WINDOW_MS = 1200;

let lastPromptSignature = '';
let lastPromptAt = 0;
let debounceTimer = null;
let popupTimer = null;

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
  const now = Date.now();

  if (!clipboardData) {
    // Fallback: no DataTransfer available — use selection
    if (selection && shouldShowPrompt(`text:${selection}`, now)) {
      showApprovalPopup({
        contentType: 'text',
        data: selection,
        timestamp: now,
      });
    }
    return;
  }

  // ── Image detection ──────────────────────────────────────────────────────
  const items = Array.from(clipboardData.items || []);
  const imageItem = items.find((item) => item.type.startsWith('image/'));

  if (imageItem) {
    if (!shouldShowPrompt('image:[Image copied]', now)) return;

    showApprovalPopup({
      contentType: 'image',
      data: '[Image copied]',
      timestamp: now,
    });
    return;
  }

  // ── Text detection ───────────────────────────────────────────────────────
  const text =
    (clipboardData.getData('text/plain') || selection).trim();

  if (text && shouldShowPrompt(`text:${text}`, now)) {
    showApprovalPopup({
      contentType: 'text',
      data: text,
      timestamp: now,
    });
  }
}

function shouldShowPrompt(signature, now) {
  if (
    signature === lastPromptSignature &&
    now - lastPromptAt < DEDUPE_WINDOW_MS
  ) {
    return false;
  }
  lastPromptSignature = signature;
  lastPromptAt = now;
  return true;
}

/**
 * Renders a compact, dismissible popup asking the user to approve the search.
 * Search/history happen only when the user clicks "Search".
 *
 * @param {{contentType:string,data:string,timestamp:number}} payload
 */
function showApprovalPopup(payload) {
  removeApprovalPopup();

  const root = document.createElement('div');
  root.id = POPUP_ID;

  const preview = payload.contentType === 'image'
    ? 'Image copied'
    : truncateText(payload.data, 80);

  root.innerHTML = `
    <style>
      #${POPUP_ID} {
        all: initial;
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 320px;
        max-width: calc(100vw - 24px);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        color: #202124;
      }
      #${POPUP_ID} .box {
        background: #fff;
        border: 1px solid #dadce0;
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,.18);
        padding: 12px;
      }
      #${POPUP_ID} .title {
        font-size: 12px;
        color: #5f6368;
        margin-bottom: 6px;
      }
      #${POPUP_ID} .preview {
        font-size: 13px;
        line-height: 1.4;
        margin-bottom: 10px;
        word-break: break-word;
      }
      #${POPUP_ID} .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      #${POPUP_ID} button {
        font: inherit;
        border: 1px solid #dadce0;
        background: #fff;
        color: #1f1f1f;
        border-radius: 999px;
        padding: 6px 12px;
        cursor: pointer;
      }
      #${POPUP_ID} button.primary {
        border-color: #1a73e8;
        background: #1a73e8;
        color: #fff;
      }
      #${POPUP_ID} button:hover {
        filter: brightness(0.97);
      }
    </style>
    <div class="box" role="dialog" aria-live="polite" aria-label="Clipboard search confirmation">
      <div class="title">Search copied ${escapeHtml(payload.contentType)}?</div>
      <div class="preview">${escapeHtml(preview)}</div>
      <div class="actions">
        <button type="button" data-action="dismiss">Not now</button>
        <button type="button" class="primary" data-action="approve">Search</button>
      </div>
    </div>`;

  const approveBtn = root.querySelector('[data-action="approve"]');
  const dismissBtn = root.querySelector('[data-action="dismiss"]');

  approveBtn?.addEventListener('click', () => {
    sendToBackground({
      type: 'CLIPBOARD_APPROVED',
      contentType: payload.contentType,
      data: payload.data,
      timestamp: payload.timestamp,
    });
    removeApprovalPopup();
  });

  dismissBtn?.addEventListener('click', () => {
    removeApprovalPopup();
  });

  document.documentElement.appendChild(root);

  clearTimeout(popupTimer);
  popupTimer = setTimeout(removeApprovalPopup, POPUP_LIFETIME_MS);
}

function removeApprovalPopup() {
  clearTimeout(popupTimer);
  const existing = document.getElementById(POPUP_ID);
  if (existing) existing.remove();
}

function truncateText(str, maxLen) {
  const value = String(str || '').trim();
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
