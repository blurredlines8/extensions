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
      .replace(/&([A-Za-z]+);/g, (m, n) => NAMED[n] || m)
      .replace(/&amp;/g, '&');
  }
  // Named entities in German stand names ("Hans Sch&auml;fer S&uuml;dkurve").
  const NAMED = {
    auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
    eacute: 'é', egrave: 'è', euml: 'ë', iuml: 'ï', ndash: '–', mdash: '—',
  };
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
    // The price category follows on the same element; Herlaad needs it, as
    // a seat in the cart is not in the (free seats only) mapping.
    const re = /data-seat-identifier="(\d+)"\s+data-combined-seat-identifier="(\d+)-(\d+)-(\d+)_(\d+)"(?:\s+data-price-category-id="(\d+)")?/g;
    let m;
    while ((m = re.exec(html || ''))) {
      const block = Number(m[3]);
      items.push({ itemId: m[1], eventId: m[2], block, seatIdx: Number(m[4]), rowIdx: Number(m[5]),
        seatId: block * 1e6 + Number(m[5]) * 1e3 + Number(m[4]), priceCat: m[6] ? Number(m[6]) : null });
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

  // -------------------------------------------------------------- groups ---

  // Several accounts (one per Firefox container) buy for one group that wants
  // to sit together. A seat only counts as held once it is in some account's
  // cart, and each account may hold just a few, so nobody can hold seats for
  // the others. Instead the first account through picks a spot with room for
  // the whole group and takes its share at one end; every later account takes
  // seats right next to, or directly behind, what the group already holds.

  // Free seats a pick would leave alone between taken ones (the shop refuses
  // picks that do: "ungenutzter Anschlussplatz").
  function strandedBy(free, picked) {
    const taken = new Set(picked);
    const isFree = id => free.has(id) && !taken.has(id);
    const lone = new Set();
    for (const p of picked) {
      for (const n of [p - 1, p + 1]) {
        if (isFree(n) && !isFree(n - 1) && !isFree(n + 1)) lone.add(n);
      }
    }
    return lone.size;
  }

  // `mine` adjacent seats at one end of a row of the spot, so what is left of
  // the spot stays together for the next account.
  function shareOf(spot, mine, free, geo) {
    // Per row the stretches of adjacent seats (a seat taken by a stranger
    // splits a row of the spot in two).
    const runs = [...runsByRow(spot).values()].flat();
    let best = null;
    for (const seats of runs) {
      seats.sort((a, b) => alongRow(a, geo) - alongRow(b, geo));
      if (seats.length < mine) continue;
      for (const w of [seats.slice(0, mine), seats.slice(-mine)]) {
        // A single spot seat left in this row would need a buyer of one.
        const cost = strandedBy(free, w) * 20 + (seats.length - mine === 1 ? 5 : 0) - seats.length * 0.1;
        if (!best || cost < best.cost) best = { cost, seats: w };
      }
    }
    if (best) return best.seats;
    return spot.slice().sort((a, b) => rowIdxOf(a) - rowIdxOf(b) || alongRow(a, geo) - alongRow(b, geo)).slice(0, mine);
  }

  // First account: find room for `total` seats over at most two rows (fewer
  // if the group does not fit anywhere) and return this account's share.
  function groupStart(freeIds, opts) {
    const mine = Math.max(1, opts.mine || 1);
    const free = new Set(freeIds);
    for (let n = Math.max(mine, opts.total || mine); n >= mine; n--) {
      const spot = pickSeats(freeIds, {
        want: n, mode: 'cluster', maxRows: opts.maxRows || 2,
        blocks: opts.blocks, geo: opts.geo, accept: opts.accept, skip: opts.skip,
      });
      if (spot.length === n) return { seats: shareOf(spot, mine, free, opts.geo), room: n, plan: spot };
    }
    return null;
  }

  // Seats' worth of distance from some seats to the group: 0 when, row by
  // row, they touch the group's seats in that row or, in a row the group
  // does not use yet, sit right behind or in front of them. Infinity when
  // there is no group seat in that row or the rows next to it.
  function gapToGroup(seats, group, geo) {
    let worst = 0;
    const rows = new Map();
    for (const id of seats) {
      const k = blockOf(id) * 1e3 + rowIdxOf(id);
      if (!rows.has(k)) rows.set(k, []);
      rows.get(k).push(id);
    }
    for (const w of rows.values()) {
      const block = blockOf(w[0]), r = rowIdxOf(w[0]);
      const inBlock = group.filter(h => blockOf(h) === block);
      const same = inBlock.filter(h => rowIdxOf(h) === r);
      const ref = same.length ? same : inBlock.filter(h => Math.abs(rowIdxOf(h) - r) === 1);
      if (!ref.length) return Infinity;
      const t = ref.map(h => alongRow(h, geo)), wt = w.map(id => alongRow(id, geo));
      const gap = Math.max(0, Math.round(Math.max(Math.min(...wt) - Math.max(...t), Math.min(...t) - Math.max(...wt))) - 1);
      worst = Math.max(worst, gap);
    }
    return worst;
  }

  // Later account: first its share of the spot the first account planned
  // (`opts.plan`, all seats of it), taken at an end so the rest stays whole.
  // When strangers took seats from the plan: the best touching stretch
  // within what is left of it, then anywhere in the group's block, keeping
  // the whole group within `maxRows` consecutive rows. Returns the closest
  // stretch even when it does not touch (`gap` > 0), so the caller can say
  // how far off it is.
  function groupJoin(freeIds, held, opts) {
    const mine = Math.max(1, opts.mine || 1);
    const maxRows = opts.maxRows || 2;
    const geo = opts.geo;
    const skip = opts.skip || new Set();
    const heldSet = new Set(held);
    const free = new Set([...freeIds].filter(id => !heldSet.has(id)));
    const ok = id => !skip.has(id) && (!opts.accept || opts.accept(id));

    const search = cands => {
      const perBlock = new Map();
      for (const h of held) perBlock.set(blockOf(h), (perBlock.get(blockOf(h)) || 0) + 1);
      let best = null;
      for (const [block] of [...perBlock].sort((x, y) => y[1] - x[1])) {
        const group = held.filter(h => blockOf(h) === block);
        const groupRows = group.map(rowIdxOf);
        const rMin = Math.min(...groupRows), rMax = Math.max(...groupRows);
        const t = group.map(h => alongRow(h, geo));
        const gMid = t.reduce((x, y) => x + y, 0) / t.length;
        const rows = runsByRow([...cands].filter(id => blockOf(id) === block));
        for (const [r, runs] of rows) {
          const span = Math.max(rMax, r) - Math.min(rMin, r) + 1;
          if (span > maxRows) continue;
          for (const run of runs) {
            for (let i = 0; i + mine <= run.length; i++) {
              const w = run.slice(i, i + mine);
              const gap = gapToGroup(w, group, geo);
              if (gap === Infinity) continue;
              const wt = w.map(id => alongRow(id, geo));
              const mid = (Math.min(...wt) + Math.max(...wt)) / 2;
              const cost = gap * 10 + (span - 1) * 2 + (groupRows.includes(r) ? 0 : 1) +
                strandedBy(free, w) * 20 + Math.abs(mid - gMid) * 0.1;
              if (!best || cost < best.cost) best = { cost, seats: w, gap };
            }
          }
        }
      }
      return best;
    };

    if (opts.plan && opts.plan.length) {
      const rest = opts.plan.filter(id => free.has(id) && ok(id));
      if (rest.length >= mine) {
        const share = shareOf(rest, mine, free, geo);
        // Adjacent within each row: no stranger's seat inside our own share.
        const whole = [...runsByRow(share).values()].every(runs => runs.length === 1);
        if (whole && gapToGroup(share, held, geo) === 0) return { seats: share, gap: 0, planned: true };
        const inPlan = search(new Set(rest));
        if (inPlan && inPlan.gap === 0) return { seats: inPlan.seats, gap: 0, planned: true };
      }
    }
    const best = search(new Set([...free].filter(ok)));
    return best ? { seats: best.seats, gap: best.gap } : null;
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
    groupStart, groupJoin, strandedBy,
    parseSchedule, parseSaleCell, dateKey, parseQueue,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeatAssistCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
