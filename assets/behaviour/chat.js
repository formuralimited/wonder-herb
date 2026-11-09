/* The chat widget — the front end, now wired to an answer service.
 *
 * WHAT THIS DOES AND DOES NOT DO. It owns the launcher, the panel, the message
 * list, the composer and every visible state. It owns NO answer logic and no
 * policy: no keyword matching, no FAQ lookup, no heuristics, and no decision
 * about what may be said. All of that is server/chat.js, deliberately, because
 * anything in this file is editable by whoever is reading the page.
 *
 * ===================================================================
 * THE ANSWER BOUNDARY — P13-T5 left one function hollow; this is it.
 * ===================================================================
 * `requestAnswer(text, lang)` is the ONLY place that knows where an answer
 * comes from. It returns a typed result and nothing else in this file inspects
 * anything but `kind`, one of: answer | refusal | unavailable | offline |
 * error. Filling it in changed nothing else — not the markup, not the states,
 * not the strings. That was the whole point of building the boundary first.
 *
 * NO SERVICE IS STILL A SUPPORTED STATE. With data/site.json's chat.apiBase
 * empty, every send answers `unavailable`, the composer is never enabled, and
 * the widget behaves exactly as it shipped. That is what the live site does
 * until the API has a host (Phase 11), and it is a data edit to change.
 *
 * THE REFUSAL STATE, which was built before anything could trigger it, now
 * can. This is a health-products site: a question about treating a condition
 * is refused and referred to a practitioner. server/chat.js decides that —
 * before the model is called, and again on the model's reply — and this file
 * only renders the outcome.
 *
 * NOTHING IS STORED. No transcript, no localStorage, no analytics, here or on
 * the server (owner, 31 Oct 2026). Visitors type their health details into
 * chat boxes; HK PDPO retention is a decision nobody has taken, so nothing is
 * kept until someone takes it.
 */
