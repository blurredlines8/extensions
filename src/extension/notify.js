/* Seat Assist — notifications: a JSON POST to a webhook you set yourself (for
   example Home Assistant, which can pass it on to Telegram). Sent from the
   background because the shop page may not reach it: an https page cannot
   call an http address on your network, and the webhook sends no CORS
   headers. The URL is a secret (the webhook id works as a password): it lives
   in extension storage only and is never logged. */
/* global browser, chrome */
(function () {
  'use strict';
  const ext = typeof browser !== 'undefined' ? browser : chrome;
  const KEY = 'notify:webhook';

  async function send(payload) {
    const r = await ext.storage.local.get(KEY);
    const url = r && r[KEY];
    if (!url) return { none: true };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ sent_at: new Date().toISOString() }, payload)),
    });
    return { ok: res.ok, status: res.status };
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'open-options') {
      ext.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type !== 'notify') return false;
    send(msg.payload || {})
      .then(sendResponse)
      .catch(e => sendResponse({ error: String((e && e.message) || e) }));
    return true;   // answer asynchronously
  });
})();
