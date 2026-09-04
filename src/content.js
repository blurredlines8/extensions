(function () {
  'use strict';
  if (window.__seatAssistLoaded) return;
  window.__seatAssistLoaded = true;

  const API = '__API_ORIGIN__';
  const INTERVAL_MS = 5000;
  const CART_URL = '__SHOP_ORIGIN__/shopping-cart';
  const SHOP_URL = '__SHOP_ORIGIN__/';
  // While there are no sections yet the monitor need not run at full speed;
  // that wait can last for days. The event record is refreshed on this same
  // slow cadence, since it changes rarely.
  const WAIT_INTERVAL_MS = 30000;

  const state = {
    events: [],
    eventId: null,
    eventCategory: null,   // SaleCategoryId of the chosen event (varies per event type)
    sections: [],          // all sections of the event's category, sorted by name
    selectedOrder: [],     // VenueBuildingBlockIds in priority order (click order)
    desiredSeats: {},      // vbbId -> Set of specific seat Ids (empty = first available)
    wantedCount: 1,
    timer: null,
    watch: { timer: null, prev: null, alerted: false, title: null },
    unplacedSeen: new Set(),   // sections whose unplaced shape we already logged
    lastSections: 0,           // section count from the previous round
    lastPoll: 0,               // timestamp of the previous round (for the wait mode)
    evRecord: null,            // most recently fetched event record
    evFetched: 0,
    right: null,               // this customer's purchase right for the event (or null)
    session: { wasCustomer: false, lastRefresh: 0 },
    prevKeys: null,        // available seat keys from the previous tick (for churn)
    totalAppeared: 0,      // cumulative seats that appeared over the run
    reloading: false,      // guards against ticking while a reload runs
    cart: {
      reservationId: null, reservationUID: null,
      orderId: null, orderUID: null,   // the PendingOrder = the visible shopping cart
      placed: [],          // {section, col} for each carted seat, for reload/re-add
      acquired: 0, attempted: new Set(), done: false,
    },
  };

  // Always read the token fresh: the shop rotates sessionStorage.jwt during a
  // session, and we want whatever is current — never a stale copy.
  const getToken = () => {
    try { return window.sessionStorage.getItem('jwt'); } catch (e) { return null; }
  };
  const getSsoCookie = () => {
    try { return window.sessionStorage.getItem('storedCookie'); } catch (e) { return null; }
  };
  // Mirror the shop's own request headers exactly: it sends the SSO cookie and a
  // "no-auth" flag alongside the bearer token, and the API's CORS allows both.
  const headers = () => {
    const h = {
      Authorization: 'Bearer ' + getToken(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'no-auth': 'true',
    };
    const sso = getSsoCookie();
    if (sso) h['sso-cookie'] = sso;
    return h;
  };
  const nowStr = () => new Date().toLocaleTimeString('nl-NL');
  // Only PlacementTypeId 1 is a real, bookable seat; 2/3 are stairs/aisle/
  // "no-seat" (always report as "free" because they are never sold).
  const isSeat = c => c.PlacementTypeId === 1;

  // ------------------------------------------------------------------ API ---
  // Raw event records: the status card needs fields that the mapping below
  // throws away (ButtonData, OnGeneralSaleFrom, …).
  async function getEventsRaw() {
    const res = await fetch(API + '/v2/Event', { credentials: 'omit', headers: headers() });
    if (!res.ok) throw new Error('Event HTTP ' + res.status);
    const data = await res.json();
    return data.TabItems.flatMap(t => t.Items);
  }

  async function getEvents() {
    const items = await getEventsRaw();
    return items.map(i => ({ name: i.Name, eventId: i.EventId, saleCategoryId: i.SaleCategoryId }));
  }

  async function getVenue(eventId) {
    const res = await fetch(API + '/v2/Venue/venue', {
      method: 'POST', credentials: 'omit', headers: headers(),
      body: JSON.stringify({ PassePartoutId: null, EventIds: [eventId], InitiativeGuid: null }),
    });
    if (!res.ok) throw new Error('Venue HTTP ' + res.status);
    return res.json();
  }

  async function getSection(vbbId, eventId) {
    const res = await fetch(API + '/v2/Availability/section', {
      method: 'POST', credentials: 'omit', headers: headers(),
      body: JSON.stringify({ ParentVBBId: vbbId, GroupingId: null, EventIds: [eventId], PassePartoutIds: null, InitiativeGuid: null }),
    });
    if (!res.ok) throw new Error('Section HTTP ' + res.status);
    return res.json();
  }

  // Sections without numbered seats (standing room, away sections) have their
  // own endpoint. Payload derived from the shop bundle (getUnplacedData).
  async function getSectionUnplaced(vbbId, eventId) {
    const res = await fetch(API + '/v2/Availability/section-unplaced', {
      method: 'POST', credentials: 'omit', headers: headers(),
      body: JSON.stringify({ ParentVBBId: vbbId, EventIds: [eventId], PassePartoutIds: null, InitiativeGuid: getInitiativeGuid() }),
    });
    if (!res.ok) throw new Error('SectionUnplaced HTTP ' + res.status);
    return res.json();
  }

  // The shop passes the value from sessionStorage['ai'] here; we did not.
  // It may matter for sales gated behind purchase rights.
  const getInitiativeGuid = () => {
    try { return window.sessionStorage.getItem('ai') || null; } catch (e) { return null; }
  };

  // Exactly how the shop decides it: no rows returned = an unplaced section.
  const isUnplacedDetail = d => !d || !d.Rows || d.Rows.length === 0;

  // Venue/venue already carries a count per section: AvailableSeats (226, 65,
  // 136 … on FC Eindhoven's home fixtures) and TicketsPerTicketTypeId. For a
  // section without seat numbers that is the source; section-unplaced is then
  // only needed for the details.
  function countFromSection(section) {
    if (!section) return null;
    const t = section.TicketsPerTicketTypeId;
    if (t && typeof t === 'object') {
      const n = Object.values(t).reduce((a, b) => a + (Number(b) || 0), 0);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return Number.isFinite(section.AvailableSeats) ? section.AvailableSeats : null;
  }

  function countUnplaced(u) {
    if (!u) return null;
    const t = u.Details && u.Details.TicketsPerTicketTypeId;
    if (t && typeof t === 'object') {
      const n = Object.values(t).reduce((a, b) => a + (Number(b) || 0), 0);
      if (Number.isFinite(n)) return n;
    }
    if (Array.isArray(u.Availability) && u.Availability.length) {
      const n = u.Availability.reduce((a, x) =>
        a + (Number(x.Amount ?? x.Available ?? x.AvailableCount ?? x.Count) || 0), 0);
      if (n > 0) return n;
    }
    return null;
  }

  // Returns 'ok' | 'unavailable' (definitively gone/not allowed) | 'error' (retry).
  async function claimSeat(section, col) {
    const body = {
      PendingReservationId: state.cart.reservationId,
      PendingReservationUID: state.cart.reservationUID,
      ParentVenueBuildingBlockId: section.VenueBuildingBlockId,
      Row: col.Row,
      Column: col.Column,
      TicketTypeId: null,
      PassePartoutIds: null,
      EventIds: [state.eventId],
      MaximumTicketAmount: state.wantedCount,
      AllowAutoSelect: false,
      InitiativeGuid: null,
    };
    const post = () => fetch(API + '/v2/Availability/select-position', {
      method: 'POST', credentials: 'omit', headers: headers(), body: JSON.stringify(body),
    });
    try {
      let res = await post();
      if (!res.ok) { log('  select-position HTTP ' + res.status); return 'error'; }
      let data = await res.json();

      // The seat map sometimes needs a bundle/multi selection; the shop retries
      // the same call with AllowAutoSelect enabled, so we mirror that.
      if (data.ResultCode === 'MultiSelectRequired' || data.ResultCode === 'BundleRequired') {
        body.AllowAutoSelect = true;
        res = await post();
        if (!res.ok) { log('  select-position (auto-select) HTTP ' + res.status); return 'error'; }
        data = await res.json();
      }

      if (data.ResultCode === 'OK' && data.UpdatedPendingReservation) {
        state.cart.reservationId = data.UpdatedPendingReservation.PendingReservationId;
        state.cart.reservationUID = data.UpdatedPendingReservation.PendingReservationUID;
        return 'ok';
      }
      log('  ✗ Niet gelukt (' + (data.ResultCode || 'onbekend') + ')');
      return 'unavailable';
    } catch (e) {
      log('  select-position error: ' + e.message);
      return 'error';
    }
  }

  // Renew the shop session. The shop-JWT in sessionStorage lives 24h; this
  // endpoint (the one the shop itself calls after linking friends) returns a
  // fresh JWT good for another 24h. The API does not enforce the SSO tokens
  // embedded in it (verified: a JWT kept working 8h after its inner access
  // token expired), so this alone keeps the session alive.
  //
  // Not to be confused with the ShopGuard/queue token refresh — that is the
  // waiting room and we do not touch it.
  async function refreshSession() {
    const res = await fetch(API + '/v2/Account/token/managed-customerids/refresh', {
      credentials: 'omit', headers: headers(),
    });
    if (!res.ok) throw new Error('refresh HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.Token) throw new Error('refresh: no Token (' + (data && data.AuthResult) + ')');
    return data.Token;
  }

  // Decode the JWT payload without verifying it; we only need type and expiry.
  function decodeJwt(tok) {
    try {
      const p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(p + '='.repeat((4 - p.length % 4) % 4)));
    } catch (e) { return null; }
  }

  // How many tickets this customer may buy for the event. A PUT, but it only
  // answers; the shop fires it on every event selection. Body derived from the
  // bundle (initializeEventSelection). Returns the first right or null.
  // Observed: AmountSelectable is the sum over PurchaseRightsPerCustomer
  // (6 managed customers × 4 = 24 on a home fixture); [] means no right yet.
  async function getPurchaseRight(eventId) {
    const res = await fetch(API + '/v2/PurchaseRight/for-event', {
      method: 'PUT', credentials: 'omit', headers: headers(),
      body: JSON.stringify({
        EventId: eventId, SaleCategoryIds: state.eventCategory != null ? [state.eventCategory] : null,
        PendingOrderId: state.cart.orderId, PendingOrderUID: state.cart.orderUID,
        InitiativeGuid: getInitiativeGuid(),
      }),
    });
    if (!res.ok) throw new Error('PurchaseRight HTTP ' + res.status);
    const list = await res.json();
    return Array.isArray(list) && list.length ? list[0] : null;
  }

  // Buy a spot in a section without seat numbers. Payload derived from the shop
  // bundle (addUnplacedTickets → unplaced-event-selection): a single call takes
  // `amount` spots at once, unlike seats where we go one by one. Returns
  // 'ok' | 'unavailable' | 'error', just like claimSeat.
  //
  // NOTE: this call was derived from their JavaScript, never observed in the
  // wild. The first time it fires is the real thing.
  async function claimUnplaced(section, amount) {
    const body = {
      PendingReservationId: state.cart.reservationId,
      PendingReservationUID: state.cart.reservationUID,
      Amount: amount,
      MarketplacePrices: null,
      AllowAutoSelect: false,
      ParentVenueBuildingBlockId: section.VenueBuildingBlockId,
      EventIds: [state.eventId],
      InitiativeGuid: getInitiativeGuid(),
    };
    const post = () => fetch(API + '/v2/PendingReservation/unplaced-event-selection', {
      method: 'POST', credentials: 'omit', headers: headers(), body: JSON.stringify(body),
    });
    try {
      let res = await post();
      if (!res.ok) { log('  unplaced-event-selection HTTP ' + res.status); return 'error'; }
      let data = await res.json();

      // Same second attempt as for seats; the shop does it this way too.
      if (data.ResultCode === 'MultiSelectRequired' || data.ResultCode === 'BundleRequired') {
        body.AllowAutoSelect = true;
        res = await post();
        if (!res.ok) { log('  unplaced (auto-select) HTTP ' + res.status); return 'error'; }
        data = await res.json();
      }

      if (data.ResultCode === 'OK' && data.UpdatedPendingReservation) {
        state.cart.reservationId = data.UpdatedPendingReservation.PendingReservationId;
        state.cart.reservationUID = data.UpdatedPendingReservation.PendingReservationUID;
        return 'ok';
      }
      log('  ✗ Niet gelukt (' + (data.ResultCode || 'onbekend') + ')');
      return 'unavailable';
    } catch (e) {
      log('  unplaced-event-selection error: ' + e.message);
      return 'error';
    }
  }

  // Second half of the shop's own flow: move the held reservation into a
  // PendingOrder (the visible shopping cart). Without this the seat is reserved
  // server-side but never shows up in the cart. Returns true on success.
  async function placeInOrder() {
    const body = {
      PendingReservationId: state.cart.reservationId,
      PendingReservationUID: state.cart.reservationUID,
      PendingOrderId: state.cart.orderId,
      PendingOrderUID: state.cart.orderUID,
      InitiativeGuid: null,
    };
    try {
      const res = await fetch(API + '/v2/PendingReservation/place-in-pendingorder', {
        method: 'PUT', credentials: 'omit', headers: headers(), body: JSON.stringify(body),
      });
      if (!res.ok) { log('  place-in-pendingorder HTTP ' + res.status); return false; }
      const data = await res.json();
      if (!data.Handled) {
        log('  ✗ Kon niet in winkelwagen plaatsen (' + (data.HandledErrorMessage || 'onbekend') + ')');
        return false;
      }
      // Remember the order so further seats join the same cart, and write it
      // where the shop reads its cart from so the UI shows it.
      state.cart.orderId = data.PendingOrderId;
      state.cart.orderUID = data.PendingOrderUID;
      try {
        window.sessionStorage.setItem('shoppingCartData',
          JSON.stringify({ PendingOrderId: data.PendingOrderId, PendingOrderUID: data.PendingOrderUID }));
      } catch (e) { /* no sessionStorage access is not fatal */ }
      // Placing clears the reservation server-side; the next seat starts fresh.
      state.cart.reservationId = null;
      state.cart.reservationUID = null;
      return true;
    } catch (e) {
      log('  place-in-pendingorder error: ' + e.message);
      return false;
    }
  }

  async function getOrderDetails(orderId, orderUID) {
    const res = await fetch(API + '/v2/PendingOrder/' + encodeURIComponent(orderId) + '/details/' + encodeURIComponent(orderUID), {
      method: 'GET', credentials: 'omit', headers: headers(),
    });
    if (!res.ok) { log('  order-details HTTP ' + res.status); return null; }
    return res.json();
  }

  // Persist just enough to survive a page refresh (the content script's in-memory
  // state is wiped on reload, but the cart lives on server-side). Stored in
  // sessionStorage so it shares the cart's own per-tab lifetime.
  const CART_CTX_KEY = 'ntsCartContext';
  function persistCart() {
    try {
      window.sessionStorage.setItem(CART_CTX_KEY, JSON.stringify({
        eventId: state.eventId,
        eventCategory: state.eventCategory,
        orderId: state.cart.orderId,
        orderUID: state.cart.orderUID,
        placed: (state.cart.placed || []).map(p => ({
          section: { VenueBuildingBlockId: p.section.VenueBuildingBlockId, Name: p.section.Name },
          spots: p.spots || null,
          col: p.col ? { Row: p.col.Row, Column: p.col.Column, RowNumber: p.col.RowNumber, SeatNumber: p.col.SeatNumber, Id: p.col.Id } : null,
        })),
      }));
    } catch (e) { /* sessionStorage may fail; not fatal */ }
  }
  function restoreCart() {
    try {
      const raw = window.sessionStorage.getItem(CART_CTX_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      if (c.eventId != null) state.eventId = c.eventId;
      if (c.eventCategory != null) state.eventCategory = c.eventCategory;
      state.cart.orderId = c.orderId || null;
      state.cart.orderUID = c.orderUID || null;
      state.cart.placed = Array.isArray(c.placed) ? c.placed : [];
      state.cart.acquired = state.cart.placed.length;
      if (state.cart.placed.length) {
        log('↩️ Winkelwagen-context hersteld: ' + state.cart.placed.length + ' stoel(en). "🔄 Herlaad" is available.');
      }
    } catch (e) { /* ignore a corrupt context */ }
  }

  // Reload: throw the carted seats out of the shopping cart and put them back
  // again — a clean slate for when a seat appears to be "stuck". Does exactly
  // what the shop does (DELETE the lines, clear the order) and rebuilds after.
  async function reloadCart() {
    const placed = (state.cart.placed || []).slice();
    if (!state.cart.orderId || !placed.length) { log('Niks in de winkelwagen om te herladen.'); return; }
    if (state.reloading) return;
    state.reloading = true;
    ui.reloadBtn.disabled = true;
    const orderId = state.cart.orderId, orderUID = state.cart.orderUID;
    try {
      log('🔄 Winkelwagen herladen (' + placed.length + ' stoel(en))…');

      // 1. Remove the seat lines (ProductType 2/3 = delivery/payment line, we
      //    leave those). Every line has an .Id = the line id for the DELETE.
      const details = await getOrderDetails(orderId, orderUID);
      const lines = (details && (details.OrderLines
        || (details.PendingOrderDetails && details.PendingOrderDetails.OrderLines))) || [];
      const seatLines = lines.filter(l => l.ProductType !== 2 && l.ProductType !== 3 && l.Id != null);
      for (const l of seatLines) {
        try {
          const res = await fetch(API + '/v2/PendingOrderLine/' + encodeURIComponent(l.Id) +
            '/' + encodeURIComponent(orderId) + '/' + encodeURIComponent(orderUID), {
            method: 'DELETE', credentials: 'omit', headers: headers(),
          });
          if (!res.ok) log('  delete-line HTTP ' + res.status);
        } catch (e) { log('  delete-line error: ' + e.message); }
      }

      // 2. Clear the (now empty) order.
      try {
        await fetch(API + '/v2/PendingOrder/' + encodeURIComponent(orderId) + '/clear/' + encodeURIComponent(orderUID), {
          method: 'GET', credentials: 'omit', headers: headers(),
        });
      } catch (e) { log('  clear error: ' + e.message); }

      // Fresh start: the next placement creates a new order.
      state.cart.orderId = null; state.cart.orderUID = null;
      state.cart.reservationId = null; state.cart.reservationUID = null;
      state.cart.placed = [];
      persistCart();
      try { window.sessionStorage.removeItem('shoppingCartData'); } catch (e) { /* ok */ }

      // 3. Put the same seats back into the shopping cart.
      let back = 0;
      for (const p of placed) {
        // Spots (unplaced) are re-claimed by amount; seats by position.
        const r = p.spots ? await claimUnplaced(p.section, p.spots) : await claimSeat(p.section, p.col);
        if (r === 'ok' && await placeInOrder()) {
          state.cart.placed.push(p);
          back++;
          log('  ✓ opnieuw: ' + p.section.Name + (p.spots
            ? ' ' + p.spots + ' plek(ken)'
            : ' rij ' + p.col.RowNumber + ' stoel ' + p.col.SeatNumber));
        } else {
          log('  ✗ mislukt/niet meer vrij: ' + p.section.Name + (p.spots
            ? ' ' + p.spots + ' plek(ken)'
            : ' rij ' + p.col.RowNumber + ' stoel ' + p.col.SeatNumber));
        }
      }
      state.cart.acquired = state.cart.placed.length;
      persistCart();
      log('🔄 Herladen klaar (' + back + '/' + placed.length + ' terug in winkelwagen).');
    } finally {
      state.reloading = false;
      ui.reloadBtn.disabled = false;
    }
  }

  // -------------------------------------------------------------- monitor ---
  // One monitor for both kinds of event; which kind it is follows from the
  // venue map itself:
  //
  //   no sections          → nothing to take yet, keep watching
  //   section with rows    → home fixture: pick a seat
  //   section without rows → away fixture: buy a spot in that section
  //
  // That is exactly the rule the shop itself applies (no Rows = unplaced).
  async function tick() {
    if (state.cart.done || state.reloading) return;
    if (!getToken()) { log('⚠️ Geen token in sessionStorage — ben je ingelogd?'); return; }

    // In wait mode (no sections yet) every 5 seconds is pointless; this can go
    // on for days. Once sections exist we switch to full speed.
    const now = Date.now();
    if (state.lastSections === 0 && state.lastPoll && now - state.lastPoll < WAIT_INTERVAL_MS) return;
    state.lastPoll = now;

    try {
      // The event record changes slowly; do not fetch it every round.
      if (!state.evRecord || now - state.evFetched > WAIT_INTERVAL_MS) {
        const fresh = (await getEventsRaw()).find(i => i.EventId === state.eventId);
        if (fresh) { reportEventChanges(fresh); state.evRecord = fresh; }
        state.evFetched = now;
        try {
          const r = await getPurchaseRight(state.eventId);
          const was = state.right ? state.right.AmountSelectable : null;
          state.right = r;
          if (r && was !== r.AmountSelectable) {
            const per = (r.PurchaseRightsPerCustomer || []).length;
            log('🎟️ kooprecht: ' + showVal(was) + ' → ' + r.AmountSelectable + ' kaart(en)' +
                (per > 1 ? ' voor ' + per + ' personen' : '') +
                (r.Transferable ? ' · overdraagbaar' : ' · op naam van de rechthebbende'));
          }
        } catch (e) { /* no right info is not fatal; the card shows it as unknown */ }
      }

      const venue = await getVenue(state.eventId);
      const vs = summarisePlacements(venue);
      if (state.evRecord) renderWatchCard(state.evRecord, vs);
      reportVenueChanges(vs);
      state.lastSections = vs.sections;

      const isAvail = s =>
        s.SaleCategoryId === state.eventCategory &&
        (s.HasTicketsAvailable === true || s.HasMarketplaceTicketsAvailable === true);

      let secs;
      if (state.selectedOrder.length) {
        const priority = new Map(state.selectedOrder.map((v, i) => [v, i]));
        secs = venue.Sections
          .filter(s => isAvail(s) && priority.has(s.VenueBuildingBlockId))
          .sort((a, b) => priority.get(a.VenueBuildingBlockId) - priority.get(b.VenueBuildingBlockId));
      } else {
        // No explicit preference: every section that currently has seats.
        secs = venue.Sections.filter(isAvail);
      }

      if (!secs.length) {
        ui.counter.textContent = vs.sections
          ? 'Nog niets vrij in je voorkeursvak(ken) · ' + nowStr()
          : 'Wachten op vakken · gecontroleerd ' + nowStr();
        return;
      }

      // One fetch per section, reused for both the counter and the claim pass.
      const gathered = [];
      const currentKeys = new Set();
      for (const section of secs) {
        const detail = await getSection(section.VenueBuildingBlockId, state.eventId);

        if (isUnplacedDetail(detail)) {
          let n = countFromSection(section);
          if (n === null) {
            try { n = countUnplaced(await getSectionUnplaced(section.VenueBuildingBlockId, state.eventId)); }
            catch (e) { log('  section-unplaced ' + section.Name + ': ' + e.message); }
          }
          if (!state.unplacedSeen.has(section.VenueBuildingBlockId)) {
            state.unplacedSeen.add(section.VenueBuildingBlockId);
            log('🎫 ' + section.Name + ' is een vak zonder stoelnummers · ' +
                (n === null ? 'aantal onbekend' : n + ' plek(ken) vrij'));
          }
          gathered.push({ section, seats: [], spots: n });
          continue;
        }

        const seats = detail.Rows
          .flatMap(r => r.Columns)
          .filter(c => isSeat(c) && (c.IsAvailableForSale === true || c.AvailableForSecondary === true));
        gathered.push({ section, seats });
        for (const c of seats) currentKeys.add(section.VenueBuildingBlockId + ':' + c.Id);
      }

      updateChurn(currentKeys, gathered);

      for (const g of gathered) {
        if (state.cart.done) break;
        if (g.seats.length) { await claimSeats(g.section, g.seats); continue; }
        if (g.spots !== 0) await claimSpots(g.section, g.spots);
      }
    } catch (e) {
      log('Fout: ' + e.message);
    }
  }

  // Home fixture: seat by seat, in the priority order you picked.
  async function claimSeats(section, seats) {
    const desired = state.desiredSeats[section.VenueBuildingBlockId];
    const pool = (desired && desired.size) ? seats.filter(c => desired.has(c.Id)) : seats;
    for (const col of pool) {
      if (state.cart.done) break;
      const key = section.VenueBuildingBlockId + ':' + col.Id;
      if (state.cart.attempted.has(key)) continue;

      log('➡️ Poging: ' + section.Name + ' — rij ' + col.RowNumber + ', stoel ' + col.SeatNumber);
      const result = await claimSeat(section, col);
      if (result === 'ok' || result === 'unavailable') state.cart.attempted.add(key);
      if (result !== 'ok') continue;

      log('  · vastgehouden, in winkelwagen plaatsen…');
      if (!await placeInOrder()) continue;
      state.cart.placed.push({ section, col });
      state.cart.acquired++;
      persistCart();
      log('  ✓ In winkelwagen: ' + section.Name + ' rij ' + col.RowNumber + ' stoel ' + col.SeatNumber +
          ' (' + state.cart.acquired + '/' + state.wantedCount + ')');
      if (state.cart.acquired >= state.wantedCount) { onSuccess(); return; }
    }
  }

  // Away fixture: no seat choice; a single call takes the whole requested
  // amount of spots in this section. If that fails definitively we skip the
  // section for this run — otherwise we would fire a purchase request every
  // single round.
  async function claimSpots(section, available) {
    if (state.cart.done) return;
    const key = 'vak:' + section.VenueBuildingBlockId;
    if (state.cart.attempted.has(key)) return;

    let wanted = state.wantedCount - state.cart.acquired;
    // Never ask for more than the purchase right allows; the API refuses the
    // whole request rather than trimming it.
    const r = state.right;
    if (r && !r.UnlimitedAmount && Number.isFinite(r.AmountSelectable) && r.AmountSelectable < wanted) {
      log('  kooprecht staat ' + r.AmountSelectable + ' toe; gewenst ' + wanted + ' — aantal verlaagd.');
      wanted = r.AmountSelectable;
    }
    if (wanted <= 0) return;
    const take = (available === null) ? wanted : Math.min(wanted, available);
    if (take <= 0) return;

    // The API may refuse one big request (the per-person cap is 4) while
    // accepting the same total in chunks: try whole, then 4 + remainder, then
    // singles. Every OK adds to the same PendingReservation.
    const plan = take <= 4 ? [take] : [4, take - 4];
    let got = 0;
    for (const chunk of plan) {
      log('➡️ Poging: ' + chunk + ' plek(ken) in ' + section.Name);
      const result = await claimUnplaced(section, chunk);
      if (result === 'ok') { got += chunk; continue; }
      if (result !== 'unavailable') break;                 // network/5xx: retry next round
      if (chunk === 1) break;
      for (let i = 0; i < chunk; i++) {                    // last resort: one by one
        if (await claimUnplaced(section, 1) !== 'ok') break;
        got++;
      }
      break;
    }
    if (!got) { state.cart.attempted.add(key); return; }

    log('  · ' + got + ' vastgehouden, in winkelwagen plaatsen…');
    if (!await placeInOrder()) return;
    state.cart.placed.push({ section, spots: got });
    state.cart.acquired += got;
    persistCart();
    log('  ✓ In winkelwagen: ' + got + ' plek(ken) in ' + section.Name +
        ' (' + state.cart.acquired + '/' + state.wantedCount + ')');
    if (state.cart.acquired >= state.wantedCount) onSuccess();
  }

  // Compare this tick's available seats to the previous tick and report the
  // churn. Seats leaving/returning are exactly the carts expiring or filling.
  function updateChurn(currentKeys, gathered) {
    const prev = state.prevKeys;
    let added = 0, removed = 0;
    if (prev) {
      currentKeys.forEach(k => { if (!prev.has(k)) added++; });
      prev.forEach(k => { if (!currentKeys.has(k)) removed++; });
      state.totalAppeared += added;
    }
    state.prevKeys = currentKeys;

    // For an away fixture there are no seat keys to count; the number of free
    // spots per section is then the only meaningful figure.
    const spots = (gathered || [])
      .filter(g => g.spots != null)
      .reduce((a, g) => a + g.spots, 0);
    const heeftPlekken = (gathered || []).some(g => g.spots != null);

    ui.counter.textContent = heeftPlekken
      ? 'Vrije spots: ' + spots + ' · ' + nowStr()
      : 'Vrij nu: ' + currentKeys.size +
        (prev ? '  ·  +' + added + ' / -' + removed + '  (totaal bijgekomen: ' + state.totalAppeared + ')' : '');
    if (prev && (added || removed)) {
      log('🔄 ' + currentKeys.size + ' vrij · +' + added + ' bij / -' + removed + ' weg');
    }
  }

  // ----------------------------------------------------- event status ---
  // The event record from /v2/Event says whether the sale is open. While there
  // are no sections yet this is the only sign of life, so we report every
  // change and raise the alarm as soon as buying becomes possible.
  const WATCH_FIELDS = [
    ['CurrentlyOnSaleForUser', 'verkoop open voor jou'],
    ['OnSaleForUserFrom', 'verkoop voor jou vanaf'],
    ['HasGeneralSale', 'vrije verkoop'],
    ['OnGeneralSaleFrom', 'vrije verkoop vanaf'],
    ['HasTicketsAvailable', 'kaarten available'],
    ['HasSoldOut', 'uitverkocht'],
    ['SalesFlowAllowed', 'verkoopflow toegestaan'],
    ['PurchaseRightAvailableAfterLogin', 'kooprecht na inloggen'],
    ['ButtonData.ActionType', 'knop-actie'],
    ['ButtonData.TranslationCode', 'knoptekst'],
    ['ButtonData.Action', 'knop-doel'],
    // The window of the current button: ActiveTill is the moment the shop flips
    // to the next phase — often exactly when the sale starts.
    ['ButtonData.ActiveFrom', 'knop actief vanaf'],
    ['ButtonData.ActiveTill', 'knop actief tot'],
  ];

  const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const showVal = v => (v === null || v === undefined || v === '' ? '—' : String(v));

  // "There is something to take now". ButtonData comes in two shapes, verified
  // against two independent shops on this same backend platform:
  //
  //   • stub (Id 0 / EventId 0) = no custom button configured. The shop renders
  //     its default button and the TranslationCode carries the real status:
  //     BTN.SALE.BUYNOW / BTN.SALE.LOGINTOBUY = buyable, BTN.SALE.SOLDOUT = out.
  //   • configured (Id != 0) = a club label such as "Info volgt" or "Start
  //     verkoop 7 sept", with ActionType 'Disabled' or -1. That is precisely NOT
  //     a sale, just an announcement.
  //
  // ActionType is therefore useless as an alarm signal (-1 and 'Disabled' both
  // mean "nothing to do", null only means "no custom button"). We go by the
  // flags, with the default button as corroboration.
  const isDefaultButton = b => !!b && !b.Id;
  const buttonCode = ev => (isDefaultButton(ev.ButtonData) ? ev.ButtonData.TranslationCode : null);

  // BTN.SALE.LOGINTOBUY does NOT count as a sale. Measured at FC Eindhoven:
  // their away fixtures sit on LOGINTOBUY with CurrentlyOnSaleForUser=false and
  // PurchaseRightAvailableAfterLogin=true — "log in, there may be something for
  // you", not a moment to buy. We run inside a logged-in session, so that button
  // here rather means the login is gone. Separate notice, no alarm.
  const isOnSale = ev =>
    ev.CurrentlyOnSaleForUser === true ||
    ev.HasGeneralSale === true ||
    buttonCode(ev) === 'BTN.SALE.BUYNOW';

  const needsLogin = ev => buttonCode(ev) === 'BTN.SALE.LOGINTOBUY';

  // Away fixtures return Sections: [], but Venue/venue does reveal how many
  // placements there are and which prices they carry. Those prices get filled in
  // as the sale approaches — an early signal, well before the button flips.
  function summarisePlacements(venue) {
    const epf = (venue && venue.Filters && venue.Filters.EventPlacementFilters) || [];
    const byPrice = new Map();
    epf.forEach(x => {
      if (x.BasePrice == null) return;
      byPrice.set(x.BasePrice, (byPrice.get(x.BasePrice) || 0) + 1);
    });
    const prices = [...byPrice.entries()].sort((a, b) => a[0] - b[0]);
    const tiers = prices.map(([prijs, n]) => n + '× €' + prijs.toFixed(2));
    const secs = (venue && venue.Sections) || [];
    const available = secs.reduce((a, x) => {
      const n = countFromSection(x);
      return a + (n || 0);
    }, 0);
    return {
      sections: secs.length,
      available: secs.length ? available : null,
      placements: epf.length,
      priced: [...byPrice.values()].reduce((a, b) => a + b, 0),
      prices,
      tiers: tiers.join(' · ') || '—',
    };
  }

  // The API sends naive timestamps without a zone. That they are UTC follows
  // from the button itself: ActiveTill 2026-09-03T10:00:00 belongs to button
  // text "03-09, 12:00 uur" — exactly the CEST offset. So we show local time as
  // well as the raw value, making a wrong assumption obvious straight away.
  const asUtcDate = v => {
    if (!v || typeof v !== 'string') return null;
    const d = new Date(/[Z+]|-\d\d:\d\d$/.test(v) ? v : v + 'Z');
    return isNaN(d.getTime()) ? null : d;
  };
  const fmtLocal = d => d.toLocaleString('nl-NL',
    { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // Scale the granularity with the distance: seconds are noise across ten days,
  // and nobody reads "244u".
  function fmtDuration(ms) {
    if (ms < 0) return null;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), u = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + u + 'u';
    if (s >= 3600) return u + 'u ' + m + 'm';
    if (s >= 600) return m + 'm';
    return (m ? m + 'm ' : '') + sec + 's';
  }
  const yesNo = v => (v === true ? 'ja' : v === false ? 'nee' : '—');

  const snapshot = ev => {
    const s = {};
    WATCH_FIELDS.forEach(([path]) => { s[path] = showVal(pick(ev, path)); });
    return s;
  };

  // What the shop button means, in plain language. The BTN.SALE.* codes are the
  // default button; a club's own label we show unchanged, it says more.
  const STATUS_TEXT = {
    'BTN.SALE.SOLDOUT': 'Uitverkocht',
    'BTN.SALE.BUYNOW': 'In verkoop',
    'BTN.SALE.LOGINTOBUY': 'Inloggen om te kopen',
    'BTN.SALE.NOTONSALE': 'Niet in verkoop voor jou',
  };

  // Shorten long price lists to a range; six tiers in a row fill half the card
  // and say no more than "from … to …".
  function priceLabel(vs) {
    if (!vs || !vs.prices || !vs.prices.length) return null;
    const p = vs.prices;
    if (p.length <= 2) return p.map(([prijs, n]) => n + '× €' + prijs.toFixed(2)).join(' · ');
    const lo = p[0][0], hi = p[p.length - 1][0];
    return '€' + lo.toFixed(2) + ' – €' + hi.toFixed(2) + ' (' + p.length + " staffels)";
  }

  function renderWatchCard(ev, vs) {
    const card = ui.watchCard;
    card.innerHTML = '';
    const open = isOnSale(ev);
    // Logged in, the API tells this customer exactly when their phase opens:
    // OnSaleForUserFrom (UTC). That beats guessing from the button. Observed on
    // event 260: anonymous null, logged in '2026-09-04T10:00:00' while the
    // button still announced an earlier phase meant for other card holders.
    const forUser = asUtcDate(ev.OnSaleForUserFrom);
    const till = asUtcDate(pick(ev, 'ButtonData.ActiveTill'));
    // If the button's end coincides with kickoff it is a placeholder ("Info
    // volgt") and not a sale moment — do not count down then, or we suggest an
    // opening time that means nothing.
    const kickoff = asUtcDate(ev.EventStartDateTime);
    const isPlaceholder = !!(till && kickoff && till.getTime() === kickoff.getTime());
    const target = forUser || (isPlaceholder ? null : till);
    state.watch.opensAt = (open || !target || target.getTime() <= Date.now()) ? null : target;
    state.watch.opensAtIsPersonal = !!forUser;

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    card.appendChild(el('div', 'nts-wc-title',
      ev.Name + (kickoff ? ' · ' + fmtLocal(kickoff) : '')));

    // A single status line. If there is a countdown that is the headline;
    // otherwise the meaning of the button.
    const code = buttonCode(ev);
    const label = pick(ev, 'ButtonData.TranslationCode');
    const status = el('div', 'nts-wc-status' + (open ? ' nts-wc-open' : ''));
    ui.watchCountdown = el('span', 'nts-wc-count', '');
    status.appendChild(el('span', 'nts-wc-badge',
      STATUS_TEXT[code] || (open ? 'In verkoop' : 'Nog dicht')));
    status.appendChild(ui.watchCountdown);
    card.appendChild(status);

    if (forUser && !open) {
      card.appendChild(el('div', 'nts-wc-when',
        'jouw fase: ' + fmtLocal(forUser) + '  (API: ' + ev.OnSaleForUserFrom + ' UTC)'));
    }
    // Only show the club's own label when it adds something.
    if (label && !STATUS_TEXT[label]) {
      const b = el('div', 'nts-wc-button', label);
      if (till) b.title = 'omslag ' + fmtLocal(till) + '  (API: ' +
        pick(ev, 'ButtonData.ActiveTill') + ' UTC)';
      card.appendChild(b);
    }

    // One figures line. "placements" is left out: those are price categories,
    // not tickets, and it gave the impression there were only 31 tickets.
    const parts = [];
    if (vs) {
      parts.push(vs.sections + ' vak' + (vs.sections === 1 ? '' : 'ken'));
      parts.push(vs.available == null ? 'nog geen kaarten' : vs.available + ' vrij');
      const pr = priceLabel(vs);
      if (pr) parts.push(pr);
    }
    if (state.right) {
      const r = state.right;
      const per = (r.PurchaseRightsPerCustomer || []).length;
      parts.push('mag kopen: ' + (r.UnlimitedAmount ? 'onbeperkt' : r.AmountSelectable) +
        (per > 1 ? ' (' + per + ' personen)' : ''));
    } else if (ev.CurrentlyOnSaleForUser === false) {
      parts.push('mag kopen: nog geen recht');
    }
    if (parts.length) {
      const m = el('div', 'nts-wc-metrics');
      m.appendChild(el('span', 'nts-wc-m' + (vs && vs.available ? ' nts-wc-strong' : ''),
        parts.slice(0, 2).join(' · ')));
      parts.slice(2).forEach(t => m.appendChild(el('span', 'nts-wc-m nts-wc-dim', t)));
      card.appendChild(m);
    }

    // Only flags that mean something. Six rows of "no" is noise.
    const notable = [];
    if (ev.PurchaseRightAvailableAfterLogin === true) notable.push('kooprecht na inloggen');
    if (ev.HasSoldOut === true) notable.push('uitverkocht');
    if (ev.HasMarketplaceTicketsAvailable === true) notable.push('marktplaats');
    if (ev.SalesFlowAllowed === false) notable.push('verkoopflow geblokkeerd');
    if (notable.length) {
      const f = el('div', 'nts-wc-flags');
      notable.forEach(t => f.appendChild(el('span', 'nts-wc-flag', t)));
      card.appendChild(f);
    }

    card.appendChild(el('div', 'nts-wc-foot', 'laatste check ' + nowStr()));
    updateCountdown();
  }

  // The card should appear as soon as you pick an event. We already have the
  // venue response from loading the sections, so pass it in rather than
  // fetching it a second time.
  function clearEventCard() {
    ui.watchCard.innerHTML = '';
    ui.watchCountdown = null;          // otherwise the countdown keeps writing
    state.watch.opensAt = null;        // to an element no longer in the DOM
  }

  async function showEventCard(venue) {
    if (state.eventId == null) { clearEventCard(); return; }
    try {
      const ev = (await getEventsRaw()).find(i => i.EventId === state.eventId);
      if (!ev) { clearEventCard(); return; }
      const vs = summarisePlacements(venue || await getVenue(state.eventId));
      try { state.right = await getPurchaseRight(state.eventId); } catch (e) { state.right = null; }
      renderWatchCard(ev, vs);
    } catch (e) {
      log('Kon de statuskaart niet laden: ' + e.message);
    }
  }

  // Runs every second so the countdown does not sit still for 30s.
  function updateCountdown() {
    if (!ui.watchCountdown) return;
    const at = state.watch.opensAt;
    if (!at) { ui.watchCountdown.textContent = ''; return; }
    const d = fmtDuration(at.getTime() - Date.now());
    const wie = state.watch.opensAtIsPersonal ? 'voor jou ' : '';
    ui.watchCountdown.textContent = d ? 'opent ' + wie + 'over ' + d : 'omslagmoment verstreken';
  }

  // Report changes in the event record. The initial state is in the card, so
  // the log is only there for what changes.
  function reportEventChanges(ev) {
    const now = snapshot(ev);
    const prev = state.watch.prev;
    state.watch.prev = now;

    if (prev) {
      WATCH_FIELDS.forEach(([p, label]) => {
        if (prev[p] !== now[p]) log('🔔 ' + label + ': ' + prev[p] + ' → ' + now[p]);
      });
    }

    if (needsLogin(ev) && !state.watch.loginWarned) {
      state.watch.loginWarned = true;
      log('🔑 De shop zegt "inloggen om te kopen" — controleer of je sessie nog geldig is; ' +
          'kooprechten zijn pas zichtbaar als je ingelogd bent.');
    }

    if (isOnSale(ev) && !state.watch.alerted) {
      state.watch.alerted = true;
      onSaleOpen(ev);
    }
  }

  // Changes on the venue side. For an away fixture, sections appearing is the
  // moment there is genuinely something to take.
  function reportVenueChanges(vs) {
    const pv = state.watch.prevVenue;
    if (pv) {
      if (pv.sections !== vs.sections) log('🗺️ vakken: ' + pv.sections + ' → ' + vs.sections);
      if (pv.available !== vs.available) log('🎫 vrij: ' + showVal(pv.available) + ' → ' + showVal(vs.available));
      if (pv.priced !== vs.priced) log('💶 met prijs: ' + pv.priced + ' → ' + vs.priced + ' (' + vs.tiers + ')');
      if (pv.sections === 0 && vs.sections > 0) {
        log('🪑 Er zijn nu vakken — de monitor gaat over op kopen.');
        beep();
        flashTitle('🪑 VAKKEN');
      }
    }
    state.watch.prevVenue = vs;
  }

  async function onSaleOpen(ev) {
    log('🎉 VERKOOP OPEN voor "' + ev.Name + '" — ga naar de shop!');
    const route = (ev.DeepLinkRoute || '').trim();
    let href = SHOP_URL;
    try { if (route) href = new URL(route, SHOP_URL).href; } catch (e) { /* fall back to the shop home */ }
    showBanner('🎉 ' + ev.Name + ' is in verkoop!', 'Naar de shop →', href);
    beep();
    flashTitle('🎟️ IN VERKOOP');

    // There may be a venue map now, in which case the monitor can start
    // claiming instead of you clicking manually.
    try {
      const venue = await getVenue(state.eventId);
      const secs = venue.Sections.filter(s => s.SaleCategoryId === state.eventCategory);
      if (secs.length) {
        log('🪑 Er is nu een plattegrond (' + secs.length + ' vak(ken)) — zet de modus op "Stoelen", ververs en start de scan.');
      }
    } catch (e) { /* the alarm has already fired; this is a bonus */ }
  }

  // The tab title is the only signal you still notice when the tab is in the
  // background; the banner and the beep require you to look or listen.
  function flashTitle(text) {
    if (state.watch.title === null) state.watch.title = document.title;
    document.title = text + ' · ' + state.watch.title;
  }
  function restoreTitle() {
    if (state.watch.title !== null) { document.title = state.watch.title; state.watch.title = null; }
  }

  function start() {
    if (state.timer) return;
    if (state.eventId == null) { log('Kies eerst een event.'); return; }
    // Reuse an already-open shopping cart if the shop has one, so placed seats
    // join it instead of spawning a second order.
    let order = { PendingOrderId: null, PendingOrderUID: null };
    try {
      const raw = window.sessionStorage.getItem('shoppingCartData');
      if (raw) order = JSON.parse(raw);
    } catch (e) { /* no existing cart is fine */ }
    state.cart = {
      reservationId: null, reservationUID: null,
      orderId: order.PendingOrderId || null, orderUID: order.PendingOrderUID || null,
      placed: [],
      acquired: 0, attempted: new Set(), done: false,
    };
    persistCart();
    state.prevKeys = null;
    state.totalAppeared = 0;
    state.lastPoll = 0;
    state.watch.prev = null;
    state.watch.prevVenue = null;
    state.watch.alerted = false;
    state.watch.loginWarned = false;
    ui.counter.textContent = 'Vrij nu: —';

    const names = state.selectedOrder.length
      ? state.selectedOrder.map((v, i) => (i + 1) + '. ' + nameByVbb(v)).join('  ')
      : (state.sections.length ? 'alle vakken' : 'nog geen vakken — we wachten tot ze verschijnen');
    log('▶️ Gestart · ' + names + ' · gewenst: ' + state.wantedCount);
    setRunning(true);
    tick();
    state.timer = setInterval(tick, INTERVAL_MS);
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    restoreTitle();
    setRunning(false);
  }

  function setRunning(on) {
    ui.startBtn.disabled = on;
    ui.stopBtn.disabled = !on;
  }

  function onSuccess() {
    state.cart.done = true;
    stop();
    log('🎟️ ' + state.cart.acquired + ' plaats(en) staan in je winkelwagen — rond af!');
    showBanner();
    beep();
  }

  // ------------------------------------------------------------------- UI ---
  const ui = {};

  function nameByVbb(vbbId) {
    const s = state.sections.find(x => x.VenueBuildingBlockId === vbbId);
    return s ? s.Name : String(vbbId);
  }

  function log(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function renderSections() {
    ui.sections.innerHTML = '';
    state.sections.forEach(s => {
      const vbb = s.VenueBuildingBlockId;
      const idx = state.selectedOrder.indexOf(vbb);
      const available = s.HasTicketsAvailable === true || s.HasMarketplaceTicketsAvailable === true;
      const chosen = state.desiredSeats[vbb];

      const row = document.createElement('div');
      row.className = 'nts-sec' + (idx >= 0 ? ' nts-sel' : '') + (available ? '' : ' nts-full');

      const label = document.createElement('span');
      label.className = 'nts-sec-label';
      const badge = idx >= 0 ? (idx + 1) + '. ' : '';
      const avail = available ? ' · ' + s.AvailableSeats + ' vrij' : ' · vol';
      const seatBadge = (chosen && chosen.size) ? ' · 🪑' + chosen.size : '';
      label.textContent = badge + s.Name + avail + seatBadge;
      label.addEventListener('click', () => toggleSection(vbb));

      const seatBtn = document.createElement('button');
      seatBtn.className = 'nts-seatbtn';
      seatBtn.textContent = '🪑';
      seatBtn.title = 'Kies specifieke stoelen in dit vak';
      seatBtn.addEventListener('click', (e) => { e.stopPropagation(); openPicker(vbb); });

      row.append(label, seatBtn);
      ui.sections.appendChild(row);
    });
  }

  function toggleSection(vbbId) {
    const i = state.selectedOrder.indexOf(vbbId);
    if (i >= 0) state.selectedOrder.splice(i, 1);
    else state.selectedOrder.push(vbbId);
    renderSections();
  }

  // --- Seat picker: show the rows/seats per section and pick specific seats.
  async function openPicker(vbbId) {
    if (state.eventId == null) { log('Kies eerst een event.'); return; }
    log('Stoelen laden voor ' + nameByVbb(vbbId) + '…');
    try {
      const data = await getSection(vbbId, state.eventId);
      renderPicker(vbbId, data);
    } catch (e) {
      log('Kon stoelen niet laden: ' + e.message);
    }
  }

  function closePicker() { ui.picker.style.display = 'none'; }

  function renderPicker(vbbId, seatData) {
    const chosen = state.desiredSeats[vbbId] || (state.desiredSeats[vbbId] = new Set());

    // Group by seat number: real seats (P1) plus the "fake" numbered non-seats
    // (P2/P3 = stairs/aisle) so the map stays complete. Skip empty padding.
    const byRow = new Map();
    seatData.Rows.forEach(r => r.Columns.forEach(c => {
      if (!c.SeatNumber) return;
      if (!byRow.has(c.RowNumber)) byRow.set(c.RowNumber, []);
      byRow.get(c.RowNumber).push(c);
    }));
    const rowKeys = [...byRow.keys()].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    ui.picker.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'nts-picker-head';
    const title = document.createElement('span');
    title.textContent = nameByVbb(vbbId);
    const count = document.createElement('span');
    count.className = 'nts-picker-count';
    const updateCount = () => {
      count.textContent = chosen.size ? chosen.size + ' gekozen' : 'geen (= eerste beste)';
      renderSections();
    };
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'wis';
    clearBtn.addEventListener('click', () => { chosen.clear(); renderPicker(vbbId, seatData); });
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'ververs beschikbaarheid';
    refreshBtn.addEventListener('click', () => openPicker(vbbId));
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'sluiten';
    closeBtn.addEventListener('click', closePicker);
    head.append(title, count, clearBtn, refreshBtn, closeBtn);
    ui.picker.appendChild(head);

    const legend = document.createElement('div');
    legend.className = 'nts-picker-legend';
    legend.textContent = 'Klik een vrije stoel aan (groen = gekozen). Grijs = bezet, ✕ = gangpad/trap. Niets kiezen = eerste beste.';
    ui.picker.appendChild(legend);

    const grid = document.createElement('div');
    grid.className = 'nts-picker-grid';
    rowKeys.forEach(rk => {
      const rowEl = document.createElement('div');
      rowEl.className = 'nts-picker-row';
      const rl = document.createElement('span');
      rl.className = 'nts-picker-rowlabel';
      rl.textContent = 'rij ' + rk;
      rowEl.appendChild(rl);
      byRow.get(rk).sort((a, b) => a.Column - b.Column).forEach(c => {
        const seat = isSeat(c);
        const avail = seat && (c.IsAvailableForSale === true || c.AvailableForSecondary === true);
        const cell = document.createElement('button');
        let cls = 'nts-seat';
        if (seat && chosen.has(c.Id)) cls += ' nts-seat-chosen';
        else if (!seat) cls += ' nts-seat-nonseat';       // aisle/stairs: cross
        else if (!avail) cls += ' nts-seat-taken';        // occupied real seat
        cell.className = cls;
        cell.textContent = c.SeatNumber;
        // Only currently bookable real seats are clickable (an already chosen
        // seat stays clickable so it can be unpicked).
        const clickable = seat && (avail || chosen.has(c.Id));
        if (!clickable) {
          cell.disabled = true;
          cell.title = seat
            ? ('rij ' + c.RowNumber + ' stoel ' + c.SeatNumber + ' — bezet')
            : 'gangpad/trap — geen stoel';
        } else {
          cell.title = 'rij ' + c.RowNumber + ' stoel ' + c.SeatNumber + ' — vrij';
          cell.addEventListener('click', () => {
            if (chosen.has(c.Id)) {
              chosen.delete(c.Id);
            } else {
              chosen.add(c.Id);
              if (!state.selectedOrder.includes(vbbId)) state.selectedOrder.push(vbbId);
            }
            cell.classList.toggle('nts-seat-chosen');
            updateCount();
          });
        }
        rowEl.appendChild(cell);
      });
      grid.appendChild(rowEl);
    });
    ui.picker.appendChild(grid);

    updateCount();
    ui.picker.style.display = 'flex';
  }

  async function loadEvents() {
    try {
      log('Events laden…');
      state.events = await getEvents();
      ui.event.innerHTML = '<option value="">— kies event —</option>';
      state.events.forEach(e => {
        const opt = document.createElement('option');
        opt.value = String(e.eventId);
        opt.textContent = '[' + e.eventId + '] ' + e.name;
        ui.event.appendChild(opt);
      });
      log('✓ ' + state.events.length + ' events geladen.');
    } catch (e) {
      log('Kon events niet laden: ' + e.message);
    }
  }

  async function loadSections(eventId, preserve) {
    try {
      log('Vakken laden…');
      const venue = await getVenue(eventId);
      // All sections in this event's category, alphabetically. Full sections are
      // included too, so you can pick them and the monitor keeps checking.
      const all = venue.Sections
        .filter(s => s.SaleCategoryId === state.eventCategory)
        .sort((a, b) => a.Name.localeCompare(b.Name, 'nl', { numeric: true }));
      state.sections = all;
      if (preserve) {
        // Keep the chosen priority for sections that still exist.
        const ids = new Set(all.map(s => s.VenueBuildingBlockId));
        state.selectedOrder = state.selectedOrder.filter(v => ids.has(v));
      } else {
        state.selectedOrder = [];
        state.desiredSeats = {};
      }
      renderSections();
      showEventCard(venue);
      // You do not have to choose what kind of event this is; the sections say.
      state.lastSections = all.length;
      if (all.length === 0) {
        log('⏳ Nog geen vakken voor dit event — start gerust, de monitor pakt ze ' +
            'zodra ze verschijnen.');
      } else {
        log('✓ ' + all.length + ' vak(ken). Klik ze aan op prioriteit (of laat leeg = alle).');
      }
    } catch (e) {
      log('Kon vakken niet laden: ' + e.message);
    }
  }

  // Show what the token actually is, not just that one exists. The shop swaps
  // in an anonymous token when its own login check fails (route guard →
  // ensureAnonymousToken), which is what "suddenly logged out" looks like; a
  // Customer → Anonymous flip is worth an explicit warning.
  function refreshTokenStatus() {
    const tok = getToken();
    const c = tok && decodeJwt(tok);
    if (!c) {
      ui.token.textContent = 'token: niet gevonden — log in';
      ui.token.className = 'nts-token nts-bad';
      return;
    }
    const customer = c.type === 'Customer';
    const left = c.exp ? c.exp * 1000 - Date.now() : null;
    const leftTxt = left == null ? '' : ' · ' + (left > 0 ? fmtDuration(left) + ' geldig' : 'VERLOPEN');
    ui.token.textContent = (customer ? 'ingelogd' : 'anoniem') + leftTxt;
    ui.token.className = 'nts-token' + (customer && left > 0 ? ' nts-ok' : ' nts-bad');

    if (state.session.wasCustomer && !customer) {
      log('🔒 Je sessie is teruggevallen naar anoniem — log opnieuw in. ' +
          '(De shop doet dit zelf zodra zijn login-check faalt.)');
      beep();
    }
    state.session.wasCustomer = customer;
  }

  // Renew well before the 24h expiry. Every 6h is plenty; the shop only ever
  // renews on login, so this is strictly extra. Only for a Customer token —
  // renewing an anonymous one gains nothing.
  const SESSION_REFRESH_MS = 6 * 3600 * 1000;
  async function keepSessionAlive() {
    const tok = getToken();
    const c = tok && decodeJwt(tok);
    if (!c || c.type !== 'Customer') return;
    const left = c.exp ? c.exp * 1000 - Date.now() : Infinity;
    if (left > SESSION_REFRESH_MS && Date.now() - state.session.lastRefresh < SESSION_REFRESH_MS) return;
    try {
      const fresh = await refreshSession();
      const fc = decodeJwt(fresh);
      if (!fc || fc.type !== 'Customer') throw new Error('refresh gaf geen klant-token');
      window.sessionStorage.setItem('jwt', fresh);
      state.session.lastRefresh = Date.now();
      // The shop's own refresh also re-fetches Account/current into
      // sessionStorage.userData. Its login check reads that cache first, and
      // falls back to an anonymous token when a live check fails — so keeping
      // userData present is what actually prevents the "sudden logout".
      try {
        const res = await fetch(API + '/v2/Account/current', { credentials: 'omit', headers: headers() });
        if (res.ok) window.sessionStorage.setItem('userData', JSON.stringify(await res.json()));
      } catch (e) { /* the jwt is renewed regardless */ }
      log('🔄 Sessie verlengd tot ' + fmtLocal(new Date(fc.exp * 1000)));
      refreshTokenStatus();
    } catch (e) {
      log('⚠️ Sessie verlengen mislukt: ' + e.message);
    }
  }

  function showBanner(text, label, url) {
    const href = url || CART_URL;
    let b = document.getElementById('nts-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'nts-banner';
      document.body.appendChild(b);
    }
    b.textContent = (text || '🎟️ Stoel(en) in je winkelwagen!') + ' ';
    const btn = document.createElement('button');
    btn.textContent = label || 'Naar winkelwagen →';
    btn.addEventListener('click', () => { window.location.href = href; });
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

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'nts-panel';
    // Static markup only: the AMO linter flags any non-literal innerHTML.
    panel.innerHTML =
      '<div class="nts-head"><span>Seat Assist</span>' +
      '<span class="nts-token nts-bad">token…</span>' +
      '<button class="nts-collapse" title="in-/uitklappen">–</button></div>' +
      '<div class="nts-body">' +
      '  <div class="nts-row"><button class="nts-events">Events laden</button>' +
      '    <select class="nts-event"><option value="">— kies event —</option></select></div>' +
      '  <div class="nts-label">Vakken (klik = prioriteit, 🪑 = kies stoelen): <button class="nts-refresh" title="ververs vakken">↻</button></div>' +
      '  <div class="nts-sections"></div>' +
      '  <div class="nts-row nts-countrow"><label>Aantal: <input type="number" class="nts-count" min="1" value="1"></label></div>' +
      '  <div class="nts-row"><button class="nts-start">▶ Start</button><button class="nts-stop" disabled>■ Stop</button><button class="nts-reload" title="Verwijder de gecarte stoelen uit de winkelwagen en zet ze opnieuw">🔄 Herlaad</button></div>' +
      '  <div class="nts-watchcard"></div>' +
      '  <div class="nts-counter">Vrij nu: —</div>' +
      '  <div class="nts-log"></div>' +
      '</div>' +
      '<div class="nts-picker"></div>';
    document.body.appendChild(panel);

    ui.panel = panel;
    ui.token = panel.querySelector('.nts-token');
    ui.event = panel.querySelector('.nts-event');
    ui.sections = panel.querySelector('.nts-sections');
    ui.count = panel.querySelector('.nts-count');
    ui.startBtn = panel.querySelector('.nts-start');
    ui.stopBtn = panel.querySelector('.nts-stop');
    ui.reloadBtn = panel.querySelector('.nts-reload');
    ui.counter = panel.querySelector('.nts-counter');
    ui.watchCard = panel.querySelector('.nts-watchcard');
    ui.refresh = panel.querySelector('.nts-refresh');
    ui.picker = panel.querySelector('.nts-picker');
    ui.log = panel.querySelector('.nts-log');

    panel.querySelector('.nts-events').addEventListener('click', loadEvents);
    ui.refresh.addEventListener('click', () => { if (state.eventId != null) loadSections(state.eventId, true); });
    ui.event.addEventListener('change', () => {
      const val = ui.event.value;
      const newId = val ? parseInt(val, 10) : null;
      const changed = newId !== state.eventId;
      state.eventId = newId;
      const ev = state.events.find(e => e.eventId === state.eventId);
      state.eventCategory = ev ? ev.saleCategoryId : null;
      if (changed) {
        // Ander event = andere winkelwagen-context; oude tracking wissen.
        state.cart.orderId = null; state.cart.orderUID = null;
        state.cart.placed = []; state.cart.acquired = 0;
        persistCart();
      }
      if (state.eventId != null) loadSections(state.eventId, false);
      else clearEventCard();
    });
    ui.count.addEventListener('change', () => {
      const n = parseInt(ui.count.value, 10);
      state.wantedCount = n >= 1 ? n : 1;
      ui.count.value = String(state.wantedCount);
    });
    ui.startBtn.addEventListener('click', start);
    ui.stopBtn.addEventListener('click', stop);
    ui.reloadBtn.addEventListener('click', reloadCart);
    panel.querySelector('.nts-collapse').addEventListener('click', (e) => {
      panel.classList.toggle('nts-min');
      e.target.textContent = panel.classList.contains('nts-min') ? '+' : '–';
    });

    refreshTokenStatus();
    setInterval(refreshTokenStatus, 3000);
    // Session keep-alive: check every 10 minutes, act when it is time.
    keepSessionAlive();
    setInterval(keepSessionAlive, 10 * 60 * 1000);
    setInterval(updateCountdown, 1000);
    log('Klaar. Zorg dat je ingelogd bent en door de wachtrij, klik "Events laden".');
    restoreCart();
  }

  buildPanel();
})();
