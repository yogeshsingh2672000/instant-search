/**
 * sidepanel.js — Side Panel UI Controller
 *
 * Responsibilities:
 *  1. On load: restore last clipboard item + full history from chrome.storage.
 *  2. Listen for NEW_CLIPBOARD_ITEM messages pushed by background.js.
 *  3. On new item: update the "Copied" card, trigger a DuckDuckGo search,
 *     and re-render the history list.
 *  4. Handle manual search input (keyboard Enter or arrow button).
 *  5. Render structured DDG Instant Answer results (answer, definition,
 *     abstract, related topics). Gracefully fall back when no results exist.
 *  6. Provide one-click links to Google, DuckDuckGo, and Bing.
 *  7. Clear-history button, history item re-search, and badge dismissal.
 *
 * Google Search iframe note:
 *   Google sets `X-Frame-Options: SAMEORIGIN` on all search result pages,
 *   making them impossible to embed in an iframe. This UI instead uses the
 *   DuckDuckGo Instant Answer JSON API (free, CORS-enabled) to surface
 *   structured results inline, while providing prominent "Open in Google"
 *   links for full results.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const DDG_API = 'https://api.duckduckgo.com/';
const DDG_TIMEOUT_MS = 8000;

// ─── DOM References ───────────────────────────────────────────────────────────

const $  = (id) => document.getElementById(id);

const statusDot        = $('status-dot');
const statusLabel      = $('status-label');
const manualInput      = $('manual-input');
const searchBarBtn     = $('search-bar-btn');
const currentSection   = $('current-section');
const contentTypeBadge = $('content-type-badge');
const queryDisplay     = $('query-display');
const resultsSection   = $('results-section');
const engineLinks      = $('engine-links');
const loadingState     = $('loading-state');
const resultsContainer = $('results-container');
const historyList      = $('history-list');
const clearBtn         = $('clear-btn');

// ─── State ────────────────────────────────────────────────────────────────────

let activeItemId = null; // id of the currently displayed item

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
  setStatus('active', 'Monitoring');

  // Dismiss badge now that the panel is open
  chrome.runtime.sendMessage({ type: 'DISMISS_BADGE' }).catch(() => {});

  // Restore state from storage
  const { currentItem, searchHistory = [] } =
    await chrome.storage.local.get(['currentItem', 'searchHistory']);

  renderHistory(searchHistory);

  if (currentItem) {
    displayItem(currentItem, /* autoSearch */ true);
  }
}

// ─── Incoming Message Listener ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NEW_CLIPBOARD_ITEM') {
    displayItem(message.item, /* autoSearch */ true);
    // History is updated in storage by background.js; refresh our list
    chrome.storage.local
      .get({ searchHistory: [] })
      .then(({ searchHistory }) => renderHistory(searchHistory))
      .catch(() => {});
    // Dismiss badge
    chrome.runtime.sendMessage({ type: 'DISMISS_BADGE' }).catch(() => {});
  }
});

// ─── Storage Change Listener ──────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.searchHistory) {
    renderHistory(changes.searchHistory.newValue || []);
  }
});

// ─── Display a Clipboard Item ─────────────────────────────────────────────────

/**
 * Updates the "Copied" card to reflect the given item and optionally kicks off
 * a DuckDuckGo search.
 *
 * @param {{ id: string, data: string, contentType: string, timestamp: number }} item
 * @param {boolean} autoSearch - whether to trigger a search automatically
 */
function displayItem(item, autoSearch = false) {
  activeItemId = item.id;

  currentSection.classList.remove('hidden');
  contentTypeBadge.textContent = item.contentType;
  contentTypeBadge.className   = `badge badge-${item.contentType}`;

  if (item.contentType === 'image') {
    queryDisplay.innerHTML = buildSafeText('[Image copied to clipboard]');
    showImageFallback();
  } else {
    const preview = item.data.length > 300
      ? item.data.slice(0, 300) + '…'
      : item.data;
    queryDisplay.innerHTML = `<span class="query-text">${escapeHtml(preview)}</span>`;

    if (autoSearch) {
      manualInput.value = item.data.slice(0, 150);
      performSearch(item.data);
    }
  }
}

// ─── Manual Search Handlers ───────────────────────────────────────────────────

manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = manualInput.value.trim();
    if (q) performSearch(q);
  }
});

searchBarBtn.addEventListener('click', () => {
  const q = manualInput.value.trim();
  if (q) performSearch(q);
});

// ─── Search Orchestration ─────────────────────────────────────────────────────

/**
 * Updates the search engine links, shows a spinner, fetches DDG results,
 * then renders them (or shows a fallback on error / no results).
 *
 * @param {string} query
 */
