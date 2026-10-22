/* Seat Assist (TIXX) — pure helpers: decoding, page parsing and seat choice.
   No DOM and no network, so they can be tested in Node against recorded
   responses. Loaded before content.js and shares its content-script scope. */
(function (root) {
  'use strict';

  // A seat id encodes its place: <block, 7 digits><row index, 3><seat index, 3>,
  // e.g. 7890935013007 = block 7890935, row index 13, seat index 7. The indexes
  // are positions in the plan, not the printed row and seat numbers.
  const blockOf = id => Math.floor(id / 1e6);
  const rowIdxOf = id => Math.floor(id / 1e3) % 1e3;
  const seatIdxOf = id => id % 1e3;

  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }
  // Block names come padded for alignment ("W  3"); show them as "W 3".
  const tidy = s => decodeEntities(s).replace(/\s+/g, ' ').trim();

  // The decoding mirrors the shop's own seatmap client (joinAvailabilityToSeatmap
  // and joinMappingToSeatmap in seatmap-client.js): ids are delta-encoded, a
  // seat is free when its status is exactly 1, and in the mapping the price
  // category is delta-encoded too (so 0 means "same as the previous seat").
  function decodeAvailability(av) {
    const free = new Set();
    let id = 0;
    for (const r of (av && av.seats) || []) { id += r[0]; if (r[1] === 1) free.add(id); }
    const ga = new Map();
    id = 0;
    for (const r of (av && av.generalAdmissions) || []) { id += r[0]; ga.set(id, r[1] || 0); }
    return { free, ga };
  }

  function decodeMapping(mp) {
    const names = {};
    for (const c of (mp && mp.priceCategories) || []) names[c.id] = tidy(c.name);
    const seatCat = new Map();
    let id = 0, cat = 0;
    for (const r of (mp && mp.seats) || []) { id += r[0]; cat += r[2]; seatCat.set(id, cat); }
    const gaCat = new Map();
    id = 0; cat = 0;
    for (const r of (mp && mp.generalAdmissions) || []) { id += r[0]; cat += r[2]; gaCat.set(id, cat); }
    return { names, seatCat, gaCat };
  }

  // Resale seats sit in the same plan under their own price category
  // ("Kat. II Ticketbörse"); its id carries a 1000000000 offset.
  function isResaleCategory(catId, names) {
    const n = (names && names[catId]) || '';
    return /ticketb(ö|oe)rse|zweitmarkt|weiterverkauf|resale|secondary/i.test(n) || catId >= 1e9;
  }

  // ---------------------------------------------------------- venue page ---

  // Return the balanced [...] or {...} literal that starts at `start`.
  function sliceBalanced(str, start) {
    const open = str[start], close = open === '[' ? ']' : '}';
    let depth = 0, inStr = null;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) return str.slice(start, i + 1);
    }
    return null;
  }

  const unescapeJs = s => s
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1');

  // Everything the seat plan needs is in an inline script on the venue page
  // (…/areaplan/venue/event/<id>): the signed parameters for the Eventim API,
  // the stands/blocks that have free seats, and the price categories.
  function parseVenuePage(html) {
    const out = { loggedIn: null, title: null, seatmap: null, areas: [], prices: [], limits: parseLimits(html) };
    const lm = /"user_logged":(true|false)/.exec(html);
    if (lm) out.loggedIn = lm[1] === 'true';
    // Title: the info button's label, else the hidden <h1> ("A - B | Shop | …").
    const tm = /aria-label="Event Info - ([^"]+)"/i.exec(html) || /<h1[^>]*>([^<|]+)\|/.exec(html);
    if (tm) out.title = tidy(tm[1]);

    const at = html.indexOf('new OLS6.Seatmap(');
    if (at >= 0) {
      const block = html.slice(at, at + 2000);
      const str = k => { const m = new RegExp(k + ':\\s*"([^"]*)"').exec(block); return m ? m[1] : null; };
      const num = k => { const m = new RegExp(k + ':\\s*"?(\\d+)"?').exec(block); return m ? m[1] : null; };
      const sm = {
        cType: str('cType'), cId: str('cId'), evId: str('evId'), server: str('server'),
        params: { a_affiliateId: num('a_affiliateId'), timestamp: num('timestamp'), signature: str('signature') },
      };
      if (sm.cType && sm.cId && sm.evId && sm.params.signature) {
        sm.key = sm.cType + '-' + sm.cId + '-' + sm.evId;
        out.seatmap = sm;
      }
    }

    const al = html.indexOf('areaList:');
    if (al >= 0) {
      const lit = sliceBalanced(html, html.indexOf('[', al));
      try {
        for (const a of JSON.parse(lit) || []) {
          if (!a.id) continue;   // id 0 is the "Alle Tribünen" pseudo-entry
          out.areas.push({
            // rawName is sent back to the shop exactly as it gave it (entities and all).
            id: a.id, name: tidy(a.name), rawName: a.name, free: a.freeSeats,
            blocks: (a.subAreas || []).map(b => ({ id: b.id, name: tidy(b.name), free: b.freeSeats, resale: !!b.clubsaleEnabled })),
          });
        }
      } catch (e) { /* layout changed; the seat plan still works without it */ }
    }

    const re = /addPriceCategoryData\(\s*'p(\d+)',\s*(true|false),\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*(\d+)/g;
    let m;
    while ((m = re.exec(html))) {
      out.prices.push({ id: Number(m[1]), name: tidy(unescapeJs(m[3])), price: unescapeJs(m[4]), n: Number(m[5]) });
    }
    return out;
  }

  // Stand ("Tribüne") of a block; `raw` gives it the way the shop sends it
  // along with addseats (HTML entities included: "TRIB&#220;NE S&#220;DWEST").
  function standOf(areas, blockId, raw) {
    const a = (areas || []).find(x => x.blocks.some(b => b.id === blockId));
    return a ? (raw ? a.rawName : a.name) : '';
  }

  // Blocks from the full seat plan (all blocks, also the sold-out ones).
  function blocksFromSeatmap(sm) {
    const out = [];
    for (const area of (sm && sm.areas) || []) {
      for (const b of area.blocks || []) {
        out.push({ id: b.id, name: tidy(b.name), rawName: decodeEntities(b.name), ga: (b.generalAdmissions || []).length > 0 });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
  }

  // seatInfos of one block → id → printed row and seat number.
  function seatLabels(blockJson) {
    const map = new Map();
    for (const s of (blockJson && blockJson.seatInfos) || []) map.set(s.id, { row: s.row, seat: s.seatNumber, ga: !!s.GA });
    return map;
  }

  // ------------------------------------------------------- shop responses ---

  // addseats answers with a seat card whose price field is the form field
  // the add-to-cart POST expects (<block>_<seatIdx>_<rowIdx>): a <select>
  // when there are several prices to choose from, else a hidden input with
  // the one price (some shops send value 0 there).
  function parseSeatCard(html) {
    const sm = /<select[^>]*\bname="([^"]+)"/.exec(html || '');
    if (!sm) {
      const hm = /<input[^>]*type="hidden"[^>]*>/.exec(html || '');
      const name = hm && /\bname="([^"]+)"/.exec(hm[0]);
      const value = hm && /\bvalue="([^"]*)"/.exec(hm[0]);
      if (!name || !value) return null;
      const lm = /data-test-seat-card-price-label[^>]*>([\s\S]*?)<\/div>/.exec(html);
      const pm = /data-test-seat-card-price(?!-)[^>]*>([\s\S]*?)<\/div>/.exec(html);
      const label = [lm && tidy(lm[1].replace(/<[^>]*>/g, ' ')), pm && tidy(pm[1])].filter(Boolean).join(' - ');
      const opt = { value: value[1], selected: true, label: label || 'prijs ' + value[1] };
      return { field: name[1], options: [opt], chosen: opt };
    }
    const body = html.slice(sm.index, html.indexOf('</select>', sm.index));
    const options = [];
    const re = /<option\s+value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g;
    let m;
    while ((m = re.exec(body))) {
      options.push({ value: m[1], selected: /\bselected\b/.test(m[2]), label: tidy(m[3]) });
    }
    if (!options.length) return null;
    return { field: sm[1], options, chosen: options.find(o => o.selected) || options[0] };
  }

  // Seat cards in the cart: item id (for deleteitem) and event-block-seat_row.
  function parseCart(html) {
    const items = [];
    const re = /data-seat-identifier="(\d+)"\s+data-combined-seat-identifier="(\d+)-(\d+)-(\d+)_(\d+)"/g;
    let m;
    while ((m = re.exec(html || ''))) {
      const block = Number(m[3]);
      items.push({ itemId: m[1], eventId: m[2], block, seatIdx: Number(m[4]), rowIdx: Number(m[5]),
        seatId: block * 1e6 + Number(m[5]) * 1e3 + Number(m[4]) });
    }
    return items;
  }

  // ------------------------------------------------------------ choosing ---

  // Seat positions from the full plan: rows hold segments of [id, x, y]
  // triples, delta-encoded like everything else. Per block we also derive the
  // direction a row runs in and the seat pitch, so "above each other" can be
  // judged in real plan units, whatever the block's orientation.
  function seatGeometry(sm) {
    const pos = new Map();
    const axes = new Map();
    for (const area of (sm && sm.areas) || []) {
      for (const b of area.blocks || []) {
        let best = null;
        for (const row of b.rows || []) {
          for (const seg of row.seats || []) {
            let id = 0, x = 0, y = 0;
            const pts = [];
            for (const s of seg) { id += s[0]; x += s[1]; y += s[2]; pos.set(id, [x, y]); pts.push([x, y]); }
            if (pts.length >= 2 && (!best || pts.length > best.length)) best = pts;
          }
        }
        if (best) {
          const [x0, y0] = best[0], [x1, y1] = best[best.length - 1];
          const len = Math.hypot(x1 - x0, y1 - y0) || 1;
          const pitch = Math.hypot(best[1][0] - x0, best[1][1] - y0) || len / (best.length - 1);
          axes.set(b.id, { ux: (x1 - x0) / len, uy: (y1 - y0) / len, pitch });
        }
      }
    }
    return { pos, axes };
  }

  // Position of a seat along its row, in seat pitches. Without geometry the
  // seat index is a fair stand-in.
  function alongRow(id, geo) {
    const p = geo && geo.pos.get(id);
    const ax = geo && geo.axes.get(blockOf(id));
    if (!p || !ax) return seatIdxOf(id);
    return (p[0] * ax.ux + p[1] * ax.uy) / ax.pitch;
  }

  // Free seats of one block → per row index the runs of adjacent seats.
  function runsByRow(ids) {
    const rows = new Map();
    for (const id of ids.slice().sort((a, b) => a - b)) {
      const r = rowIdxOf(id);
      if (!rows.has(r)) rows.set(r, []);
      const runs = rows.get(r);
      const last = runs[runs.length - 1];
      if (last && seatIdxOf(id) === seatIdxOf(last[last.length - 1]) + 1) last.push(id);
      else runs.push([id]);
    }
    return rows;
  }

  // Best compact group of `want` seats in one block: a stretch of adjacent
  // seats in each of 1..maxRows consecutive rows, every stretch overlapping
  // the one in the row before. Fewer rows beat more; then the straightest
  // stack; then not leaving a lone free seat behind (the shop refuses picks
  // that strand one: "ungenutzter Anschlussplatz").
  function clusterInBlock(ids, want, maxRows, geo) {
    const rows = runsByRow(ids);
    const minPer = want >= 4 ? 2 : 1;
    let best = null;

    // All stretches of length lo..hi within a row, with their span along the row.
    const stretches = (r, lo, hi) => {
      const out = [];
      for (const run of rows.get(r) || []) {
        for (let len = lo; len <= Math.min(hi, run.length); len++) {
          for (let i = 0; i + len <= run.length; i++) {
            const seats = run.slice(i, i + len);
            const t = seats.map(id => alongRow(id, geo));
            const lone = (i === 1 ? 1 : 0) + (run.length - i - len === 1 ? 1 : 0);
            out.push({ seats, lo: Math.min(...t), hi: Math.max(...t), mid: t.reduce((a, b) => a + b, 0) / len, lone });
          }
        }
      }
      return out;
    };

    for (const r0 of [...rows.keys()].sort((a, b) => a - b)) {
      for (let k = 1; k <= maxRows && k * minPer <= want; k++) {
        if (best && best.k < k) break;
        const walk = (i, left, prev, picked, cost) => {
          if (i === k) {
            if (left !== 0) return;
            if (!best || k < best.k || (k === best.k && cost < best.cost)) {
              best = { k, cost, seats: picked.flatMap(p => p.seats) };
            }
            return;
          }
          const rowsLeft = k - i - 1;
          const lo = Math.max(minPer, left - rowsLeft * want);
          const hi = left - rowsLeft * minPer;
          if (hi < lo) return;
          for (const s of stretches(r0 + i, lo, hi)) {
            // The shop refuses picks that strand a lone seat, so only do
            // that when nothing else is left.
            let c = cost + s.lone * 20;
            if (prev) {
              // The stretch must sit under the previous one, not next to it.
              if (s.hi < prev.lo - 0.5 || s.lo > prev.hi + 0.5) continue;
              c += Math.abs(s.mid - prev.mid) + Math.abs(s.seats.length - prev.seats.length) * 0.25;
            }
            if (best && k === best.k && c >= best.cost) continue;
            walk(i + 1, left - s.seats.length, s, picked.concat([s]), c);
          }
        };
        walk(0, want, null, [], 0);
      }
    }
    return best ? best.seats : null;
  }

  // Pick `want` seats from the free ones. Blocks are tried in priority order
  // (empty = every block); the first block that can serve the request wins.
  //   mode 'row'     — adjacent seats in one row
  //   mode 'cluster' — a compact group over up to `maxRows` consecutive rows
  //   mode 'loose'   — the first free seats, across blocks
  function pickSeats(freeIds, opts) {
    const want = Math.max(1, opts.want || 1);
    const mode = opts.mode || 'row';
    const skip = opts.skip || new Set();
    const ids = [...freeIds].filter(id => !skip.has(id) && (!opts.accept || opts.accept(id)));
    const order = opts.blocks && opts.blocks.length ? opts.blocks : [...new Set(ids.map(blockOf))];
    const byBlock = block => ids.filter(id => blockOf(id) === block).sort((a, b) => a - b);
    if (mode === 'loose' || want === 1) return order.flatMap(byBlock).slice(0, want);
    const maxRows = mode === 'cluster' ? Math.max(1, opts.maxRows || 3) : 1;
    for (const block of order) {
      const got = clusterInBlock(byBlock(block), want, maxRows, opts.geo);
      if (got) return got;
    }
    return [];
  }

  // Ticket limits from the venue page: most regular blocks are "marked" with
  // a lower per-order maximum than the rest of the stadium.
  function parseLimits(html) {
    const out = { marked: new Map(), maxMarked: null, maxTotal: null };
    // An object {id: name} when blocks are marked, an empty array when not.
    const mm = /markedBlocksForContingent:\s*(\{[^}]*\}|\[[^\]]*\])/.exec(html);
    if (mm) {
      try {
        const v = JSON.parse(mm[1]);
        if (!Array.isArray(v)) for (const [id, name] of Object.entries(v)) out.marked.set(Number(id), tidy(name));
      } catch (e) { /* leave empty */ }
    }
    const a = /maxTicketsInMarkedBlocks:\s*(\d+)/.exec(html);
    const b = /maxTicketAmount:\s*(\d+)/.exec(html);
    if (a) out.maxMarked = Number(a[1]);
    if (b) out.maxTotal = Number(b[1]);
    return out;
  }

  // The most tickets one order may hold in a block (Infinity = no known limit).
  // `held` = this event's seats already in the cart; they count against both
  // the overall cap and, when in marked blocks, the marked-block cap.
  function blockLimit(limits, blockId, held) {
    if (!limits) return Infinity;
    const inCart = held || [];
    const total = (limits.maxTotal || Infinity) - inCart.length;
    if (!(limits.marked.has(blockId) && limits.maxMarked)) return total;
    const markedHeld = inCart.filter(id => limits.marked.has(blockOf(id))).length;
    return Math.min(limits.maxMarked - markedHeld, total);
  }

  // Blocks this shop sells right now: the venue page's areaList. The seat-plan
  // API also shows free seats in blocks sold elsewhere (other contingents);
  // addseats answers those with an empty 404. Null when the list is missing,
  // so a changed page does not block everything.
  function saleBlocks(venue) {
    if (!venue || !venue.areas || !venue.areas.length) return null;
    const out = new Set();
    for (const a of venue.areas) for (const b of a.blocks) out.add(b.id);
    return out;
  }

  // ------------------------------------------------------------ schedule ---

  // "18.09.26, 12 Uhr (10 Tickets pro Mitglied)" → { at: ms, limit: 10 }.
  // Times are the club's local time; the browser runs in the same zone.
  function parseSaleCell(text) {
    const m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4}),?\s*(\d{1,2})(?:[:.](\d{2}))?\s*Uhr/.exec(text || '');
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const at = new Date(y, Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5] || 0)).getTime();
    const lim = /\((\d+)\s*Tickets?/i.exec(text);
    return { at, limit: lim ? Number(lim[1]) : null };
  }

  // A club's presale table (columns: date, kickoff, opponent, competition,
  // members' presale, general sale) → one row per match with both moments.
  function parseSchedule(html) {
    const rows = [];
    const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
    const cellText = c => tidy(c.replace(/<[^>]*>/g, ' ').replace(/%\/?nb%/g, ''));
    for (const table of tables) {
      const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      const cells = trs.map(tr => (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(cellText));
      if (!cells.length || !/datum/i.test(cells[0].join(' ')) || !/vorverkauf/i.test(cells[0].join(' '))) continue;
      for (const c of cells.slice(1)) {
        if (c.length < 6) continue;
        const d = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(c[0]);
        if (!d) continue;
        const y = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
        const opp = /^(.*?)\s*\((H|A)\)\s*$/.exec(c[2]);
        rows.push({
          date: [String(d[1]).padStart(2, '0'), String(d[2]).padStart(2, '0'), String(y)].join('.'),
          kickoff: c[1].replace(/\s*Uhr$/i, ''),
          opponent: opp ? opp[1] : c[2],
          home: opp ? opp[2] === 'H' : null,
          competition: c[3],
          members: parseSaleCell(c[4]),
          general: parseSaleCell(c[5]),
        });
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------- queue ---

  // Before and during a sale the shop sends everyone to a Queue-it page on its
  // own domain (/queue/view). Its inline `inqueueInfo` says which phase that
  // is: pageId "before" (pre-queue: whoever is in before the start gets a
  // random place) or the queue itself, with your position once known.
  function parseQueue(html) {
    const at = html.indexOf('inqueueInfo:');
    const lit = at >= 0 ? sliceBalanced(html, html.indexOf('{', at)) : null;
    if (!lit) return null;
    let info;
    try { info = JSON.parse(lit); } catch (e) { return null; }
    const t = info.ticket || {};
    const ms = s => (s ? Date.parse(s) : NaN);
    const start = ms(t.eventStartTimeUTC);
    const expected = ms(t.expectedServiceTimeUTC);
    return {
      before: info.pageId === 'before',
      page: info.pageId || null,
      name: tidy(info.texts && info.texts.header),
      startAt: Number.isNaN(start) ? null : start,
      ahead: t.usersInLineAheadOfYou == null ? null : Number(t.usersInLineAheadOfYou),
      expectedAt: Number.isNaN(expected) ? null : expected,
    };
  }

  // dd.mm.yyyy from free text ("Dienstag, 27.10.2026 20:45").
  function dateKey(text) {
    const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text || '');
    return m ? [m[1].padStart(2, '0'), m[2].padStart(2, '0'), m[3]].join('.') : null;
  }

  const api = {
    blockOf, rowIdxOf, seatIdxOf, tidy, decodeEntities,
    decodeAvailability, decodeMapping, isResaleCategory,
    parseVenuePage, standOf, blocksFromSeatmap, seatLabels, seatGeometry,
    parseSeatCard, parseCart, pickSeats, parseLimits, blockLimit, saleBlocks,
    parseSchedule, parseSaleCell, dateKey, parseQueue,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeatAssistCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
