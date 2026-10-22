(function () {
  'use strict';
  if (window.__seatAssistTixxLoaded) return;
  window.__seatAssistTixxLoaded = true;

  const core = (typeof SeatAssistCore !== 'undefined') ? SeatAssistCore : null;
  if (!core) return;

  const API = '__TIXX_API_ORIGIN__';
  // One build serves every club on the platform: the shop is whichever one
  // this page belongs to (…/<club>/<language>/<shop>/channel/shop).
  const BASE = (/^(.*?\/channel\/shop)(?:\/|$)/.exec(window.location.pathname) || [])[1];
  if (!BASE) return;
  const SHOP = '__TIXX_SHOP_ORIGIN__' + BASE;
  const CLUB = BASE.split('/').filter(Boolean)[1] || '';
  // The shop's own seat plan refreshes availability after expiresIn + 5 s, or
  // every 30 s when the answer carries no expiry. We keep the same pace: the
  // answer is cached upstream, so asking more often would not show more.
  const DEFAULT_REFRESH_MS = 30000;
  const MIN_REFRESH_MS = 5000;
  // Before the plan exists (sale not open yet) only the venue page is checked.
  const WAIT_MS = 60000;
  // Around a sale start you set yourself ("verkoopstart"), from two minutes
  // before until a quarter of an hour after, both the venue page and the
  // event list are checked every few seconds, like refreshing by hand.
  const FAST_MS = 5000;
  const ARM_BEFORE_MS = 2 * 60 * 1000;
  const ARM_AFTER_MS = 15 * 60 * 1000;
  const ERROR_BACKOFF_MS = 30000;
  // The signature on the seat-plan URLs comes from the venue page; fetch it
  // anew now and then so it never goes stale.
  const VENUE_TTL_MS = 10 * 60 * 1000;
  // The venue page's block list (what is on sale, what sold out) moves faster
  // than its signature; while the plan is open, refresh it this often. A claim
  // reuses it when it is at most CLAIM_VENUE_MS old.
  const AREAS_TTL_MS = 60 * 1000;
  const CLAIM_VENUE_MS = 20 * 1000;
  // Every club shares one origin, so keep choices per shop.
  const SETTINGS_KEY = 'satSettings:' + BASE;
  const RUNNING_KEY = 'satRunning:' + BASE;
  const POS_KEY = 'satPanelPos';
  // When this tab last went into the Queue-it waiting room by itself.
  const QUEUE_AT_KEY = 'satQueueAt:' + BASE;
  const QUEUE_RETRY_MS = 2 * 60 * 1000;
  // The shop's event list is checked for new matches every few minutes, and
  // every half minute around a known sale moment. The last check time is
  // shared by all tabs of this shop, so they do not each fetch it.
  const KNOWN_KEY = 'satKnownEvents:' + BASE;
  const EVENTS_AT_KEY = 'satEventsAt:' + BASE;
  const EVENTS_POLL_MS = 5 * 60 * 1000;
  const EVENTS_POLL_NEAR_MS = 30 * 1000;
  const NEAR_SALE_MS = 15 * 60 * 1000;
  const SCHEDULE_REFRESH_MS = 30 * 60 * 1000;

  const state = {
    events: [],
    eventId: null,
    eventLabel: null,
    eventDate: null,       // dd.mm.yyyy of the chosen match
    schedule: [],          // the club's presale table, if it publishes one
    fired: new Set(),      // sale moments already announced in this tab
    blocked: false,        // the shop asked for a human check: stop polling
    armTime: '',           // "HH:MM" today: the sale start you expect
    armMatch: '',          // auto-select and start the match whose name contains this
    autoStarted: false,
    venue: null,           // parsed venue page (signature, stands, prices)
    venueAt: 0,
    blocks: [],            // every block of the plan
    labels: new Map(),     // blockId -> Map(seatId -> {row, seat})
    mapping: null,         // decoded price mapping
    av: null,              // latest availability response (for its timestamp)
    cart: null,            // this event's seat ids in the cart; null = not checked yet
    loggedIn: null,
    loginWarned: false,
    free: new Set(),       // free seat ids from the latest availability
    ga: new Map(),         // standing-area id -> free amount
    selected: [],          // block ids in priority order (click order)
    want: 1,
    mode: 'row',           // row | cluster | loose
    geo: null,             // seat positions and row directions per block
    limitLogged: new Set(),
    kind: 'all',           // all | sale | resale
    running: false,
    busy: false,
    timer: null,
    nextAt: 0,
    acquired: 0,
    attempted: new Set(),  // seats we tried; never hammer the same one again
    waitLogged: false,
    gaLogged: new Set(),
    title: null,
  };

  // Firefox runs content-script fetches as the extension unless they go
  // through content.fetch; that one behaves like the page's own requests
  // (same origin, same cookies). Chrome's content-script fetch already does.
  /* global content */
  const pageFetch = (typeof content !== 'undefined' && content && typeof content.fetch === 'function')
    ? (url, opts) => content.fetch(url, opts)
    : (url, opts) => window.fetch(url, opts);

  const nowStr = () => new Date().toLocaleTimeString('nl-NL');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ------------------------------------------------------------------ API ---
  function blockedError() {
    const e = new Error('shop vraagt om bevestiging (403)');
    e.blocked = true;
    return e;
  }

  async function shopFetch(path, opts) {
    const res = await pageFetch(SHOP + path, Object.assign({ credentials: 'include' }, opts || {}));
    // 403 on the shop is its bot check ("Ich bin ein Mensch"). That is the
    // user's to answer in the page; the extension stops instead.
    if (res.status === 403) throw blockedError();
    // Anything that lands outside the shop is a detour — including Queue-it,
    // which lives on the shop's own domain (/queue/view).
    if (!res.url.startsWith(SHOP)) {
      const where = new URL(res.url);
      const queue = /\/queue\//.test(where.pathname) ? core.parseQueue(await res.text()) : null;
      const e = new Error(queue ? 'wachtrij' : 'omgeleid naar ' + where.host + where.pathname);
      e.redirected = true;
      e.queue = queue;
      throw e;
    }
    return res;
  }

  async function apiGet(kind, suffix, extra) {
    const sm = state.venue && state.venue.seatmap;
    if (!sm) throw new Error('geen stoelplan-parameters');
    const q = new URLSearchParams(Object.assign({}, extra || {}, sm.params));
    const res = await pageFetch(API + '/seatmap/api/public/' + kind + '/' + sm.key + (suffix || '') + '?' + q, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      state.venueAt = 0;   // signature expired: fetch the venue page again
      throw new Error('stoelplan-API weigert (' + res.status + '), handtekening wordt ververst');
    }
    if (res.status === 304) return null;   // unchanged since the timestamp we sent
    if (!res.ok) throw new Error('stoelplan-API ' + res.status);
    return res.json();
  }

  const venuePath = id => '/areaplan/venue/event/' + id;

  async function loadVenue(eventId) {
    const res = await shopFetch(venuePath(eventId));
    return useVenue(core.parseVenuePage(await res.text()));
  }

  function useVenue(v) {
    state.venue = v;
    state.venueAt = Date.now();
    if (v.title) state.eventLabel = v.title;
    setLogin(v.loggedIn);
    return v;
  }

  async function loadPlan() {
    const sm = await apiGet('seatmap', '', { generateTiles: 'false' });
    state.blocks = core.blocksFromSeatmap(sm);
    state.geo = core.seatGeometry(sm);
    renderBlocks();
  }

  // The plain URL is served from a cache and can be an hour old (HAR
  // 2026-10-20: a 09:13 snapshot at 10:05). Like the shop, ask again with that
  // snapshot's timestamp: the answer is fresh data, or 304 = it still holds.
  async function fetchAvailability() {
    const ask = ts => apiGet('availability', '', ts ? { availabilityTimestamp: ts } : null);
    let av = await ask(state.av && state.av.timestamp);
    if (av === null) return state.av;
    if (av.expired && av.timestamp) {
      const fresh = await ask(av.timestamp);
      if (fresh) av = fresh;
    }
    state.av = av;
    const d = core.decodeAvailability(av);
    state.free = d.free;
    state.ga = d.ga;
    return av;
  }

  async function fetchMapping() {
    state.mapping = core.decodeMapping(await apiGet('mapping'));
  }

  async function getLabels(blockId) {
    if (!state.labels.has(blockId)) {
      state.labels.set(blockId, core.seatLabels(await apiGet('seatmap', '/block/' + blockId)));
    }
    return state.labels.get(blockId);
  }

  const blockName = id => {
    const b = state.blocks.find(x => x.id === id);
    return b ? b.name : String(id);
  };

  function seatName(id) {
    const lab = state.labels.get(core.blockOf(id));
    const l = lab && lab.get(id);
    return blockName(core.blockOf(id)) + (l ? ' · rij ' + l.row + ' stoel ' + l.seat : ' · ' + id);
  }

  function categoryOf(id) {
    return state.mapping ? state.mapping.seatCat.get(id) : undefined;
  }

  // A seat without a price category cannot be sent to addseats (its priceId
  // would be empty). The mapping can lag the availability; such a seat comes
  // back in a later round once the mapping lists it.
  function accepts(id) {
    const cat = categoryOf(id);
    if (cat === undefined) return false;
    if (state.kind === 'all') return true;
    const resale = core.isResaleCategory(cat, state.mapping.names);
    return state.kind === 'resale' ? resale : !resale;
  }

  const MODE_TEXT = { row: 'in één rij', cluster: 'cluster', loose: 'los' };

  // Blocks to search, in priority order, minus those this shop does not sell
  // (not in the venue page's areaList) and those where the shop would not
  // allow this many more tickets, counting what is already in the cart.
  function eligibleBlocks() {
    const need = state.want - state.acquired;
    const limits = state.venue && state.venue.limits;
    const sale = core.saleBlocks(state.venue);
    const order = state.selected.length ? state.selected : state.blocks.map(b => b.id);
    return order.filter(b => {
      if (sale && !sale.has(b)) {
        // Not "logged once": a sold-out block leaves the list and may return.
        if (!state.limitLogged.has('sale:' + b) && state.selected.includes(b)) {
          state.limitLogged.add('sale:' + b);
          log('🚫 ' + blockName(b) + ' wordt nu niet via deze shop verkocht (of is uitverkocht); overgeslagen.');
        }
        return false;
      }
      state.limitLogged.delete('sale:' + b);
      const max = core.blockLimit(limits, b, state.cart);
      if (need <= max) return true;
      if (!state.limitLogged.has(b)) {
        state.limitLogged.add(b);
        const held = state.cart && state.cart.length ? ' (' + state.cart.length + ' al in je winkelwagen)' : '';
        log('🚫 ' + blockName(b) + ' overgeslagen: daar kunnen er nog max ' + Math.max(0, max) + ' bij' + held + '.');
      }
      return false;
    });
  }

  // How many more tickets the shop allows for this event anywhere, given the cart.
  function roomLeft() {
    const limits = state.venue && state.venue.limits;
    if (!limits || !limits.maxTotal) return Infinity;
    return limits.maxTotal - (state.cart ? state.cart.length : 0);
  }

  async function loadCart() {
    const items = core.parseCart(await (await shopFetch('/shoppingcart')).text());
    state.cart = items.filter(it => Number(it.eventId) === state.eventId).map(it => it.seatId);
    if (state.cart.length) log('🛒 Al ' + state.cart.length + ' kaart(en) voor deze wedstrijd in je winkelwagen; die tellen mee voor de limiet.');
  }

  // ---------------------------------------------------------------- claim ---
  const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';

  // Two steps, like the shop: addseats puts a seat in the session's selection
  // and returns its price choice; addselecteditemsareas moves the selection
  // into the cart (that is what starts the 20-minute reservation).
  async function claim(ids) {
    const ev = state.eventId;
    // Stand names come from the venue page; a recent copy will do, and
    // skipping the fetch saves ~0.4 s on the way to the cart.
    if (Date.now() - state.venueAt > CLAIM_VENUE_MS) await loadVenue(ev);
    const fields = [];
    const chosen = [];
    for (const id of ids) {
      const block = core.blockOf(id);
      const lab = (await getLabels(block)).get(id);
      if (!lab) { log('✗ ' + id + ' staat niet in het blokplan'); state.attempted.add(id); continue; }
      const b = state.blocks.find(x => x.id === block);
      const body = new URLSearchParams();
      body.set('seats[0][priceId]', String(categoryOf(id) || ''));
      body.set('seats[0][row]', lab.row);
      body.set('seats[0][seat]', lab.seat);
      body.set('seats[0][blockId]', String(block));
      body.set('seats[0][block]', b ? b.rawName : blockName(block));
      body.set('seats[0][tribune]', core.standOf(state.venue.areas, block, true));
      body.set('seats[0][id]', 's' + id);
      const res = await shopFetch('/areaplan/addseats/event/' + ev + '/area/' + block, {
        method: 'POST',
        headers: { 'Content-Type': FORM, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, */*; q=0.01' },
        body: body.toString(),
      });
      const text = await res.text();
      const card = res.ok ? core.parseSeatCard(text) : null;
      if (!card) {
        log('✗ ' + seatName(id) + ' niet te kiezen: ' + refusal(res.status, text));
        state.attempted.add(id);
        continue;
      }
      fields.push([card.field, card.chosen.value]);
      chosen.push(id);
      log('✓ gekozen: ' + seatName(id) + ' · ' + card.chosen.label);
    }

    if (!fields.length) return 0;
    if (state.mode !== 'loose' && chosen.length < ids.length) {
      log('↩️ Niet de hele groep gelukt, selectie losgelaten.');
      await clearSelection();
      ids.forEach(id => state.attempted.add(id));
      return 0;
    }

    const res = await shopFetch('/shoppingcart/addselecteditemsareas/event/' + ev, {
      method: 'POST',
      headers: { 'Content-Type': FORM },
      body: new URLSearchParams(fields).toString(),
    });
    let items = core.parseCart(await res.text());
    if (!items.length) items = core.parseCart(await (await shopFetch('/shoppingcart')).text());
    const landed = chosen.filter(id => items.some(it => it.seatId === id));
    if (items.length) state.cart = items.filter(it => Number(it.eventId) === ev).map(it => it.seatId);
    ids.forEach(id => state.attempted.add(id));
    if (landed.length) log('🛒 In winkelwagen: ' + landed.map(seatName).join(', '));
    else log('✗ Naar de winkelwagen mislukt (' + res.status + ', ' + new URL(res.url).pathname.split('/').pop() + ')');
    return landed.length;
  }

  async function clearSelection() {
    try {
      await shopFetch('/areaplan/removeallselectedseats', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
    } catch (e) { if (e.blocked) throw e; }
  }

  // Empty the cart item by item, with the same call as the shop's trash icon.
  async function clearCart() {
    if (!window.confirm('Alle kaarten uit de winkelwagen halen? Ze worden vrijgegeven.')) return;
    try {
      const items = core.parseCart(await (await shopFetch('/shoppingcart')).text());
      if (!items.length) { log('🗑 Winkelwagen is al leeg.'); return; }
      for (const it of items) {
        await shopFetch('/shoppingcart/deleteitem/itemId/' + it.itemId, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
      }
      const left = core.parseCart(await (await shopFetch('/shoppingcart')).text());
      log(left.length ? '⚠️ Nog ' + left.length + ' kaart(en) in de winkelwagen.' : '🗑 Winkelwagen leeg (' + items.length + ' vrijgegeven).');
      state.acquired = 0;
    } catch (e) { onError(e); }
  }

  // A refused pick comes back as 404 {"snap":2,"alternative":"s<id>"}: the
  // seat would leave fewer than `snap` free seats next to it.
  function refusal(status, text) {
    try {
      const j = JSON.parse(text);
      if (j && j.snap != null) {
        const alt = /^s(\d+)$/.exec(j.alternative || '');
        return 'zou een losse lege stoel achterlaten' + (alt ? ' (shop stelt ' + seatName(Number(alt[1])) + ' voor)' : '');
      }
    } catch (e) { /* not JSON */ }
    return status + ': ' + snippet(text);
  }

  const snippet = t => String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'leeg';

  // -------------------------------------------------------------- monitor ---
  async function tick() {
    state.timer = null;
    if (!state.running || state.busy) return;
    state.busy = true;
    let delay = WAIT_MS;
    try {
      const age = Date.now() - state.venueAt;
      if (state.venue && state.venue.seatmap && age > AREAS_TTL_MS && age <= VENUE_TTL_MS) await loadVenue(state.eventId);
      if (!state.venue || !state.venue.seatmap || Date.now() - state.venueAt > VENUE_TTL_MS) {
        await loadVenue(state.eventId);
        if (!state.venue.seatmap) {
          if (!state.waitLogged) {
            log('⏳ Nog geen stoelplan voor dit event; de verkoop is waarschijnlijk nog niet open. Ik kijk elke minuut' + (state.armTime ? ', rond ' + state.armTime + ' elke 5 s.' : '.'));
            state.waitLogged = true;
          }
          if (nearArm()) delay = FAST_MS;
          setStatus('Wachten op het stoelplan');
          return;
        }
        if (state.waitLogged) {
          log('🟢 Het stoelplan is er!');
          flashTitle('🟢 Open');
          beep();
          state.waitLogged = false;
        }
        if (!state.blocks.length) await loadPlan();
      }

      if (state.cart == null) await loadCart();
      if (roomLeft() <= 0) {
        stop();
        log('🛑 Je hebt al ' + state.cart.length + ' kaart(en) voor deze wedstrijd in je winkelwagen; de shop staat er max ' +
          state.venue.limits.maxTotal + ' toe. Gestopt.');
        return;
      }

      const av = await fetchAvailability();
      delay = Math.max(MIN_REFRESH_MS, av.expiresIn > 0 ? av.expiresIn + 5000 : DEFAULT_REFRESH_MS);
      const scope = new Set(eligibleBlocks());
      const inScope = id => scope.has(core.blockOf(id));
      const candidates = [...state.free].filter(inScope);
      reportStanding();
      renderBlocks();
      setStatus('Stoelplan open');

      if (candidates.length) {
        await fetchMapping();
        const ids = core.pickSeats(candidates, {
          want: state.want - state.acquired, mode: state.mode, geo: state.geo,
          blocks: eligibleBlocks(), skip: state.attempted, accept: accepts,
        });
        setCounter(candidates.filter(accepts).length);
        if (ids.length) {
          for (const b of new Set(ids.map(core.blockOf))) await getLabels(b);
          log('🎯 ' + nowStr() + ' probeer ' + ids.map(seatName).join(', '));
          state.acquired += await claim(ids);
          if (state.acquired >= state.want) { onSuccess(); return; }
          delay = 3000;
        }
      } else {
        setCounter(0);
      }
    } catch (e) {
      onError(e);
      delay = ERROR_BACKOFF_MS;
    } finally {
      state.busy = false;
      if (state.running && !state.timer) {
        state.nextAt = Date.now() + delay;
        state.timer = setTimeout(tick, delay);
      }
    }
  }

  // Standing areas are sold by amount, not by seat; buying them is a
  // different flow we have not recorded yet. Say so instead of failing quietly.
  function reportStanding() {
    for (const [gaId, n] of state.ga) {
      const block = core.blockOf(gaId);
      if (n > 0 && (!state.selected.length || state.selected.includes(block)) && !state.gaLogged.has(block)) {
        state.gaLogged.add(block);
        log('🧍 Staanplaatsen vrij in ' + blockName(block) + ' (' + n + '). Die koop je nog met de hand.');
      }
    }
  }

  function onError(e) {
    if (e && e.blocked) {
      state.blocked = true;
      stop();
      log('🛑 De shop vraagt om te bevestigen dat je geen bot bent. Doe dat zelf in dit tabblad en start daarna opnieuw.');
      showBanner('De shop vraagt om een bevestiging.', 'Pagina herladen', window.location.href);
      beep();
      return;
    }
    if (e && e.redirected && e.queue) { onQueue(e.queue); return; }
    if (e && e.redirected) {
      stop();
      log('🛑 Shop stuurt door: ' + e.message + '. Ga in dit tabblad gewoon door de wachtrij en start daarna opnieuw.');
      return;
    }
    log('⚠️ ' + nowStr() + ' ' + (e && e.message ? e.message : e));
  }

  // The shop has put up its Queue-it waiting room. The extension never gets
  // past it on its own: when it is running or armed, this tab joins the queue
  // like any visitor (a page load does that), and Queue-it sends it back to
  // the shop afterwards, where a running search resumes. Otherwise it only says so.
  function onQueue(q) {
    const when = q.startAt ? new Date(q.startAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : null;
    const what = q.before
      ? 'Voorwachtrij' + (q.name ? ' voor ' + q.name : '') + (when ? ', start ' + when : '') +
        '. Wie er vóór de start in staat, krijgt een willekeurige plek.'
      : 'De wachtrij is actief' + (q.ahead != null ? ' (' + q.ahead + ' voor je)' : '') + '.';
    const wasOn = state.running;
    const armed = wasOn || !!state.armMatch.trim() || armAt() != null;
    stop();
    // Login sits behind the queue too, so this can only warn: log in right
    // after it (the shop's SSO takes ~1.5 s).
    if (armed && state.loggedIn === false) log('🔑 Je bent niet ingelogd; doe dat direct na de wachtrij.');
    // A page load that lands back here still queued must not turn into a loop.
    let last = 0;
    try { last = Number(window.sessionStorage.getItem(QUEUE_AT_KEY)) || 0; } catch (err) { /* none */ }
    if (armed && Date.now() - last > QUEUE_RETRY_MS) {
      if (wasOn) saveRunning(true);
      try { window.sessionStorage.setItem(QUEUE_AT_KEY, String(Date.now())); } catch (err) { /* ignore */ }
      // Queue-it returns you to the page you queued from, so queue from the
      // chosen match's venue page: afterwards that page is already loaded.
      const target = state.eventId != null ? SHOP + venuePath(state.eventId) : null;
      log('⏳ ' + what + ' Dit tabblad gaat de wachtrij in' +
        (target ? ' via de pagina van de gekozen wedstrijd' : '') + '; daarna gaat de extensie vanzelf verder.');
      beep();
      sleep(1500).then(() => {
        if (target && target !== window.location.href) window.location.href = target;
        else window.location.reload();
      });
      return;
    }
    log('⏳ ' + what + ' Ga in dit tabblad door de wachtrij; daarna kun je starten.');
    showBanner('⏳ ' + what, 'Naar de wachtrij', window.location.href);
    beep();
  }

  function start() {
    if (state.running) return;
    if (state.eventId == null) { log('Kies eerst een wedstrijd.'); return; }
    state.running = true;
    state.acquired = 0;
    state.attempted = new Set();
    state.cart = null;     // checked on the first round: what is held counts against the limit
    state.waitLogged = false;
    state.gaLogged = new Set();
    saveRunning(true);
    setRunning(true);
    warnLogin();
    const names = state.selected.length
      ? state.selected.map((b, i) => (i + 1) + '. ' + blockName(b)).join('  ')
      : 'alle blokken';
    const kind = { all: 'alles', sale: 'alleen verkoop', resale: 'alleen Ticketbörse' }[state.kind];
    state.limitLogged = new Set();
    log('▶️ Gestart · ' + names + ' · ' + state.want + '× · ' + MODE_TEXT[state.mode] + ' · ' + kind);
    tick();
  }

  function stop() {
    state.running = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    saveRunning(false);
    setRunning(false);
    restoreTitle();
  }

  function onSuccess() {
    stop();
    log('🎟️ ' + state.acquired + ' plaats(en) in je winkelwagen. Je hebt 20 minuten om af te rekenen!');
    showBanner('🎟️ ' + state.acquired + ' plaats(en) in je winkelwagen!', 'Naar winkelwagen →', SHOP + '/shoppingcart');
    flashTitle('🎟️');
    beep();
  }

  // ------------------------------------------------------------- settings ---
  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        eventId: state.eventId, eventLabel: state.eventLabel, eventDate: state.eventDate, selected: state.selected,
        want: state.want, mode: state.mode, kind: state.kind, armTime: state.armTime, armMatch: state.armMatch,
      }));
    } catch (e) { /* private mode: settings are simply not remembered */ }
  }

  function readSettings() {
    try { return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { return null; }
  }

  // Per tab, so a page load in this tab resumes and other tabs stay quiet.
  function saveRunning(on) {
    try {
      if (on) window.sessionStorage.setItem(RUNNING_KEY, '1');
      else window.sessionStorage.removeItem(RUNNING_KEY);
    } catch (e) { /* ignore */ }
  }

  function wasRunning() {
    try { return window.sessionStorage.getItem(RUNNING_KEY) === '1'; } catch (e) { return false; }
  }

  // ------------------------------------------------------------------- UI ---
  const ui = {};

  function log(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function setLogin(on) {
    if (on == null) return;
    state.loggedIn = on;
    ui.token.textContent = on ? 'ingelogd' : 'niet ingelogd';
    ui.token.className = 'sat-token ' + (on ? 'sat-ok' : 'sat-bad');
    if (on) state.loginWarned = false;
    else warnLogin();
  }

  // Logged out, the shop lists only matches on free sale (1 of 5 in the HAR of
  // 2026-10-20) and the members' sale stays invisible. Worth saying loudly
  // when the extension is meant to buy, before the queue rather than after.
  function warnLogin() {
    const armed = state.running || !!state.armMatch.trim() || armAt() != null;
    if (state.loggedIn !== false || !armed || state.loginWarned) return;
    state.loginWarned = true;
    log('🔑 Je bent niet ingelogd. Zonder login zie je de ledenverkoop niet — log in vóór de wachtrij.');
    showBanner('🔑 Niet ingelogd: de ledenverkoop zie je pas na inloggen.', 'Inloggen',
      SHOP + '/oauth/start?target_uri=' + encodeURIComponent(window.location.href));
    beep();
  }

  function setRunning(on) {
    ui.startBtn.disabled = on;
    ui.stopBtn.disabled = !on;
  }

  function setStatus(text) {
    ui.status.textContent = '';
    const t = document.createElement('div');
    t.className = 'sat-wc-title';
    t.textContent = state.eventLabel || ('Event ' + state.eventId);
    const s = document.createElement('div');
    s.className = 'sat-wc-m';
    s.textContent = text + ' · ' + nowStr();
    ui.status.append(t, s);
    const sale = state.eventDate && saleInfoFor(state.eventDate);
    if (sale) {
      const v = document.createElement('div');
      v.className = 'sat-wc-pl';
      v.textContent = 'Verkoop: ' + sale;
      ui.status.appendChild(v);
    }
  }

  function setCounter(n) {
    const total = state.free.size;
    ui.counter.textContent = 'Vrij nu: ' + n + (state.selected.length ? ' in jouw blokken' : '') + ' · ' + total + ' in het hele stadion';
    ui.counter.classList.toggle('sat-idle', n === 0);
  }

  function freeIn(blockId) {
    let n = 0;
    for (const id of state.free) if (core.blockOf(id) === blockId) n++;
    return n + (state.ga.get(blockId * 1e6) || 0);
  }

  function renderBlocks() {
    ui.blocks.textContent = '';
    if (!state.blocks.length) {
      const hint = document.createElement('div');
      hint.className = 'sat-hint';
      hint.textContent = state.selected.length
        ? 'Gekozen: ' + state.selected.map((b, i) => (i + 1) + '. ' + blockName(b)).join('  ') + ' (↻ om alle blokken te laden)'
        : 'Kies een wedstrijd en klik ↻ om de blokken te laden.';
      ui.blocks.appendChild(hint);
      return;
    }
    for (const b of state.blocks) {
      const idx = state.selected.indexOf(b.id);
      const n = freeIn(b.id);
      const row = document.createElement('div');
      row.className = 'sat-sec' + (idx >= 0 ? ' sat-sel' : '') + (n ? '' : ' sat-full') + (b.ga ? ' sat-ga' : '');
      const label = document.createElement('span');
      label.className = 'sat-sec-label';
      label.textContent = (idx >= 0 ? (idx + 1) + '. ' : '') + b.name + (b.ga ? ' (staan)' : '');
      const count = document.createElement('span');
      count.className = 'sat-sec-free';
      count.textContent = n ? n + ' vrij' : '';
      row.append(label, count);
      row.addEventListener('click', () => toggleBlock(b.id));
      ui.blocks.appendChild(row);
    }
  }

  function toggleBlock(id) {
    const i = state.selected.indexOf(id);
    if (i >= 0) state.selected.splice(i, 1);
    else state.selected.push(id);
    saveSettings();
    renderBlocks();
  }

  // Event cards on the shop's index: id, label, match date, and whether the
  // card already links to a seat plan (no link = no tickets yet).
  async function fetchEvents() {
    const res = await shopFetch('/index');
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const seen = new Set();
    const out = [];
    for (const card of doc.querySelectorAll('.event-card[data-event-id]')) {
      const id = card.getAttribute('data-event-id');
      if (seen.has(id)) continue;
      seen.add(id);
      const link = card.querySelector('a[href*="/areaplan/venue/event/"]');
      const name = core.tidy((link && link.getAttribute('aria-label')) || card.textContent).replace(/\s*-\s*(Tickets|Karten)$/i, '');
      const time = card.querySelector('.event__info--time');
      const when = time ? core.tidy(time.textContent) : '';
      out.push({ id: Number(id), label: name + (when ? ' · ' + when : '') + (link ? '' : ' (nog geen tickets)'), date: core.dateKey(when), open: !!link });
    }
    return out;
  }

  async function loadEvents() {
    try {
      state.events = await fetchEvents();
      fillEvents();
      rememberEvents(state.events);
      log('📋 ' + state.events.length + ' wedstrijden geladen.');
    } catch (e) { onError(e); }
  }

  // Compare with what this shop listed before and report new matches and
  // matches whose tickets just opened. The very first look only records.
  function rememberEvents(list) {
    // An empty list is a hiccup (or a changed page), not "every match gone";
    // storing it would announce every match as new next time.
    if (!list.length) return;
    let known = null;
    try { known = JSON.parse(window.localStorage.getItem(KNOWN_KEY) || 'null'); } catch (e) { /* none */ }
    if (known) {
      for (const e of list) {
        if (!(e.id in known)) announce('🆕 Nieuwe wedstrijd in de shop: ' + e.label);
        else if (!known[e.id] && e.open) announce('🟢 Tickets te koop: ' + e.label);
      }
    }
    const next = {};
    for (const e of list) next[e.id] = e.open;
    try { window.localStorage.setItem(KNOWN_KEY, JSON.stringify(next)); } catch (e) { /* not remembered */ }
  }

  function armAt() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(state.armTime || '');
    if (!m) return null;
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  }

  function nearArm() {
    const at = armAt();
    if (at == null) return false;
    const now = Date.now();
    return now >= at - ARM_BEFORE_MS && now <= at + ARM_AFTER_MS;
  }

  function nearSale() {
    const now = Date.now();
    return nearArm() || saleMoments().some(m => Math.abs(m.at - now) < NEAR_SALE_MS);
  }

  // Once the match you named shows a ticket link, pick it and start, with the
  // amount, layout and kind already set in the panel.
  function autoStart(list) {
    const want = state.armMatch.trim().toLowerCase();
    if (!want || state.running || state.autoStarted) return;
    const e = list.find(x => x.open && x.label.toLowerCase().includes(want));
    if (!e) return;
    state.autoStarted = true;
    log('🚀 ' + e.label + ' heeft tickets: automatisch gekozen en gestart.');
    if (state.eventId !== e.id) {
      ui.event.value = String(e.id);
      onEventChange();
    }
    start();
  }

  async function watchEvents() {
    if (state.blocked) return;
    const every = nearArm() ? FAST_MS : nearSale() ? EVENTS_POLL_NEAR_MS : EVENTS_POLL_MS;
    let last = 0;
    try { last = Number(window.localStorage.getItem(EVENTS_AT_KEY)) || 0; } catch (e) { /* none */ }
    if (Date.now() - last >= every - 1000) {
      try { window.localStorage.setItem(EVENTS_AT_KEY, String(Date.now())); } catch (e) { /* ignore */ }
      try {
        const list = await fetchEvents();
        state.events = list;
        fillEvents();
        rememberEvents(list);
        autoStart(list);
      } catch (e) {
        if (e.blocked || e.redirected) { onError(e); return; }
      }
    }
    // Wake up for the fast window even if the normal pace would sleep past it.
    const at = armAt();
    const untilFast = at != null && at - ARM_BEFORE_MS > Date.now() ? at - ARM_BEFORE_MS - Date.now() + 500 : Infinity;
    setTimeout(watchEvents, Math.min(every, nearArm() ? FAST_MS : EVENTS_POLL_NEAR_MS, untilFast));
  }

  function announce(msg) {
    log(msg);
    flashTitle(msg.split(' ')[0]);
    beep();
  }

  // ------------------------------------------------------------ schedule ---
  const ext = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);

  async function loadSchedule() {
    if (!ext || !ext.runtime || !ext.runtime.sendMessage) return;
    try {
      const r = await ext.runtime.sendMessage({ type: 'schedule', club: CLUB });
      if (!r || r.none) return;
      if (r.error) { log('⚠️ Verkoopdata: ' + r.error); return; }
      const first = !state.schedule.length;
      state.schedule = r.rows || [];
      if (first) log('📅 Verkoopdata geladen: ' + state.schedule.length + ' wedstrijden.');
      renderSales();
    } catch (e) { /* no background (e.g. reloaded extension): skip quietly */ }
  }

  // Every sale moment in the table, oldest first.
  function saleMoments() {
    const out = [];
    for (const r of state.schedule) {
      if (r.members) out.push({ at: r.members.at, limit: r.members.limit, kind: 'leden', row: r });
      if (r.general) out.push({ at: r.general.at, limit: r.general.limit, kind: 'vrij', row: r });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  const DAY = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  function fmtWhen(ms) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return DAY[d.getDay()] + ' ' + p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtLeft(ms) {
    if (ms <= 0) return 'nu open';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return 'over ' + d + 'd ' + (h % 24) + 'u';
    if (h >= 1) return 'over ' + h + 'u ' + (m % 60) + 'm';
    if (m >= 1) return 'over ' + m + 'm';
    return 'over ' + Math.ceil(ms / 1000) + 's';
  }
  const matchName = r => r.opponent + (r.home === true ? ' (thuis)' : r.home === false ? ' (uit)' : '') + ' ' + r.date.slice(0, 5);

  // Upcoming sale moments (and those opened within the last hour).
  function renderSales() {
    if (!ui.sales) return;
    ui.sales.textContent = '';
    if (!state.schedule.length) return;
    const now = Date.now();
    const list = saleMoments().filter(m => m.at > now - 3600000).slice(0, 5);
    const head = document.createElement('div');
    head.className = 'sat-wc-title';
    head.textContent = list.length ? 'Komende verkoopmomenten' : 'Geen aangekondigde verkoopmomenten';
    ui.sales.appendChild(head);
    for (const m of list) {
      const line = document.createElement('div');
      line.className = 'sat-sale' + (m.row.date === state.eventDate ? ' sat-sale-mine' : '') + (m.at <= now ? ' sat-sale-open' : '');
      const left = document.createElement('span');
      left.className = 'sat-sale-left';
      left.textContent = fmtLeft(m.at - now);
      const what = document.createElement('span');
      what.textContent = fmtWhen(m.at) + ' · ' + m.kind + ' · ' + matchName(m.row) + (m.limit ? ' · max ' + m.limit : '');
      line.append(left, what);
      ui.sales.appendChild(line);
    }
  }

  // Five minutes ahead: a reminder; at the moment itself: the alarm.
  function checkSaleAlerts() {
    const now = Date.now();
    for (const m of saleMoments()) {
      const key = m.kind + m.at + m.row.date;
      if (m.at - now <= 5 * 60000 && m.at > now && !state.fired.has('pre' + key)) {
        state.fired.add('pre' + key);
        log('⏰ Over ' + Math.ceil((m.at - now) / 60000) + ' min verkoop (' + m.kind + '): ' + matchName(m.row) + '. Zorg dat je ingelogd bent.');
      }
      if (m.at <= now && now - m.at < 60000 && !state.fired.has(key)) {
        state.fired.add(key);
        announce('🔔 Verkoop open (' + m.kind + '): ' + matchName(m.row));
      }
    }
  }

  function saleInfoFor(date) {
    const r = state.schedule.find(x => x.date === date);
    if (!r) return null;
    const part = (t, label) => t ? label + ' ' + fmtWhen(t.at) + (t.limit ? ' (max ' + t.limit + ')' : '') : null;
    return [part(r.members, 'leden'), part(r.general, 'vrij')].filter(Boolean).join(' · ');
  }

  function fillEvents() {
    ui.event.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— kies wedstrijd —';
    ui.event.appendChild(none);
    const list = state.events.slice();
    if (state.eventId != null && !list.some(e => e.id === state.eventId)) {
      list.unshift({ id: state.eventId, label: state.eventLabel || ('Event ' + state.eventId) });
    }
    for (const e of list) {
      const o = document.createElement('option');
      o.value = String(e.id);
      o.textContent = e.label;
      ui.event.appendChild(o);
    }
    ui.event.value = state.eventId != null ? String(state.eventId) : '';
  }

  async function refreshBlocks() {
    if (state.eventId == null) { log('Kies eerst een wedstrijd.'); return; }
    try {
      await loadVenue(state.eventId);
      if (!state.venue.seatmap) { log('⏳ Nog geen stoelplan voor deze wedstrijd.'); renderBlocks(); return; }
      // The full plan (~570 kB) does not change during a sale: once per match.
      if (!state.blocks.length) await loadPlan();
      await fetchAvailability();
      renderBlocks();
      setCounter([...state.free].filter(id => !state.selected.length || state.selected.includes(core.blockOf(id))).length);
      setStatus('Stoelplan open');
      log('🧩 ' + state.blocks.length + ' blokken geladen, ' + state.free.size + ' stoelen vrij.');
    } catch (e) { onError(e); }
  }

  function onEventChange() {
    const id = ui.event.value ? Number(ui.event.value) : null;
    if (id === state.eventId) return;
    if (state.running) stop();
    state.eventId = id;
    const ev = state.events.find(e => e.id === id);
    state.eventLabel = ev ? ev.label : null;
    state.eventDate = ev ? ev.date : null;
    state.venue = null;
    state.av = null;
    state.cart = null;
    state.blocks = [];
    state.labels = new Map();
    state.selected = [];
    state.free = new Set();
    state.ga = new Map();
    ui.status.textContent = '';
    saveSettings();
    renderBlocks();
    if (id != null) refreshBlocks();
  }

  function showBanner(text, label, url) {
    let b = document.getElementById('sat-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'sat-banner';
      document.body.appendChild(b);
    }
    b.textContent = text + ' ';
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', () => { window.location.href = url; });
    b.appendChild(btn);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'square'; osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 500);
    } catch (e) { /* sound is optional */ }
  }

  // The tab title is the only signal you still notice when the tab is in the
  // background.
  function flashTitle(text) {
    if (state.title === null) state.title = document.title;
    document.title = text + ' · ' + state.title;
  }
  function restoreTitle() {
    if (state.title !== null) { document.title = state.title; state.title = null; }
  }

  function updateCountdown() {
    renderSales();
    checkSaleAlerts();
    if (!state.running || !state.timer) { ui.next.textContent = ''; return; }
    const s = Math.max(0, Math.round((state.nextAt - Date.now()) / 1000));
    ui.next.textContent = 'volgende check over ' + s + ' s';
  }

  // Drag the panel by its header; double-click the header to snap it back.
  function applyPanelPos(pos) {
    const p = ui.panel;
    if (!pos) {
      p.style.left = p.style.top = '';
      p.style.right = '16px';
      p.style.bottom = '16px';
      return;
    }
    const w = p.offsetWidth || 440;
    p.style.right = p.style.bottom = 'auto';
    p.style.left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - Math.min(w, 120))) + 'px';
    p.style.top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 40)) + 'px';
  }

  function savePanelPos(pos) {
    try {
      if (pos) window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      else window.localStorage.removeItem(POS_KEY);
    } catch (e) { /* not remembered */ }
  }

  function readPanelPos() {
    try {
      const p = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null');
      return (p && Number.isFinite(p.left) && Number.isFinite(p.top)) ? p : null;
    } catch (e) { return null; }
  }

  function makeDraggable(head) {
    let start = null;
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = ui.panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      start.moved = true;
      ui.panel.classList.add('sat-dragging');
      applyPanelPos({ left: start.left + dx, top: start.top + dy });
    });
    window.addEventListener('mouseup', () => {
      if (!start) return;
      ui.panel.classList.remove('sat-dragging');
      if (start.moved) {
        const r = ui.panel.getBoundingClientRect();
        savePanelPos({ left: r.left, top: r.top });
      }
      start = null;
    });
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      savePanelPos(null);
      applyPanelPos(null);
    });
    window.addEventListener('resize', () => applyPanelPos(readPanelPos()));
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'sat-panel';
    // Static markup only: the AMO linter flags any non-literal innerHTML.
    panel.innerHTML =
      '<div class="sat-head"><span class="sat-title">Seat Assist</span>' +
      '<span class="sat-token">…</span>' +
      '<button class="sat-collapse" title="in-/uitklappen">–</button></div>' +
      '<div class="sat-body">' +
      '  <div class="sat-row"><button class="sat-events">Wedstrijden laden</button>' +
      '    <select class="sat-event"></select></div>' +
      '  <div class="sat-label">Blokken (klik = prioriteit, niets gekozen = alle): <button class="sat-refresh" title="blokken en vrije plaatsen verversen">↻</button></div>' +
      '  <div class="sat-sections"></div>' +
      '  <div class="sat-row"><label>Aantal: <input type="number" class="sat-count" min="1" value="1"></label>' +
      '    <select class="sat-mode" title="Hoe de stoelen bij elkaar moeten liggen">' +
      '      <option value="row">naast elkaar in één rij</option><option value="cluster">cluster (max 3 rijen)</option><option value="loose">los</option>' +
      '    </select>' +
      '    <select class="sat-kind" title="Welke plaatsen tellen mee">' +
      '      <option value="all">alles</option><option value="sale">alleen verkoop</option><option value="resale">alleen Ticketbörse</option>' +
      '    </select></div>' +
      '  <div class="sat-row"><label title="Rond dit tijdstip (vandaag) kijkt hij elke 5 seconden">Verkoopstart <input type="time" class="sat-armtime"></label>' +
      '    <input type="text" class="sat-armmatch" placeholder="auto-start: wedstrijd bevat…" title="Zodra een wedstrijd met deze tekst in de naam tickets krijgt, kiest hij die en start hij"></div>' +
      '  <div class="sat-row"><button class="sat-start">▶ Start</button><button class="sat-stop" disabled>■ Stop</button>' +
      '    <span class="sat-next"></span>' +
      '    <button class="sat-clear" title="Haalt alle kaarten uit de winkelwagen. Ze worden vrijgegeven.">🗑 Leeg</button></div>' +
      '  <div class="sat-watchcard"></div>' +
      '  <div class="sat-sales"></div>' +
      '  <div class="sat-counter sat-idle">Vrij nu: —</div>' +
      '  <div class="sat-log"></div>' +
      '</div>';
    document.body.appendChild(panel);

    ui.panel = panel;
    ui.token = panel.querySelector('.sat-token');
    panel.querySelector('.sat-title').textContent = 'Seat Assist · ' + CLUB;
    ui.event = panel.querySelector('.sat-event');
    ui.blocks = panel.querySelector('.sat-sections');
    ui.count = panel.querySelector('.sat-count');
    ui.mode = panel.querySelector('.sat-mode');
    ui.kind = panel.querySelector('.sat-kind');
    ui.armTime = panel.querySelector('.sat-armtime');
    ui.armMatch = panel.querySelector('.sat-armmatch');
    ui.startBtn = panel.querySelector('.sat-start');
    ui.stopBtn = panel.querySelector('.sat-stop');
    ui.next = panel.querySelector('.sat-next');
    ui.status = panel.querySelector('.sat-watchcard');
    ui.sales = panel.querySelector('.sat-sales');
    ui.counter = panel.querySelector('.sat-counter');
    ui.log = panel.querySelector('.sat-log');

    panel.querySelector('.sat-events').addEventListener('click', loadEvents);
    panel.querySelector('.sat-refresh').addEventListener('click', refreshBlocks);
    ui.event.addEventListener('change', onEventChange);
    ui.count.addEventListener('change', () => {
      const n = parseInt(ui.count.value, 10);
      state.want = n >= 1 ? n : 1;
      ui.count.value = String(state.want);
      saveSettings();
    });
    ui.mode.addEventListener('change', () => { state.mode = ui.mode.value; saveSettings(); });
    ui.kind.addEventListener('change', () => { state.kind = ui.kind.value; saveSettings(); });
    ui.armTime.addEventListener('change', () => {
      state.armTime = ui.armTime.value;
      saveSettings();
      log(state.armTime ? '⏱ Verkoopstart ' + state.armTime + ': van 2 min ervoor tot 15 min erna kijkt hij elke 5 s.' : '⏱ Geen verkoopstart ingesteld.');
      warnLogin();
    });
    ui.armMatch.addEventListener('change', () => {
      state.armMatch = ui.armMatch.value.trim();
      state.autoStarted = false;
      saveSettings();
      log(state.armMatch ? '🚀 Auto-start zodra "' + state.armMatch + '" tickets heeft.' : '🚀 Auto-start uit.');
      warnLogin();
    });
    ui.startBtn.addEventListener('click', start);
    ui.stopBtn.addEventListener('click', stop);
    panel.querySelector('.sat-clear').addEventListener('click', clearCart);
    panel.querySelector('.sat-collapse').addEventListener('click', (e) => {
      panel.classList.toggle('sat-min');
      e.target.textContent = panel.classList.contains('sat-min') ? '+' : '–';
    });

    const head = panel.querySelector('.sat-head');
    head.title = 'Sleep om te verplaatsen · dubbelklik voor de standaardplek';
    makeDraggable(head);
    applyPanelPos(readPanelPos());

    // Restore what was chosen before this page load.
    const s = readSettings();
    if (s) {
      state.eventId = s.eventId != null ? Number(s.eventId) : null;
      state.eventLabel = s.eventLabel || null;
      state.eventDate = s.eventDate || null;
      state.selected = Array.isArray(s.selected) ? s.selected.map(Number) : [];
      state.want = s.want >= 1 ? s.want : 1;
      state.mode = MODE_TEXT[s.mode] ? s.mode : (s.together === false ? 'loose' : 'row');
      state.kind = ['all', 'sale', 'resale'].includes(s.kind) ? s.kind : 'all';
      state.armTime = typeof s.armTime === 'string' ? s.armTime : '';
      state.armMatch = typeof s.armMatch === 'string' ? s.armMatch : '';
    }
    // On a venue page, that event is the obvious choice.
    const here = /\/areaplan\/venue\/event\/(\d+)/.exec(window.location.pathname);
    if (here && Number(here[1]) !== state.eventId) {
      state.eventId = Number(here[1]);
      state.eventLabel = null;
      state.eventDate = null;
      state.selected = [];
      saveSettings();
    }
    // This page already holds what loadVenue would fetch (signature, blocks,
    // prices) — right after the queue that saves a request.
    if (here) {
      const v = core.parseVenuePage(document.documentElement.outerHTML);
      if (v.seatmap) useVenue(v);
    }
    ui.count.value = String(state.want);
    ui.mode.value = state.mode;
    ui.kind.value = state.kind;
    ui.armTime.value = state.armTime;
    ui.armMatch.value = state.armMatch;
    fillEvents();
    renderBlocks();

    const logged = [...document.scripts].map(x => /"user_logged":(true|false)/.exec(x.textContent)).find(Boolean);
    setLogin(logged ? logged[1] === 'true' : null);

    setInterval(updateCountdown, 1000);
    // A flashed title has done its job once you look at the tab.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.running) setTimeout(restoreTitle, 3000);
    });
    loadSchedule();
    setInterval(loadSchedule, SCHEDULE_REFRESH_MS);
    setTimeout(watchEvents, 3000);
    log('Klaar. Log in, klik "Wedstrijden laden" en kies een wedstrijd.');

    if (wasRunning() && state.eventId != null) {
      log('↻ Hervat na het laden van de pagina.');
      sleep(1500).then(start);
    }
  }

  buildPanel();
})();
