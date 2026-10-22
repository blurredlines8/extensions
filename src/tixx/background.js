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

  // ----------------------------------------------------------- group ---
  // Several accounts of one group, each in its own Firefox container (own
  // login, own queue place), buying seats next to each other. Content scripts
  // in different containers share nothing, but this background is one for
  // all of them, so it keeps the group: per club the members (keyed by
  // container), what each wants and holds, the spot the first one planned,
  // and seats someone is claiming right now — so two accounts never go for
  // the same seats. Memory only: a group lives as long as the browser runs.
  const groups = {};
  const CLAIM_MS = 30 * 1000;   // a claim in flight; longer means it died

  function memberKey(sender) {
    const tab = sender && sender.tab;
    if (!tab) return null;
    return tab.cookieStoreId || ('tab-' + tab.id);
  }

  function groupView(club, me) {
    const g = groups[club];
    if (!g) return { members: [], held: [], total: 0, plan: null };
    const now = Date.now();
    const mine = g.members[me];
    const eventId = mine ? mine.eventId : null;
    const members = [];
    const held = [];
    let total = 0;
    for (const [key, m] of Object.entries(g.members)) {
      const same = m.eventId === eventId;
      const claiming = m.claim && now - m.claim.at < CLAIM_MS ? m.claim.seats : [];
      members.push({ me: key === me, n: m.n, want: m.want, cart: m.cart.length, eventId: m.eventId, same, config: m.config });
      if (!same) continue;
      total += m.want;
      if (key !== me) held.push(...m.cart, ...claiming);
    }
    const plan = g.plan && g.plan.eventId === eventId ? g.plan.seats : null;
    return { members, held, total, plan };
  }

  function onGroup(msg, sender) {
    const me = memberKey(sender);
    if (!me) return { error: 'geen tabblad' };
    const club = String(msg.club || '');
    const g = groups[club] || (groups[club] = { members: {}, plan: null, next: 1 });
    if (msg.op === 'leave') {
      delete g.members[me];
      if (!Object.keys(g.members).length) delete groups[club];
      return groupView(club, me);
    }
    const m = g.members[me] || (g.members[me] = { n: g.next++, cart: [], claim: null });
    if (msg.op === 'update') {
      m.eventId = msg.eventId;
      m.want = Math.max(1, Number(msg.want) || 1);
      m.cart = Array.isArray(msg.cart) ? msg.cart : [];
      m.config = msg.config || null;
      if (m.claim && m.cart.some(id => m.claim.seats.includes(id))) m.claim = null;
      // Nobody holds anything any more: the old plan no longer binds anyone.
      const anyHeld = Object.values(g.members).some(x => x.eventId === m.eventId && x.cart.length);
      if (g.plan && g.plan.eventId === m.eventId && !anyHeld && !Object.values(g.members).some(x => x.claim)) g.plan = null;
      return groupView(club, me);
    }
    if (msg.op === 'claim') {
      // One message, so checking and taking cannot interleave with another
      // account's: the background handles messages one at a time.
      const view = groupView(club, me);
      const taken = new Set(view.held);
      if ((msg.seats || []).some(id => taken.has(id))) return Object.assign({ ok: false }, view);
      m.claim = { seats: msg.seats || [], at: Date.now() };
      if (msg.plan && !(g.plan && g.plan.eventId === m.eventId)) g.plan = { eventId: m.eventId, seats: msg.plan };
      return Object.assign({ ok: true }, groupView(club, me));
    }
    if (msg.op === 'release') {
      m.claim = null;
      return groupView(club, me);
    }
    return groupView(club, me);
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'group') {
      sendResponse(onGroup(msg, sender));
      return false;
    }
    if (!msg || msg.type !== 'schedule') return false;
    schedule(String(msg.club || ''))
      .then(sendResponse)
      .catch(e => sendResponse({ error: String(e && e.message || e) }));
    return true;   // answer asynchronously
  });
})();