(function () {
  'use strict';

  var panel = document.getElementById('wh-chat-panel');
  var launcher = document.getElementById('wh-chat-launcher');
  if (!panel || !launcher) return;        /* a page without the chrome: do nothing */

  var closeBtn = document.getElementById('wh-chat-close');
  var log = document.getElementById('wh-chat-log');
  var composer = document.getElementById('wh-chat-composer');
  var input = document.getElementById('wh-chat-input');

  /* The wording comes from data/site.json, rendered into the markup. Read it
     back off the DOM rather than duplicating it here, so there is exactly one
     copy of every string and changing one stays a data edit. */
  var strings = {
    refusal: panel.getAttribute('data-refusal') || '',
    error: panel.getAttribute('data-error') || '',
    offline: panel.getAttribute('data-offline') || ''
  };

  var lang = (document.documentElement.getAttribute('lang') || 'zh').toLowerCase();

  /* Where the answer service is, from data/site.json's chat.apiBase. Empty is
     a supported state and the one the live site ships in until the API has a
     host: the widget then behaves exactly as P13-T5 shipped it. */
  var api = (panel.getAttribute('data-api') || '').replace(/\/+$/, '');

  /* The only kinds render() knows. Used to enable the composer and to reject
     anything unexpected coming back from the API. */
  var KINDS = ['answer', 'refusal', 'unavailable', 'offline', 'error'];

  /* PROGRESSIVE ENHANCEMENT, and in this order on purpose. The markup ships
     the composer disabled with a placeholder that says why, so a visitor
     without JavaScript - or with this file blocked, or with no service
     configured - is never shown an input that silently eats what they type
     (the dead-control failure of finding 23). It is enabled here, and only
     here, once there is something on the other end of it. */
  if (api && input) {
    input.disabled = false;
    var send = composer && composer.querySelector('.wh-chat-send');
    if (send) send.disabled = false;
  }

  /* ------------------------------------------------- the answer boundary */

  /* Returns { kind, text }. kind is one of:
       'answer'      a real reply to show
       'refusal'     a clinical question; show the referral, never an answer
       'unavailable' there is no answer service configured
       'offline'     the browser says there is no network
       'error'       the request failed
     The five kinds and the strings are unchanged from P13-T5; only this body
     was replaced, which is what the boundary was for.

     `api` is data/site.json's chat.apiBase, rendered into the panel. Empty
     means no service: every send answers 'unavailable' exactly as before, and
     the composer was never enabled, so nothing can call this anyway.

     THE DECISION IS THE SERVER'S, NOT THIS FILE'S. server/chat.js refuses
     clinical questions and strips efficacy language out of the model's reply.
     That has to be true on the server: anything here is editable by whoever is
     looking at the page. This function reads `kind` and renders it - it never
     decides what may be said. */
  function requestAnswer(text, pageLang) {
    if (navigator && navigator.onLine === false) {
      return Promise.resolve({ kind: 'offline' });
    }
    if (!api) return Promise.resolve({ kind: 'unavailable' });

    return fetch(api + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, lang: pageLang })
    }).then(function (response) {
      /* 429 is the rate limit and 400 an over-long question. Both already
         arrive as { kind: 'error' }, so there is no status handling here: a
         sixth kind would render as silence, because render() knows five. */
      if (!response.ok && response.status !== 429 && response.status !== 400) {
        return { kind: 'error' };
      }
      return response.json();
    }).then(function (body) {
      /* Trust `kind` only if it is one we render. A changed or proxied API must
         not be able to put arbitrary markup on the page - and addMessage uses
         textContent, so even an answer cannot. */
      if (!body || KINDS.indexOf(body.kind) === -1) return { kind: 'error' };
      return body;
    }).catch(function () {
      return { kind: 'error' };     /* network, CORS, DNS, a parked API */
    });
  }

  /* --------------------------------------------------------- rendering */

  function addMessage(kind, text) {
    if (!text) return null;
    var p = document.createElement('p');
    p.className = 'wh-chat-msg wh-chat-msg-' + kind;
    p.textContent = text;          /* textContent, never innerHTML: these
                                      strings are editable content */
    log.appendChild(p);
    scrollToEnd();
    return p;
  }

  /* Keep the newest message in view. Called after every append; on a phone the
     panel is near-full-screen, so this is the difference between seeing a
     reply and not knowing one arrived. */
  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  /* Shown while a request is in flight and removed the moment it resolves,
     including on failure - an indicator left spinning after an error reads as
     a hang. It was written at P13-T5 before anything could wait, so that the
     markup, the styling and the removal path were proven before they mattered. */
  function showTyping() {
    var el = document.createElement('div');
    el.className = 'wh-chat-typing';
    el.setAttribute('aria-hidden', 'true');   /* the result is announced, not the wait */
    el.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function render(result) {
    if (!result) return;
    if (result.kind === 'refusal') return addMessage('refusal', strings.refusal);
    if (result.kind === 'offline') return addMessage('error', strings.offline);
    if (result.kind === 'error') return addMessage('error', strings.error);
    if (result.kind === 'answer') return addMessage('system', result.text);
    /* 'unavailable' is already on screen as the panel's opening message, so
       repeating it on every send would be noise rather than information. */
    return null;
  }

  /* ------------------------------------------------------------ opening */

  var lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    /* focus the close button, not the input: the input is disabled today, and
       focusing a disabled control strands a keyboard user */
    (input && !input.disabled ? input : closeBtn).focus();
    document.addEventListener('keydown', onKeydown);
    scrollToEnd();
  }

  function close() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown);
    (lastFocus && lastFocus.focus ? lastFocus : launcher).focus();
  }

  function onKeydown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); }
  }

  launcher.addEventListener('click', function () {
    if (panel.hidden) open(); else close();
  });
  if (closeBtn) closeBtn.addEventListener('click', close);

  /* ------------------------------------------------------------ sending */

  if (composer) {
    composer.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input || input.disabled) return;      /* no service configured */
      var text = (input.value || '').trim();
      if (!text) return;
      addMessage('user', text);
      input.value = '';
      var typing = showTyping();
      requestAnswer(text, lang).then(function (result) {
        if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
        render(result);
      }).catch(function () {
        if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
        render({ kind: 'error' });
      });
    });
  }

  /* Exposed for test:behaviour, which asserts the refusal and error states by
     effect. The live site's composer is disabled while chat.apiBase is empty,
     so without this seam those states would be unreachable - and a state
     nobody can reach is a state nobody has checked. */
  window.WonderHerbChat = {
    open: open,
    close: close,
    render: render,
    requestAnswer: requestAnswer
  };
})();
