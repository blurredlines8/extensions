/* Seat Assist (TIXX) — background: fetches a club's presale table for the
   panel. A content script cannot reach another site in Chrome, and the page
   is public, so it is fetched without cookies. */
/* global SeatAssistCore, importScripts, browser, chrome */
(function () {
  'use strict';
  // Chrome runs this as a service worker (load core.js here); Firefox loads
  // core.js before it via the manifest.
  if (typeof SeatAssistCore === 'undefined' && typeof importScripts === 'function') importScripts('tixx-core.js');
  const core = SeatAssistCore;
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  // "club=url club=url", filled in by build.sh from .env.
  const SCHEDULES = {};
  for (const pair of '__TIXX_SCHEDULES__'.split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) SCHEDULES[pair.slice(0, i)] = pair.slice(i + 1);
  }

  // The table changes a few times a week; half an hour is fresh enough.
  const TTL_MS = 30 * 60 * 1000;
  const cache = {};

  async function schedule(club) {
    const url = SCHEDULES[club];
    if (!url) return { none: true };
    const hit = cache[club];
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('verkoopdata ' + res.status);
    const data = { rows: core.parseSchedule(await res.text()), url };
    cache[club] = { at: Date.now(), data };
    return data;
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'schedule') return false;
    schedule(String(msg.club || ''))
      .then(sendResponse)
      .catch(e => sendResponse({ error: String(e && e.message || e) }));
    return true;   // answer asynchronously
  });
})();