async function performSearch(query) {
  if (!query.trim()) return;

  // Update engine shortcut links
  const gUrl   = `https://www.google.com/search?q=${enc(query)}`;
  const ddgUrl = `https://duckduckgo.com/?q=${enc(query)}`;
  const bingUrl= `https://www.bing.com/search?q=${enc(query)}`;

  engineLinks.innerHTML = [
    engineLink(gUrl,    'G',   'Google'),
    engineLink(ddgUrl,  'DDG', 'DuckDuckGo'),
    engineLink(bingUrl, 'B',   'Bing'),
  ].join('');

  // Show results section with spinner
  resultsSection.classList.remove('hidden');
  loadingState.classList.remove('hidden');
  resultsContainer.innerHTML = '';

  setStatus('loading', 'Searching…');

  try {
    const data = await fetchWithTimeout(
      `${DDG_API}?q=${enc(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      DDG_TIMEOUT_MS
    );
    const json = await data.json();
    loadingState.classList.add('hidden');
    setStatus('active', 'Monitoring');
    renderResults(json, query);
  } catch (err) {
    loadingState.classList.add('hidden');
    setStatus('active', 'Monitoring');
    renderErrorState(query);
  }
}

// ─── Result Rendering ─────────────────────────────────────────────────────────

/**
 * Renders structured results from the DuckDuckGo Instant Answer API.
 * Falls back gracefully when the API returns no useful data.
 *
 * @param {object} d   - Parsed DDG JSON response
 * @param {string} query
 */
function renderResults(d, query) {
  const cards = [];

  // ① Instant Answer (e.g. calculations, conversions, unit facts)
  if (d.Answer) {
    cards.push(`
      <div class="result-card answer-card">
        <div class="result-card-label">Instant Answer</div>
        <div class="answer-text">${escapeHtml(d.Answer)}</div>
      </div>`);
  }

  // ② Dictionary / Wiktionary definition
  if (d.Definition) {
    const srcLink = d.DefinitionURL
      ? `<a href="${d.DefinitionURL}" target="_blank" rel="noopener noreferrer" class="result-source">${escapeHtml(d.DefinitionSource || 'Source')} →</a>`
      : '';
    cards.push(`
      <div class="result-card definition-card">
        <div class="result-card-label">Definition</div>
        <p>${escapeHtml(d.Definition)}</p>
        ${srcLink}
      </div>`);
  }

  // ③ Abstract (Wikipedia or another knowledge base)
  if (d.Abstract) {
    const thumbHtml = d.Image
      ? `<img src="${escapeAttr(d.Image)}" alt="" class="result-thumbnail" loading="lazy" />`
      : '';
    const srcLink = d.AbstractURL
      ? `<a href="${d.AbstractURL}" target="_blank" rel="noopener noreferrer" class="result-source">${escapeHtml(d.AbstractSource || 'Source')} →</a>`
      : '';
    cards.push(`
      <div class="result-card">
        <div class="result-card-header">
          ${thumbHtml}
          <div>
            <div class="result-card-title">${escapeHtml(d.Heading || query)}</div>
            ${srcLink}
          </div>
        </div>
        <p class="result-abstract">${escapeHtml(d.Abstract)}</p>
      </div>`);
  }

  // ④ Related topics (up to 5)
  const flatTopics = (d.RelatedTopics || [])
    .flatMap((t) => (t.Topics ? t.Topics : [t]))  // unwrap category groups
    .filter((t) => t.Text && t.FirstURL)
    .slice(0, 5);

  if (flatTopics.length > 0) {
    const topicItems = flatTopics.map((t) => {
      const iconHtml = t.Icon?.URL
        ? `<img src="${escapeAttr(t.Icon.URL)}" alt="" class="topic-icon" loading="lazy" />`
        : '';
      const text = t.Text.length > 110 ? t.Text.slice(0, 110) + '…' : t.Text;
      return `
        <a href="${escapeAttr(t.FirstURL)}" target="_blank" rel="noopener noreferrer" class="related-topic">
          ${iconHtml}
          <span>${escapeHtml(text)}</span>
        </a>`;
    });

    cards.push(`
      <div class="result-card">
        <div class="result-card-label">Related Topics</div>
        <div class="related-topics-grid">${topicItems.join('')}</div>
      </div>`);
  }

  if (cards.length === 0) {
    renderNoResults(query);
    return;
  }

  resultsContainer.innerHTML = cards.join('');
}

function renderNoResults(query) {
  const gUrl   = `https://www.google.com/search?q=${enc(query)}`;
  const ddgUrl = `https://duckduckgo.com/?q=${enc(query)}`;
  resultsContainer.innerHTML = `
    <div class="no-results">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <p>No instant results for this query</p>
      <p class="no-results-sub">Try a full search:</p>
      <div class="action-buttons">
        <a href="${gUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">Search Google</a>
        <a href="${ddgUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">DuckDuckGo</a>
      </div>
    </div>`;
}

function renderErrorState(query) {
  const gUrl = `https://www.google.com/search?q=${enc(query)}`;
  resultsContainer.innerHTML = `
    <div class="error-state">
      <p>Could not load instant results. Check your connection or search directly:</p>
      <div class="action-buttons">
        <a href="${gUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">Search Google</a>
      </div>
    </div>`;
}

function showImageFallback() {
  resultsSection.classList.remove('hidden');
  loadingState.classList.add('hidden');
  engineLinks.innerHTML = '';
  resultsContainer.innerHTML = `
    <div class="result-card image-result-card">
      <div class="result-card-label">Image Detected</div>
      <p>An image was copied to your clipboard.</p>
      <p>For reverse image search, use Google Lens — paste the image there directly:</p>
      <div class="action-buttons" style="margin-top:10px;">
        <a href="https://lens.google.com/" target="_blank" rel="noopener noreferrer" class="btn btn-primary">Open Google Lens</a>
        <a href="https://images.google.com/" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">Google Images</a>
      </div>
    </div>`;
}

// ─── History Rendering ────────────────────────────────────────────────────────

/**
 * Renders the rolling history list.
 * Each item shows: icon, truncated text, relative timestamp, and a re-search button.
 *
 * @param {Array} items
 */
function renderHistory(items) {
  if (!items || items.length === 0) {
    historyList.innerHTML = `
      <div class="empty-state" id="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <p class="empty-title">No searches yet</p>
        <p class="empty-sub">Copy any text to trigger an instant search</p>
      </div>`;
    return;
  }

  historyList.innerHTML = items.map((item) => {
    const isImg     = item.contentType === 'image';
    const displayTx = isImg
      ? '📷  Image'
      : escapeHtml((item.data || '').slice(0, 90)) +
        (item.data.length > 90 ? '…' : '');
    const timeLabel = relativeTime(item.timestamp);
    const isActive  = item.id === activeItemId ? ' is-active' : '';

    const icon = isImg
      ? iconSvg('M3 3h18v18H3z M9 9a2 2 0 1 1 4 0 2 2 0 0 1-4 0 M21 15l-5-5L5 21')
      : iconSvg('M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z');

    return `
      <div class="history-item${isActive}"
           data-id="${escapeAttr(item.id)}"
           data-type="${escapeAttr(item.contentType)}"
           data-query="${escapeAttr((item.data || '').slice(0, 200))}"
           role="button"
           tabindex="0"
           aria-label="Search: ${escapeAttr((item.data || '').slice(0, 60))}">
        <div class="history-item-icon">${icon}</div>
        <div class="history-item-body">
          <span class="history-item-text">${displayTx}</span>
          <div class="history-item-meta">
            <span class="history-item-time">${timeLabel}</span>
            <span class="history-item-type">${item.contentType}</span>
          </div>
        </div>
        <button class="history-replay-btn" title="Search again" aria-label="Search again">
          ${iconSvg('M5 12h14M12 5l7 7-7 7')}
        </button>
      </div>`;
  }).join('');

  // Attach interaction handlers
  historyList.querySelectorAll('.history-item').forEach((el) => {
    const activate = () => {
      const type  = el.dataset.type;
      const query = el.dataset.query;
      activeItemId = el.dataset.id;

      if (type === 'image') {
        currentSection.classList.remove('hidden');
        contentTypeBadge.textContent = 'image';
        contentTypeBadge.className   = 'badge badge-image';
        queryDisplay.innerHTML = buildSafeText('[Image copied to clipboard]');
        showImageFallback();
      } else {
        triggerManualSearch(query);
      }

      // Re-render history to update active highlight
      chrome.storage.local
        .get({ searchHistory: [] })
        .then(({ searchHistory }) => renderHistory(searchHistory))
        .catch(() => {});
    };

    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });

    // Re-search button — same action, stop row click from double-firing
    el.querySelector('.history-replay-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      activate();
    });
  });
}

