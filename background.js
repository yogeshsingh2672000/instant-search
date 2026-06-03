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
    case 'CLIPBOARD_APPROVED':
      handleClipboardApproved(message, _sender)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // keep the message channel open for the async response

    case 'SEARCH_DDG':
      searchDuckDuckGo(message.query)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'SEARCH_OPENAI':
      searchWithOpenAI(message.query, message.apiKey)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

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

/**
 * Processes only user-approved clipboard items from the content-script popup.
 *
 * @param {object} message - clipboard payload from content.js
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleClipboardApproved(message, sender) {
  await tryOpenSidePanel(sender?.tab?.id);
  await handleClipboardChange(message);
}

/**
 * Attempts to open the side panel for the active tab. This may fail on some
 * Chrome versions or contexts; in those cases we silently continue.
 *
 * @param {number|undefined} tabId
 */
async function tryOpenSidePanel(tabId) {
  if (!tabId || !chrome.sidePanel?.open) return;
  try {
    await chrome.sidePanel.open({ tabId });
  } catch {
    // Opening side panel is best-effort only.
  }
}

/**
 * Fetches DuckDuckGo Instant Answer JSON from the service worker.
 * Using background fetch avoids panel-context CORS inconsistencies.
 *
 * @param {string} query
 */
async function searchDuckDuckGo(query) {
  if (!query || !String(query).trim()) {
    throw new Error('Query is required');
  }

  const url =
    'https://api.duckduckgo.com/?q=' +
    encodeURIComponent(String(query)) +
    '&format=json&no_redirect=1&no_html=1&skip_disambig=1';

  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo API error: ${res.status}`);
  }

  return res.json();
}

/**
 * Fetches an LLM answer for the given query using the OpenAI Responses API.
 *
 * @param {string} query
 * @param {string} apiKey
 */
async function searchWithOpenAI(query, apiKey) {
  const cleanQuery = String(query || '').trim();
  const cleanKey = String(apiKey || '').trim();

  if (!cleanQuery) {
    throw new Error('Query is required');
  }

  if (!cleanKey) {
    throw new Error('OpenAI API key is required');
  }

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cleanKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      max_output_tokens: 500,
      input: [
        {
          role: 'system',
          content:
            'You summarize web-search intent. Return concise markdown with: ' +
            '1) quick answer, 2) key points, 3) suggested search terms, ' +
            '4) 3 reputable sources to check.',
        },
        {
          role: 'user',
          content: `User query: ${cleanQuery}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const details = await safeReadText(res);
    throw new Error(`OpenAI API error: ${res.status} ${details}`.trim());
  }

  const data = await res.json();
  const outputText = extractOpenAIText(data);

  if (!outputText) {
    throw new Error('OpenAI returned an empty response');
  }

  return { outputText };
}

/**
 * Attempts to extract the final text from different Responses API shapes.
 *
 * @param {any} data
 */
function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  const outputs = Array.isArray(data?.output) ? data.output : [];

  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      const textValue =
        typeof c?.text === 'string'
          ? c.text
          : typeof c?.value === 'string'
            ? c.value
            : '';
      if (textValue.trim()) {
        chunks.push(textValue.trim());
      }
    }
  }

  return chunks.join('\n\n').trim();
}

/**
 * Reads response body safely for better error messages.
 *
 * @param {Response} res
 */
async function safeReadText(res) {
  try {
    const text = await res.text();
    return text.slice(0, 240);
  } catch {
    return '';
  }
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
