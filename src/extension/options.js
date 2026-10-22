/* Seat Assist — options page: the notification webhook. Saving asks the
   browser for permission to reach that one address (an optional host
   permission, granted per origin), so the background can POST to it. */
/* global browser, chrome */
(function () {
  'use strict';
  const ext = typeof browser !== 'undefined' ? browser : chrome;
  const KEY = 'notify:webhook';
  const $ = id => document.getElementById(id);

  function say(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.className = kind || '';
  }

  // Match patterns have no port: "http://homeassistant.local/*" covers :8123.
  const originPattern = u => u.protocol + '//' + u.hostname + '/*';

  function parse(value) {
    try {
      const u = new URL(value.trim());
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (e) { return null; }
  }

  async function load() {
    const r = await ext.storage.local.get(KEY);
    if (r && r[KEY]) {
      $('url').value = r[KEY];
      say('Meldingen staan aan.', 'ok');
    } else {
      say('Nog geen webhook ingesteld: meldingen staan uit.');
    }
  }

  async function save() {
    const u = parse($('url').value);
    if (!u) { say('Dat is geen geldige http(s)-URL.', 'bad'); return; }
    // Must run straight from the click: browsers only grant this on a user action.
    let granted = false;
    try { granted = await ext.permissions.request({ origins: [originPattern(u)] }); } catch (e) { granted = false; }
    if (!granted) { say('Zonder toestemming kan de extensie die URL niet bereiken; niets opgeslagen.', 'bad'); return; }
    await ext.storage.local.set({ [KEY]: u.href });
    say('Opgeslagen. Meldingen staan aan — stuur gerust een test.', 'ok');
  }

  async function test() {
    const r = await ext.storage.local.get(KEY);
    const url = r && r[KEY];
    if (!url) { say('Sla eerst een webhook-URL op.', 'bad'); return; }
    say('Test versturen…');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'test',
          message: '✅ Seat Assist: testmelding — het werkt.',
          sent_at: new Date().toISOString(),
        }),
      });
      if (res.ok) say('Verstuurd (HTTP ' + res.status + '). Komt hij niet aan, kijk dan in je automatisering.', 'ok');
      else say('De webhook antwoordde met HTTP ' + res.status + '. Klopt de URL?', 'bad');
    } catch (e) {
      say('Versturen mislukt: ' + (e.message || e) + '. Is het adres vanaf deze computer bereikbaar?', 'bad');
    }
  }

  async function remove() {
    const r = await ext.storage.local.get(KEY);
    const url = r && r[KEY];
    await ext.storage.local.remove(KEY);
    const u = url && parse(url);
    if (u) { try { await ext.permissions.remove({ origins: [originPattern(u)] }); } catch (e) { /* keep it then */ } }
    $('url').value = '';
    say('Verwijderd: meldingen staan uit.');
  }

  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('remove').addEventListener('click', remove);
  load();
})();