// ─── Clear History ────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  activeItemId = null;
  manualInput.value = '';
  currentSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  resultsContainer.innerHTML = '';
  renderHistory([]);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function triggerManualSearch(query) {
  manualInput.value = query.slice(0, 150);
  // Synthesise display update
  currentSection.classList.remove('hidden');
  contentTypeBadge.textContent = 'text';
  contentTypeBadge.className   = 'badge badge-text';
  const preview = query.length > 300 ? query.slice(0, 300) + '…' : query;
  queryDisplay.innerHTML = `<span class="query-text">${escapeHtml(preview)}</span>`;
  performSearch(query);
}

function setStatus(type, text) {
  statusDot.className    = `status-dot ${type}`;
  statusLabel.textContent = text;
}

/** Returns a simple, pre-sanitised HTML string for safe display. */
function buildSafeText(text) {
  return `<span class="query-text">${escapeHtml(text)}</span>`;
}

/**
 * Converts a timestamp to a human-readable relative string.
 * @param {number} ts - Unix timestamp in milliseconds
 */
function relativeTime(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Escapes HTML special characters to prevent XSS when inserting user-controlled
 * text into innerHTML.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes a value for use inside an HTML attribute (href, data-*, etc.). */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** URI-encodes a query string component. */
function enc(str) {
  return encodeURIComponent(String(str));
}

/** Builds an anchor element string for an engine shortcut link. */
function engineLink(url, label, title) {
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="engine-link" title="${escapeAttr(title)}">${escapeHtml(label)}</a>`;
}

/** Returns a minimal inline SVG icon with the given path data. */
function iconSvg(pathD) {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${pathD}"/></svg>`;
}

/**
 * Wraps fetch() with an AbortController timeout.
 *
 * @param {string} url
 * @param {number} timeoutMs
 */
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
