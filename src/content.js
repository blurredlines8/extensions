(function () {
  'use strict';
  if (window.__seatAssistLoaded) return;
  window.__seatAssistLoaded = true;

  const API = '__API_ORIGIN__';
  const INTERVAL_MS = 5000;
  const CART_URL = '__SHOP_ORIGIN__/shopping-cart';
  const SHOP_URL = '__SHOP_ORIGIN__/';
  // Zolang er nog geen vakken zijn hoeft de monitor niet op volle snelheid;
  // dat wachten kan dagen duren. Ook het event-record wordt op dit ritme
  // ververst, want dat verandert traag.
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
    unplacedSeen: new Set(),   // vakken waarvan we de unplaced-vorm al logden
    lastSections: 0,           // aantal vakken bij de vorige ronde
    lastPoll: 0,               // tijdstip van de vorige ronde (voor de wachtstand)
    evRecord: null,            // laatst opgehaalde event-record
    evFetched: 0,
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
  // Alleen PlacementTypeId 1 is een echte, boekbare stoel; 2/3 zijn trap/gang/
  // "no-seat" (staan altijd "vrij" want ze worden nooit verkocht).
  const isSeat = c => c.PlacementTypeId === 1;

  // ------------------------------------------------------------------ API ---
  // Rauwe event-records: de statuskaart kijkt naar velden die de mapping
  // hieronder weggooit (ButtonData, OnGeneralSaleFrom, …).
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

  // Vakken zonder genummerde stoelen (staanplaatsen, uitvakken) hebben een eigen
  // endpoint. Payload afgeleid uit de shop-bundle (getUnplacedData).
  async function getSectionUnplaced(vbbId, eventId) {
    const res = await fetch(API + '/v2/Availability/section-unplaced', {
      method: 'POST', credentials: 'omit', headers: headers(),
      body: JSON.stringify({ ParentVBBId: vbbId, EventIds: [eventId], PassePartoutIds: null, InitiativeGuid: getInitiativeGuid() }),
    });
    if (!res.ok) throw new Error('SectionUnplaced HTTP ' + res.status);
    return res.json();
  }

  // De shop stuurt hier de waarde uit sessionStorage['ai'] mee; wij deden dat nog
  // niet. Bij kooprecht-verkopen kan dat uitmaken.
  const getInitiativeGuid = () => {
    try { return window.sessionStorage.getItem('ai') || null; } catch (e) { return null; }
  };

  // Zo bepaalt de shop het zelf: geen rijen terug = het is een unplaced vak.
  const isUnplacedDetail = d => !d || !d.Rows || d.Rows.length === 0;

  // Hoeveel er vrij is in een unplaced vak. De precieze vorm van Availability
  // hebben we nog niet in het echt gezien, dus meerdere velden proberen en bij
  // twijfel null teruggeven (dan tonen we "?" i.p.v. een verzonnen getal).
  // Venue/venue geeft per vak al een telling mee: AvailableSeats (bij de
  // thuiswedstrijden van FC Eindhoven 226, 65, 136 …) en TicketsPerTicketTypeId.
  // Voor een vak zonder stoelnummers is dat dé bron — section-unplaced hoeft
  // dan alleen nog voor de details.
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

  // Een plek kopen in een vak zonder stoelnummers. Payload afgeleid uit de
  // shop-bundle (addUnplacedTickets → unplaced-event-selection): één aanroep
  // pakt meteen `amount` plekken, anders dan bij stoelen waar we per stoel
  // langsgaan. Retourneert 'ok' | 'unavailable' | 'error', net als claimSeat.
  //
  // LET OP: deze aanroep is afgeleid uit hun JavaScript, niet in het echt
  // waargenomen. De eerste keer dat hij vuurt is meteen menens.
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

      // Zelfde tweede poging als bij stoelen; de shop doet het ook zo.
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
      } catch (e) { /* geen sessionStorage-toegang is niet fataal */ }
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
          col: { Row: p.col.Row, Column: p.col.Column, RowNumber: p.col.RowNumber, SeatNumber: p.col.SeatNumber, Id: p.col.Id },
        })),
      }));
    } catch (e) { /* sessionStorage kan falen; niet fataal */ }
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
        log('↩️ Winkelwagen-context hersteld: ' + state.cart.placed.length + ' stoel(en). "🔄 Herlaad" is beschikbaar.');
      }
    } catch (e) { /* corrupte context negeren */ }
  }

  // Reload: gooi de gecarte stoelen uit de winkelwagen en zet ze meteen opnieuw
  // erin — een schone staat voor als een stoel "vast" lijkt te zitten. Doet
  // exact wat de shop doet (regels DELETEn, order clearen) en herbouwt daarna.
  async function reloadCart() {
    const placed = (state.cart.placed || []).slice();
    if (!state.cart.orderId || !placed.length) { log('Niks in de winkelwagen om te herladen.'); return; }
    if (state.reloading) return;
    state.reloading = true;
    ui.reloadBtn.disabled = true;
    const orderId = state.cart.orderId, orderUID = state.cart.orderUID;
    try {
      log('🔄 Winkelwagen herladen (' + placed.length + ' stoel(en))…');

      // 1. Verwijder de stoel-regels (ProductType 2/3 = bezorg-/betaalregel, die
      //    laten we staan). Elke regel heeft een .Id = de line-id voor de DELETE.
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

      // 2. Maak de (nu lege) order leeg/weg.
      try {
        await fetch(API + '/v2/PendingOrder/' + encodeURIComponent(orderId) + '/clear/' + encodeURIComponent(orderUID), {
          method: 'GET', credentials: 'omit', headers: headers(),
        });
      } catch (e) { log('  clear error: ' + e.message); }

      // Verse start: volgende plaatsing maakt een nieuwe order aan.
      state.cart.orderId = null; state.cart.orderUID = null;
      state.cart.reservationId = null; state.cart.reservationUID = null;
      state.cart.placed = [];
      persistCart();
      try { window.sessionStorage.removeItem('shoppingCartData'); } catch (e) { /* ok */ }

      // 3. Zet dezelfde stoelen opnieuw in de winkelwagen.
      let back = 0;
      for (const p of placed) {
        const r = await claimSeat(p.section, p.col);
        if (r === 'ok' && await placeInOrder()) {
          state.cart.placed.push(p);
          back++;
          log('  ✓ opnieuw: ' + p.section.Name + ' rij ' + p.col.RowNumber + ' stoel ' + p.col.SeatNumber);
        } else {
          log('  ✗ mislukt/niet meer vrij: ' + p.section.Name + ' rij ' + p.col.RowNumber + ' stoel ' + p.col.SeatNumber);
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
  // Eén monitor voor beide soorten events; wat voor event het is leiden we af
  // uit de plattegrond zelf:
  //
  //   geen vakken        → er valt nog niets te halen, we blijven kijken
  //   vak mét rijen      → thuiswedstrijd: kies een stoel
  //   vak zónder rijen   → uitwedstrijd: koop een plek in dat vak
  //
  // Dat is precies de regel die de shop zelf ook hanteert (geen Rows = unplaced).
  async function tick() {
    if (state.cart.done || state.reloading) return;
    if (!getToken()) { log('⚠️ Geen token in sessionStorage — ben je ingelogd?'); return; }

    // In de wachtstand (nog geen vakken) hoeft het niet elke 5 seconden; dat kan
    // dagen duren. Zodra er vakken zijn, gaan we op volle snelheid.
    const nu = Date.now();
    if (state.lastSections === 0 && state.lastPoll && nu - state.lastPoll < WAIT_INTERVAL_MS) return;
    state.lastPoll = nu;

    try {
      // Het event-record verandert traag; niet bij elke ronde ophalen.
      if (!state.evRecord || nu - state.evFetched > WAIT_INTERVAL_MS) {
        const vers = (await getEventsRaw()).find(i => i.EventId === state.eventId);
        if (vers) { reportEventChanges(vers); state.evRecord = vers; }
        state.evFetched = nu;
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

      // Eén fetch per vak, hergebruikt voor zowel de teller als de koopronde.
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
          gathered.push({ section, seats: [], plekken: n });
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
        if (g.seats.length) { await pakStoelen(g.section, g.seats); continue; }
        if (g.plekken !== 0) await pakPlekken(g.section, g.plekken);
      }
    } catch (e) {
      log('Fout: ' + e.message);
    }
  }

  // Thuiswedstrijd: stoel voor stoel, in de volgorde die je gekozen hebt.
  async function pakStoelen(section, seats) {
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

  // Uitwedstrijd: geen stoelkeuze; één aanroep pakt meteen het hele aantal
  // plekken in dit vak. Mislukt dat definitief, dan slaan we het vak deze run
  // over — anders vuren we elke ronde opnieuw een koopverzoek af.
  async function pakPlekken(section, beschikbaar) {
    if (state.cart.done) return;
    const key = 'vak:' + section.VenueBuildingBlockId;
    if (state.cart.attempted.has(key)) return;

    const willen = state.wantedCount - state.cart.acquired;
    if (willen <= 0) return;
    const nemen = (beschikbaar === null) ? willen : Math.min(willen, beschikbaar);
    if (nemen <= 0) return;

    log('➡️ Poging: ' + nemen + ' plek(ken) in ' + section.Name);
    const result = await claimUnplaced(section, nemen);
    if (result === 'unavailable') { state.cart.attempted.add(key); return; }
    if (result !== 'ok') return;

    log('  · vastgehouden, in winkelwagen plaatsen…');
    if (!await placeInOrder()) return;
    state.cart.placed.push({ section, plekken: nemen });
    state.cart.acquired += nemen;
    persistCart();
    log('  ✓ In winkelwagen: ' + nemen + ' plek(ken) in ' + section.Name +
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

    // Bij een uitwedstrijd zijn er geen stoelsleutels om te tellen; dan is het
    // aantal vrije plekken per vak het enige zinvolle getal.
    const plekken = (gathered || [])
      .filter(g => g.plekken != null)
      .reduce((a, g) => a + g.plekken, 0);
    const heeftPlekken = (gathered || []).some(g => g.plekken != null);

    ui.counter.textContent = heeftPlekken
      ? 'Vrije plekken: ' + plekken + ' · ' + nowStr()
      : 'Vrij nu: ' + currentKeys.size +
        (prev ? '  ·  +' + added + ' / -' + removed + '  (totaal bijgekomen: ' + state.totalAppeared + ')' : '');
    if (prev && (added || removed)) {
      log('🔄 ' + currentKeys.size + ' vrij · +' + added + ' bij / -' + removed + ' weg');
    }
  }

  // ------------------------------------------------ status van het event ---
  // Het event-record uit /v2/Event vertelt of de verkoop openstaat. Zolang er
  // nog geen vakken zijn is dit het enige teken van leven, dus we melden elke
  // wijziging en slaan alarm zodra er gekocht kan worden.
  const WATCH_FIELDS = [
    ['CurrentlyOnSaleForUser', 'verkoop open voor jou'],
    ['OnSaleForUserFrom', 'verkoop voor jou vanaf'],
    ['HasGeneralSale', 'vrije verkoop'],
    ['OnGeneralSaleFrom', 'vrije verkoop vanaf'],
    ['HasTicketsAvailable', 'kaarten beschikbaar'],
    ['HasSoldOut', 'uitverkocht'],
    ['SalesFlowAllowed', 'verkoopflow toegestaan'],
    ['PurchaseRightAvailableAfterLogin', 'kooprecht na inloggen'],
    ['ButtonData.ActionType', 'knop-actie'],
    ['ButtonData.TranslationCode', 'knoptekst'],
    ['ButtonData.Action', 'knop-doel'],
    // Het venster van de huidige knop: ActiveTill is het moment waarop de shop
    // naar de volgende fase wisselt — vaak precies de start van de verkoop.
    ['ButtonData.ActiveFrom', 'knop actief vanaf'],
    ['ButtonData.ActiveTill', 'knop actief tot'],
  ];

  const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const showVal = v => (v === null || v === undefined || v === '' ? '—' : String(v));

  // "Er valt nu iets te halen". ButtonData komt in twee smaken, geverifieerd
  // tegen twee onafhankelijke shops op ditzelfde backend-platform:
  //
  //   • stub (Id 0 / EventId 0) = geen eigen knop geconfigureerd. De shop toont
  //     zijn standaardknop en de TranslationCode zegt de échte status:
  //     BTN.SALE.BUYNOW / BTN.SALE.LOGINTOBUY = koopbaar, BTN.SALE.SOLDOUT = uit.
  //   • geconfigureerd (Id != 0) = een clublabel als "Info volgt" of "Start
  //     verkoop 7 sept", met ActionType 'Disabled' óf -1. Dat is juist GEEN
  //     verkoop, alleen een aankondiging.
  //
  // ActionType is dus onbruikbaar als alarmsignaal (-1 en 'Disabled' betekenen
  // allebei "niets te doen", null betekent alleen "geen eigen knop"). We gaan af
  // op de vlaggen, met de standaardknop als bevestiging.
  const isDefaultButton = b => !!b && !b.Id;
  const buttonCode = ev => (isDefaultButton(ev.ButtonData) ? ev.ButtonData.TranslationCode : null);

  // BTN.SALE.LOGINTOBUY telt NIET als verkoop. Gemeten bij FC Eindhoven: hun
  // uitwedstrijden staan op LOGINTOBUY met CurrentlyOnSaleForUser=false en
  // PurchaseRightAvailableAfterLogin=true — "log in, misschien is er iets voor
  // jou", geen koopmoment. Wij draaien binnen een ingelogde sessie, dus die
  // knop betekent hier eerder dat de login weg is. Aparte melding, geen alarm.
  const isOnSale = ev =>
    ev.CurrentlyOnSaleForUser === true ||
    ev.HasGeneralSale === true ||
    buttonCode(ev) === 'BTN.SALE.BUYNOW';

  const needsLogin = ev => buttonCode(ev) === 'BTN.SALE.LOGINTOBUY';

  // Uitwedstrijden geven Sections: [], maar Venue/venue verklapt wél hoeveel
  // plaatsen er zijn en welke prijzen erop staan. Die prijzen worden ingevuld
  // naarmate de verkoop nadert — een vroeg signaal, ruim vóór de knop omklapt.
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

  // De API stuurt naïeve tijdstempels zonder zone. Dat ze UTC zijn blijkt uit de
  // knop zelf: ActiveTill 2026-09-03T10:00:00 hoort bij knoptekst "03-09, 12:00
  // uur" — precies het CEST-verschil. We tonen daarom lokale tijd én de ruwe
  // waarde, zodat een verkeerde aanname meteen opvalt.
  const asUtcDate = v => {
    if (!v || typeof v !== 'string') return null;
    const d = new Date(/[Z+]|-\d\d:\d\d$/.test(v) ? v : v + 'Z');
    return isNaN(d.getTime()) ? null : d;
  };
  const fmtLocal = d => d.toLocaleString('nl-NL',
    { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // Grofheid meeschalen met de afstand: seconden zijn ruis op tien dagen, en
  // "244u" leest niemand.
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
  const jaNee = v => (v === true ? 'ja' : v === false ? 'nee' : '—');

  const snapshot = ev => {
    const s = {};
    WATCH_FIELDS.forEach(([path]) => { s[path] = showVal(pick(ev, path)); });
    return s;
  };

  // Wat de shop-knop betekent, in gewone taal. De BTN.SALE.*-codes zijn de
  // standaardknop; een eigen clublabel tonen we ongewijzigd, dat zegt meer.
  const STATUS_TEXT = {
    'BTN.SALE.SOLDOUT': 'Uitverkocht',
    'BTN.SALE.BUYNOW': 'In verkoop',
    'BTN.SALE.LOGINTOBUY': 'Inloggen om te kopen',
    'BTN.SALE.NOTONSALE': 'Niet in verkoop voor jou',
  };

  // Lange prijslijsten inkorten tot een bereik; zes staffels achter elkaar
  // vullen de halve kaart en zeggen niet meer dan "van … tot …".
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
    const till = asUtcDate(pick(ev, 'ButtonData.ActiveTill'));
    // Valt het einde van de knop samen met de aftrap, dan is het een
    // placeholder ("Info volgt") en geen verkoopmoment — dan niet aftellen,
    // anders suggereren we een openingstijd die nergens op slaat.
    const kick = asUtcDate(ev.EventStartDateTime);
    const isPlaceholder = !!(till && kick && till.getTime() === kick.getTime());
    state.watch.opensAt = (open || isPlaceholder) ? null : till;

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const kickoff = asUtcDate(ev.EventStartDateTime);
    card.appendChild(el('div', 'nts-wc-title',
      ev.Name + (kickoff ? ' · ' + fmtLocal(kickoff) : '')));

    // Eén statusregel. Staat er een aftelling, dan is dát de kop; anders de
    // betekenis van de knop.
    const code = buttonCode(ev);
    const label = pick(ev, 'ButtonData.TranslationCode');
    const status = el('div', 'nts-wc-status' + (open ? ' nts-wc-open' : ''));
    ui.watchCountdown = el('span', 'nts-wc-count', '');
    status.appendChild(el('span', 'nts-wc-badge',
      STATUS_TEXT[code] || (open ? 'In verkoop' : 'Nog dicht')));
    status.appendChild(ui.watchCountdown);
    card.appendChild(status);

    // Het eigen label van de club alleen tonen als het iets toevoegt.
    if (label && !STATUS_TEXT[label]) {
      const b = el('div', 'nts-wc-button', label);
      if (till) b.title = 'omslag ' + fmtLocal(till) + '  (API: ' +
        pick(ev, 'ButtonData.ActiveTill') + ' UTC)';
      card.appendChild(b);
    }

    // Eén cijferregel. "plaatsen" laten we weg: dat zijn prijscategorieën,
    // geen kaarten, en het wekte juist de indruk dat er 31 kaarten waren.
    const delen = [];
    if (vs) {
      delen.push(vs.sections + ' vak' + (vs.sections === 1 ? '' : 'ken'));
      delen.push(vs.available == null ? 'nog geen kaarten' : vs.available + ' vrij');
      const pr = priceLabel(vs);
      if (pr) delen.push(pr);
    }
    if (delen.length) {
      const m = el('div', 'nts-wc-metrics');
      m.appendChild(el('span', 'nts-wc-m' + (vs.available ? ' nts-wc-strong' : ''), delen[0] + ' · ' + delen[1]));
      if (delen[2]) m.appendChild(el('span', 'nts-wc-m nts-wc-dim', delen[2]));
      card.appendChild(m);
    }

    // Alleen vlaggen die iets betekenen. "nee" op zes rijen is ruis.
    const bijzonder = [];
    if (ev.PurchaseRightAvailableAfterLogin === true) bijzonder.push('kooprecht na inloggen');
    if (ev.HasSoldOut === true) bijzonder.push('uitverkocht');
    if (ev.HasMarketplaceTicketsAvailable === true) bijzonder.push('marktplaats');
    if (ev.SalesFlowAllowed === false) bijzonder.push('verkoopflow geblokkeerd');
    if (bijzonder.length) {
      const f = el('div', 'nts-wc-flags');
      bijzonder.forEach(t => f.appendChild(el('span', 'nts-wc-flag', t)));
      card.appendChild(f);
    }

    card.appendChild(el('div', 'nts-wc-foot', 'laatste check ' + nowStr()));
    updateCountdown();
  }

  // De kaart hoort er te staan zodra je een event kiest, in beide modi. Het
  // venue-antwoord hebben we bij het laden van de vakken al, dus dat geven we
  // door in plaats van het nog eens op te halen.
  function clearEventCard() {
    ui.watchCard.innerHTML = '';
    ui.watchCountdown = null;          // anders schrijft de aftelling naar een
    state.watch.opensAt = null;        // element dat niet meer in de DOM hangt
  }

  async function showEventCard(venue) {
    if (state.eventId == null) { clearEventCard(); return; }
    try {
      const ev = (await getEventsRaw()).find(i => i.EventId === state.eventId);
      if (!ev) { clearEventCard(); return; }
      const vs = summarisePlacements(venue || await getVenue(state.eventId));
      renderWatchCard(ev, vs);
    } catch (e) {
      log('Kon de statuskaart niet laden: ' + e.message);
    }
  }

  // Loopt elke seconde zodat de aftelling niet 30s stilstaat.
  function updateCountdown() {
    if (!ui.watchCountdown) return;
    const at = state.watch.opensAt;
    if (!at) { ui.watchCountdown.textContent = ''; return; }
    const d = fmtDuration(at.getTime() - Date.now());
    ui.watchCountdown.textContent = d ? 'opent over ' + d : 'omslagmoment verstreken';
  }

  // Wijzigingen in het event-record melden. De beginstand staat in de kaart,
  // dus het log is er alleen voor wat er verandert.
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

  // Wijzigingen aan de plattegrond-kant. Het verschijnen van vakken is bij een
  // uitwedstrijd het moment waarop er echt iets te halen valt.
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
    try { if (route) href = new URL(route, SHOP_URL).href; } catch (e) { /* val terug op de shop-home */ }
    showBanner('🎉 ' + ev.Name + ' is in verkoop!', 'Naar de shop →', href);
    beep();
    flashTitle('🎟️ IN VERKOOP');

    // Misschien is er nu wél een plattegrond: dan kun je overstappen op de
    // stoelenscan in plaats van handmatig klikken.
    try {
      const venue = await getVenue(state.eventId);
      const secs = venue.Sections.filter(s => s.SaleCategoryId === state.eventCategory);
      if (secs.length) {
        log('🪑 Er is nu een plattegrond (' + secs.length + ' vak(ken)) — zet de modus op "Stoelen", ververs en start de scan.');
      }
    } catch (e) { /* het alarm is al gegeven; dit is extra */ }
  }

  // De tabtitel is het enige signaal dat je ook ziet als het tabblad op de
  // achtergrond staat; de banner en de piep vereisen dat je kijkt/luistert.
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
    } catch (e) { /* geen bestaande cart is prima */ }
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

    const namen = state.selectedOrder.length
      ? state.selectedOrder.map((v, i) => (i + 1) + '. ' + nameByVbb(v)).join('  ')
      : (state.sections.length ? 'alle vakken' : 'nog geen vakken — we wachten tot ze verschijnen');
    log('▶️ Gestart · ' + namen + ' · gewenst: ' + state.wantedCount);
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

  // --- Seat picker: per vak de rijen/stoelen tonen en specifieke stoelen kiezen.
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
    // (P2/P3 = trap/gang) so the map blijft compleet. Lege padding overslaan.
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
        else if (!seat) cls += ' nts-seat-nonseat';       // gangpad/trap: kruis
        else if (!avail) cls += ' nts-seat-taken';        // bezette echte stoel
        cell.className = cls;
        cell.textContent = c.SeatNumber;
        // Alleen nu-boekbare echte stoelen zijn klikbaar (een al gekozen stoel
        // blijft klikbaar om af te vinken).
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
      // Alle vakken van de categorie van dit event, alfabetisch. Ook volle
      // vakken staan erin, zodat je ze kunt kiezen en de monitor blijft checken.
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
      // Wat voor event dit is hoef je niet te kiezen; het blijkt uit de vakken.
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

  function refreshTokenStatus() {
    const ok = !!getToken();
    ui.token.textContent = ok ? 'token: gevonden ✓' : 'token: niet gevonden — log in';
    ui.token.className = 'nts-token' + (ok ? ' nts-ok' : ' nts-bad');
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
    } catch (e) { /* geluid is optioneel */ }
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'nts-panel';
    panel.innerHTML = [
      '<div class="nts-head"><span>Seat Assist</span>',
      '<span class="nts-token nts-bad">token…</span>',
      '<button class="nts-collapse" title="in-/uitklappen">–</button></div>',
      '<div class="nts-body">',
      '  <div class="nts-row"><button class="nts-events">Events laden</button>',
      '    <select class="nts-event"><option value="">— kies event —</option></select></div>',
      '  <div class="nts-label">Vakken (klik = prioriteit, 🪑 = kies stoelen): <button class="nts-refresh" title="ververs vakken">↻</button></div>',
      '  <div class="nts-sections"></div>',
      '  <div class="nts-row nts-countrow"><label>Aantal: <input type="number" class="nts-count" min="1" value="1"></label></div>',
      '  <div class="nts-row"><button class="nts-start">▶ Start</button><button class="nts-stop" disabled>■ Stop</button><button class="nts-reload" title="Verwijder de gecarte stoelen uit de winkelwagen en zet ze opnieuw">🔄 Herlaad</button></div>',
      '  <div class="nts-watchcard"></div>',
      '  <div class="nts-counter">Vrij nu: —</div>',
      '  <div class="nts-log"></div>',
      '</div>',
      '<div class="nts-picker"></div>',
    ].join('');
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
    setInterval(updateCountdown, 1000);
    log('Klaar. Zorg dat je ingelogd bent en door de wachtrij, klik "Events laden".');
    restoreCart();
  }

  buildPanel();
})();
