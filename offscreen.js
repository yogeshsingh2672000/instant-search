/**
 * offscreen.js — Offscreen Document Script
 *
 * Reason: chrome.offscreen.Reason.CLIPBOARD
 *
 * Approval-first behavior is handled in content.js via an in-page popup.
 *
 * To guarantee that rejected copies are never searched or stored in history,
 * this offscreen script does not auto-ingest clipboard content.
 */

'use strict';

console.debug('[Offscreen] Loaded. Clipboard auto-monitoring is disabled.');
