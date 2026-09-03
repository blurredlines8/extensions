(function () {
  'use strict';
  if (window.__seatAssistLoaded) return;
  window.__seatAssistLoaded = true;

  const API = '__API_ORIGIN__';
  const INTERVAL_MS = 5000;
  const CART_URL = '__SHOP_ORIGIN__/shopping-cart';
  const SHOP_URL = '__SHOP_ORIGIN__/';
  // De verkoopwacht pollt alleen /v2/Event en kan dagen lopen; 30s is ruim
  // snel genoeg voor "gaat in verkoop" en houdt het verkeer bescheiden.
  const WATCH_INTERVAL_MS = 30000;

  const state = {
    events: [],
    eventId: null,
    eventCategory: null,   // SaleCategoryId of the chosen event (varies per event type)
    sections: [],          // all sections of the event's category, sorted by name
    selectedOrder: [],     // VenueBuildingBlockIds in priority order (click order)
    desiredSeats: {},      // vbbId -> Set of specific seat Ids (empty = first available)
    wantedCount: 1,
    timer: null,
    mode: 'seats',         // 'seats' = stoelenscan, 'watch' = verkoopwacht
    modeAuto: false,       // modus is automatisch gezet (mag automatisch terug)
    watch: { timer: null, prev: null, alerted: false, title: null },
    unplacedSeen: new Set(),   // vakken waarvan we de unplaced-vorm al logden
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
  // Rauwe event-records: de verkoopwacht kijkt naar velden die de mapping
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
  async function tick() {
    if (state.cart.done || state.reloading) return;
    if (!getToken()) { log('⚠️ Geen token in sessionStorage — ben je ingelogd?'); return; }

    try {
      const venue = await getVenue(state.eventId);
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

      // One fetch per section, reused for both the counter and the claim pass.
      const gathered = [];
      const currentKeys = new Set();
      for (const section of secs) {
        const detail = await getSection(section.VenueBuildingBlockId, state.eventId);

        // Uitvakken/staanplaatsen leveren geen Rows. Vroeger liep tick() daar
        // stuk op detail.Rows.flatMap; nu tonen we het aantal los.
        if (isUnplacedDetail(detail)) {
          let u = null;
          try { u = await getSectionUnplaced(section.VenueBuildingBlockId, state.eventId); }
          catch (e) { log('  section-unplaced ' + section.Name + ': ' + e.message); }
          const n = countUnplaced(u);
          if (!state.unplacedSeen.has(section.VenueBuildingBlockId)) {
            state.unplacedSeen.add(section.VenueBuildingBlockId);
            // Eén keer de ruwe vorm loggen: die hebben we nog nooit gevuld gezien.
            log('🎫 ' + section.Name + ' is een vak zonder stoelnummers · ' +
                (n === null ? 'aantal onbekend' : n + ' beschikbaar'));
            if (u) log('   ruwe data: ' + JSON.stringify({
              Availability: u.Availability,
              TicketsPerTicketTypeId: u.Details && u.Details.TicketsPerTicketTypeId,
              HasTicketsAvailable: u.Details && u.Details.HasTicketsAvailable,
            }).slice(0, 400));
          }
          gathered.push({ section, seats: [], unplaced: n });
          continue;
        }

        const seats = detail.Rows
          .flatMap(r => r.Columns)
          .filter(c => isSeat(c) && (c.IsAvailableForSale === true || c.AvailableForSecondary === true));
        gathered.push({ section, seats });
        for (const c of seats) currentKeys.add(section.VenueBuildingBlockId + ':' + c.Id);
      }

      const unplacedTotal = gathered.reduce((a, g) => a + (g.unplaced || 0), 0);
      if (unplacedTotal) log('🎫 Zonder stoelnummer beschikbaar: ' + unplacedTotal +
        ' — die pakt de extensie nog niet automatisch, koop ze in de shop.');

      updateChurn(currentKeys);

      if (!gathered.length) { log('Nog geen kaarten in voorkeursvak(ken) · ' + nowStr()); return; }

      for (const { section, seats } of gathered) {
        if (state.cart.done) break;
        // If specific seats were picked for this section, only chase those;
        // otherwise take the first available (default behaviour).
        const desired = state.desiredSeats[section.VenueBuildingBlockId];
        const pool = (desired && desired.size) ? seats.filter(c => desired.has(c.Id)) : seats;
        for (const col of pool) {
          if (state.cart.done) break;
          const key = section.VenueBuildingBlockId + ':' + col.Id;
          if (state.cart.attempted.has(key)) continue;

          log('➡️ Poging: ' + section.Name + ' — rij ' + col.RowNumber + ', stoel ' + col.SeatNumber);
          const result = await claimSeat(section, col);
          if (result === 'ok' || result === 'unavailable') state.cart.attempted.add(key);

          if (result === 'ok') {
            log('  · vastgehouden, in winkelwagen plaatsen…');
            const ok = await placeInOrder();
            if (!ok) continue;
            state.cart.placed.push({ section, col });
            state.cart.acquired++;
            persistCart();
            log('  ✓ In winkelwagen: ' + section.Name + ' rij ' + col.RowNumber + ' stoel ' + col.SeatNumber +
                ' (' + state.cart.acquired + '/' + state.wantedCount + ')');
            if (state.cart.acquired >= state.wantedCount) { onSuccess(); break; }
          }
        }
      }
    } catch (e) {
      log('Fout: ' + e.message);
    }
  }

  // Compare this tick's available seats to the previous tick and report the
  // churn. Seats leaving/returning are exactly the carts expiring or filling.
  function updateChurn(currentKeys) {
    const prev = state.prevKeys;
    let added = 0, removed = 0;
    if (prev) {
      currentKeys.forEach(k => { if (!prev.has(k)) added++; });
      prev.forEach(k => { if (!currentKeys.has(k)) removed++; });
      state.totalAppeared += added;
    }
    state.prevKeys = currentKeys;
    ui.counter.textContent = 'Vrij nu: ' + currentKeys.size +
      (prev ? '  ·  +' + added + ' / -' + removed + '  (totaal bijgekomen: ' + state.totalAppeared + ')' : '');
    if (prev && (added || removed)) {
      log('🔄 ' + currentKeys.size + ' vrij · +' + added + ' bij / -' + removed + ' weg');
    }
  }

  // -------------------------------------------------------- verkoopwacht ---
  // Uitwedstrijden hebben geen stoelenplattegrond (/v2/Venue/venue geeft
  // Sections: []), dus daar valt niets te scannen. Wat er wél is: het
  // event-record uit /v2/Event zegt of de verkoop openstaat. Deze modus pollt
  // dat record, meldt elke wijziging en slaat alarm zodra er gekocht kan worden.
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
    const tiers = [...byPrice.entries()].sort((a, b) => a[0] - b[0])
      .map(([prijs, n]) => n + '× €' + prijs.toFixed(2));
    return {
      sections: (venue && venue.Sections ? venue.Sections.length : 0),
      placements: epf.length,
      priced: [...byPrice.values()].reduce((a, b) => a + b, 0),
      tiers: tiers.join(' · ') || '—',
    };
  }

  const snapshot = ev => {
    const s = {};
    WATCH_FIELDS.forEach(([path]) => { s[path] = showVal(pick(ev, path)); });
    return s;
  };

  async function watchTick() {
    if (!getToken()) { log('⚠️ Geen token in sessionStorage — ben je ingelogd?'); return; }

    let ev;
    try {
      ev = (await getEventsRaw()).find(i => i.EventId === state.eventId);
    } catch (e) {
      log('Fout bij verkoopwacht: ' + e.message);
      return;
    }
    if (!ev) { log('⚠️ Event ' + state.eventId + ' staat niet meer in de shop-lijst.'); return; }

    const now = snapshot(ev);
    const prev = state.watch.prev;
    state.watch.prev = now;

    if (!prev) {
      log('👀 Beginstand: ' + WATCH_FIELDS.map(([p, l]) => l + '=' + now[p]).join(' · '));
    } else {
      WATCH_FIELDS.forEach(([p, label]) => {
        if (prev[p] !== now[p]) log('🔔 ' + label + ': ' + prev[p] + ' → ' + now[p]);
      });
    }

    // Ook de plattegrond-kant pollen: bij een uitwedstrijd is het verschijnen van
    // vakken (of het invullen van prijzen) het eerste harde teken van leven.
    let vs = null;
    try {
      vs = summarisePlacements(await getVenue(state.eventId));
    } catch (e) { log('  venue-check: ' + e.message); }

    if (vs) {
      const pv = state.watch.prevVenue;
      if (!pv) {
        log('🗺️ ' + vs.sections + ' vak(ken) · ' + vs.placements + ' plaatsen · prijzen: ' + vs.tiers);
      } else {
        if (pv.sections !== vs.sections) log('🗺️ vakken: ' + pv.sections + ' → ' + vs.sections);
        if (pv.priced !== vs.priced) log('💶 plaatsen met prijs: ' + pv.priced + ' → ' + vs.priced + ' (' + vs.tiers + ')');
        if (pv.placements !== vs.placements) log('🗺️ plaatsen: ' + pv.placements + ' → ' + vs.placements);
      }
      // Van 0 naar >0 vakken betekent dat de stoelenscan bruikbaar wordt.
      if (pv && pv.sections === 0 && vs.sections > 0) {
        log('🪑 Er zijn nu vakken voor dit event — zet de modus op "Stoelen" en start de scan.');
        beep();
        flashTitle('🪑 VAKKEN');
      }
      state.watch.prevVenue = vs;
    }

    const open = isOnSale(ev);
    const till = pick(ev, 'ButtonData.ActiveTill');
    ui.counter.textContent = (open ? '🎉 IN VERKOOP' : 'Nog dicht') +
      ' · knop: ' + showVal(pick(ev, 'ButtonData.TranslationCode')) +
      (till && !open ? ' (tot ' + till.replace('T', ' ') + ')' : '') +
      (vs ? ' · ' + vs.sections + ' vak / ' + vs.tiers : '') +
      ' · gecheckt ' + nowStr();
    ui.counter.classList.toggle('nts-idle', !open);

    if (needsLogin(ev) && !state.watch.loginWarned) {
      state.watch.loginWarned = true;
      log('🔑 De shop zegt "inloggen om te kopen" — controleer of je sessie nog geldig is; ' +
          'kooprechten zijn pas zichtbaar als je ingelogd bent.');
    }

    if (open && !state.watch.alerted) {
      state.watch.alerted = true;
      onSaleOpen(ev);
    }
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

  function startWatch() {
    if (state.watch.timer) return;
    if (state.eventId == null) { log('Kies eerst een event.'); return; }
    state.watch.prev = null;
    state.watch.prevVenue = null;
    state.watch.alerted = false;
    state.watch.loginWarned = false;
    const ev = state.events.find(e => e.eventId === state.eventId);
    log('▶️ Verkoopwacht op "' + (ev ? ev.name : state.eventId) + '" · elke ' +
        (WATCH_INTERVAL_MS / 1000) + 's een check op /v2/Event');
    setRunning(true);
    watchTick();
    state.watch.timer = setInterval(watchTick, WATCH_INTERVAL_MS);
  }

  function startSeats() {
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
    ui.counter.textContent = 'Vrij nu: —';
    const names = (state.selectedOrder.length ? state.selectedOrder : state.sections.map(s => s.VenueBuildingBlockId))
      .map((v, i) => (i + 1) + '. ' + nameByVbb(v)).join('  ');
    log('▶️ Gestart · vakken op prioriteit: ' + names + ' · gewenst: ' + state.wantedCount);
    setRunning(true);
    tick();
    state.timer = setInterval(tick, INTERVAL_MS);
  }

  function start() {
    if (state.mode === 'watch') startWatch(); else startSeats();
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.watch.timer) { clearInterval(state.watch.timer); state.watch.timer = null; }
    restoreTitle();
    setRunning(false);
  }

  // Van modus wisselen terwijl er een monitor loopt zou de knoppen en de teller
  // uit sync trekken, dus de keuze ligt vast zolang hij draait.
  function setRunning(on) {
    ui.startBtn.disabled = on;
    ui.stopBtn.disabled = !on;
    ui.modeSeats.disabled = on;
    ui.modeWatch.disabled = on;
  }

  function setMode(mode, auto) {
    state.mode = mode;
    state.modeAuto = !!auto;
    ui.modeSeats.checked = mode === 'seats';
    ui.modeWatch.checked = mode === 'watch';
    ui.panel.classList.toggle('nts-watchmode', mode === 'watch');
    ui.counter.textContent = mode === 'watch' ? 'Verkoopwacht: niet gestart' : 'Vrij nu: —';
    ui.counter.classList.toggle('nts-idle', mode === 'watch');
  }

  function onSuccess() {
    state.cart.done = true;
    stop();
    log('🎟️ ' + state.cart.acquired + ' stoel(en) staan in je winkelwagen — rond af!');
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
      if (all.length === 0) {
        log('⚠️ Geen stoelenplattegrond voor dit event (bijv. een uitwedstrijd) — de stoelenscan kan hier niets. Modus staat nu op 🔔 Verkoopwacht.');
        setMode('watch', true);
      } else {
        log('✓ ' + all.length + ' vak(ken). Klik ze aan op prioriteit (of laat leeg = alle).');
        // Alleen een eerdere automatische switch terugdraaien — een handmatig
        // gekozen modus blijft staan.
        if (state.modeAuto) setMode('seats', true);
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
      '  <div class="nts-row"><span class="nts-mode-label">Modus:</span>',
      '    <label><input type="radio" name="nts-mode" class="nts-mode-seats" checked> 🪑 Stoelen</label>',
      '    <label><input type="radio" name="nts-mode" class="nts-mode-watch"> 🔔 Verkoopwacht</label></div>',
      '  <div class="nts-label">Vakken (klik = prioriteit, 🪑 = kies stoelen): <button class="nts-refresh" title="ververs vakken">↻</button></div>',
      '  <div class="nts-sections"></div>',
      '  <div class="nts-row nts-countrow"><label>Aantal stoelen: <input type="number" class="nts-count" min="1" value="1"></label></div>',
      '  <div class="nts-row"><button class="nts-start">▶ Start</button><button class="nts-stop" disabled>■ Stop</button><button class="nts-reload" title="Verwijder de gecarte stoelen uit de winkelwagen en zet ze opnieuw">🔄 Herlaad</button></div>',
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
    ui.modeSeats = panel.querySelector('.nts-mode-seats');
    ui.modeWatch = panel.querySelector('.nts-mode-watch');
    ui.startBtn = panel.querySelector('.nts-start');
    ui.stopBtn = panel.querySelector('.nts-stop');
    ui.reloadBtn = panel.querySelector('.nts-reload');
    ui.counter = panel.querySelector('.nts-counter');
    ui.refresh = panel.querySelector('.nts-refresh');
    ui.picker = panel.querySelector('.nts-picker');
    ui.log = panel.querySelector('.nts-log');

    panel.querySelector('.nts-events').addEventListener('click', loadEvents);
    ui.modeSeats.addEventListener('change', () => setMode('seats', false));
    ui.modeWatch.addEventListener('change', () => setMode('watch', false));
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
    log('Klaar. Zorg dat je ingelogd bent en door de wachtrij, klik "Events laden".');
    restoreCart();
  }

  buildPanel();
})();
