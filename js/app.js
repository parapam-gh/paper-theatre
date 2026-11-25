/* Alina & Thomas — language switch, password lock, page rendering, RSVP. No libraries.
 *
 * Everything a guest reads after the password lives in i18n/<lang>.enc.json, encrypted
 * at build time (tools/build.mjs). The password the guest types is turned into the same
 * AES key with PBKDF2; if it decrypts, they're in. The key is kept on the device (for
 * KEY_DAYS) so returning guests skip the gate.
 */
(() => {
  'use strict';

  // We put returning guests at the top ourselves; the browser restoring an old scroll position
  // after the images load threw them from the stage into the middle of the page.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const LANGS = ['en', 'fr', 'ru'];
  const LS = { lang: 'aw-lang', key: 'aw-key' };
  const KEY_DAYS = 60;
  const THEMES = { welcome: 'cherry', schedule: 'paper', stay: 'butter', travel: 'blush', qa: 'ink', rsvp: 'cherry' };
  const DAY_MS = 86400000;

  const $ = (s, el = document) => el.querySelector(s);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: just don't remember */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  // Must match tools/build.mjs: case, spaces and punctuation don't matter ("Good Evening!" = "goodevening").
  const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  let pub = null;   // public strings + KDF salt (inlined in index.html by the build)
  let lang = 'en';
  let key = null;   // CryptoKey once unlocked
  let data = null;  // decrypted payload for the current language
  const encCache = {};
  const dataCache = {};

  let langSeq = 0;          // only the latest language tap may render (taps can overtake each other)
  let gateState = 'prompt'; // what the sign says, so a language switch keeps it
  let entering = false;     // between the right password and the site being shown
  let rsvpBusy = false;     // an RSVP is being sent
  let rsvpStale = false;    // the language changed while the RSVP panel was open: rebuild on close

  /* ---------- tiny DOM builder: text always goes in as text, never as HTML ---------- */
  function h(sel, attrs, ...kids) {
    const [tag, ...classes] = sel.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.append(...rich(v));
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  // "[placeholder copy]" from the brief gets a dotted underline so drafts are easy to spot
  function rich(str) {
    const out = [];
    const re = /\[[^[\]]*\]/g;
    let last = 0;
    let m;
    str = String(str ?? '');
    while ((m = re.exec(str))) {
      if (m.index > last) out.push(str.slice(last, m.index));
      out.push(h('span.ph', null, m[0]));
      last = re.lastIndex;
    }
    if (last < str.length) out.push(str.slice(last));
    return out;
  }

  /* ---------- fonts ----------
     Load the font files a piece of text needs (its alphabet) before showing it, so it doesn't
     flash in a fallback font first. Gives up after 0.9 s: then the fallback shows and swaps later.
     The gate only needs the sign's italic; the rest is fetched once the guest is in. */
  const FACES = ['500 1em "Cormorant Garamond"', 'italic 500 1em "Cormorant Garamond"', '600 1em "Cormorant Garamond"', '400 1em Manrope', '600 1em Manrope'];
  const GATE_FACES = ['italic 500 1em "Cormorant Garamond"'];
  function fontsFor(text, faces = FACES) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const all = Promise.all(faces.map((f) => document.fonts.load(f, text))).catch(() => {});
    return Promise.race([all, new Promise((r) => setTimeout(r, 900))]);
  }
  const sampleOf = (T) => `${T.welcome.first} ${T.welcome.second} ${T.schedule.title} ${T.ui.rsvp}`;

  /* ---------- language ---------- */
  function pickLang() {
    const saved = store.get(LS.lang);
    if (LANGS.includes(saved)) return saved;
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const code = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(code)) return code;
    }
    return 'en';
  }

  // the few words outside the gate that exist before the password
  function publicTexts() {
    const P = pub.langs[lang];
    if (P.skip) $('#skip').textContent = P.skip;
    if (P.langs) $('#langs').setAttribute('aria-label', P.langs);
    document.title = P.title;
  }

  async function setLang(l, remember) {
    const my = ++langSeq;
    lang = l;
    if (remember) store.set(LS.lang, l);
    document.documentElement.lang = l;
    document.querySelectorAll('#langs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
    publicTexts();
    if (!key) fetchEnc(l).catch(() => {}); // get the texts ready while the guest types
    if (remember) await fontsFor(pub.langs[l].gate.prompt, GATE_FACES); // a tap on EN/FR/RU: no fallback flash
    if (my !== langSeq) return;
    gateText(gateState);
    if (key && !entering) {
      const d = await decryptLang(l, key);
      if (remember) await fontsFor(sampleOf(d.t));
      if (my !== langSeq) return; // a later tap won
      data = d;
      render();
    }
  }

  /* ---------- crypto ---------- */
  async function deriveKey(password) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm(password)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(pub.kdf.salt), iterations: pub.kdf.iter },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  function fetchEnc(l) {
    encCache[l] ||= fetch(`i18n/${l}.enc.json?v=${pub.build}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((e) => { delete encCache[l]; throw e; });
    return encCache[l];
  }

  async function decryptLang(l, k) {
    if (dataCache[l] && k === key) return dataCache[l];
    const enc = await fetchEnc(l);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, k, fromB64(enc.ct));
    const payload = JSON.parse(new TextDecoder().decode(plain));
    dataCache[l] = payload;
    return payload;
  }

  // The key is remembered with an expiry date, so a borrowed phone doesn't stay unlocked forever.
  function saveKey(raw) {
    store.set(LS.key, JSON.stringify({ k: raw, exp: Date.now() + KEY_DAYS * DAY_MS }));
  }
  function readKey() {
    const v = store.get(LS.key);
    if (!v) return null;
    try {
      const o = JSON.parse(v);
      if (o && o.k && o.exp > Date.now()) return o.k;
    } catch {
      if (/^[A-Za-z0-9+/=]+$/.test(v)) return v; // saved by an earlier version, without an expiry
    }
    store.del(LS.key);
    return null;
  }

  /* ---------- password gate ---------- */
  function gateText(state) {
    gateState = state;
    const g = pub.langs[lang].gate;
    const prompt = $('#gate-prompt');
    const text = g[state] || g.prompt;
    if (prompt.textContent !== text) Stage.nudge($('#sign')); // the sign gets bumped when it changes
    prompt.textContent = text;
    $('#gate-label').textContent = g.label;
    $('#gate-submit').setAttribute('aria-label', g.submit);
  }

  async function tryStoredKey() {
    const raw = readKey();
    if (!raw) return false;
    try {
      const k = await crypto.subtle.importKey('raw', fromB64(raw), { name: 'AES-GCM' }, true, ['decrypt']);
      data = await decryptLang(lang, k);
      key = k;
      if (!(store.get(LS.key) || '').startsWith('{')) saveKey(raw); // give an old saved key its expiry
      return true;
    } catch (e) {
      if (e && e.name === 'OperationError') store.del(LS.key); // password changed since: ask again
      return false;
    }
  }

  let checking = false;
  async function onGateSubmit() {
    if (checking || entering) return; // an extra Enter during the check or the show does nothing
    const input = $('#gate-input');
    if (!norm(input.value)) { input.focus(); return; }
    checking = true;
    const btn = $('#gate-submit');
    btn.disabled = true;
    gateText('checking');
    try {
      const k = await deriveKey(input.value);
      await decryptLang(lang, k); // throws OperationError for a wrong password
      key = k;
      saveKey(toB64(await crypto.subtle.exportKey('raw', k)));
      input.blur();
      entering = true;
      fontsFor(sampleOf(dataCache[lang].t)); // fetch the site's fonts during the show
      gateText('right');
      await Stage.reveal(); // moon up, props drop, curtain up (or a still pause)
      await enterSite();
    } catch (e) {
      entering = false;
      if (e && e.name === 'OperationError') wrongPassword();
      else { gateText('offline'); console.error(e); } // the right password, but the texts didn't arrive
    } finally {
      checking = false;
      btn.disabled = false;
    }
  }

  function wrongPassword() {
    Stage.wrong();
    gateText('wrong');
    const ticket = $('#gate-form');
    ticket.classList.remove('shake');
    void ticket.offsetWidth; // restart the animation
    ticket.classList.add('shake');
    // the typed word stays visible and selected: a typo can be seen and fixed, or simply typed over
    const input = $('#gate-input');
    input.focus();
    input.select();
  }

  async function enterSite() {
    data = await decryptLang(lang, key); // the language may have changed during the show
    entering = false;
    document.documentElement.classList.remove('returning');
    // the names go under the stage BEFORE it opens: the stage then drops to the middle of the screen
    // once, with the names already there (not once without them and again with them)
    render();
    $('#gate').hidden = true;
    Stage.open(); // open stage + idle life (stars swing, blinks)
    $('#site').hidden = false;
    $('#rsvp-open').hidden = false;
    $('#skip').hidden = false;
    // the theatre is no longer "password, please?" for screen readers
    const theatre = $('#theatre');
    theatre.removeAttribute('aria-labelledby');
    theatre.setAttribute('aria-label', pub.langs[lang].title);
    window.scrollTo(0, 0);
    // land keyboard and screen-reader users on the content
    const heading = $('#welcome .names');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  }

  /* ---------- page ---------- */
  function render() {
    const T = data.t;
    const S = data.shared;
    $('#rsvp-open').textContent = T.ui.rsvp;
    $('#theatre').setAttribute('aria-label', pub.langs[lang].title);
    const W = T.welcome;
    const cap = $('#stage-caption');
    cap.replaceChildren(
      h('p.cap__names', { 'aria-hidden': 'true' }, ...names(W)), // the h1 below carries the names
      h('p.cap__date', null, W.date),
      h('p.cap__place', { text: W.place }),
      h('a.cap__scroll', { href: '#welcome' }, `${T.ui.scroll} ↓`));
    cap.hidden = false;
    $('#scene-title').replaceChildren(h('p.st__names', null, ...names(W)), h('p.st__date', null, W.date));
    $('#site').replaceChildren(secWelcome(T, S), secSchedule(T, S), secStay(T), secTravel(T, S), secQA(T), secRSVP(T), finale(T));
    // never rebuild the RSVP panel under the guest's fingers
    if ($('#rsvp-dialog').open || rsvpBusy) rsvpStale = true;
    else buildRsvp(T);
    watchSections();
  }

  const sec = (id, ...kids) =>
    h(`section.sec.t-${THEMES[id]}${id === 'welcome' ? '.welcome' : ''}`, { id, 'data-theme': THEMES[id] },
      hangingStar(id), h('div.sec__in', null, ...kids), moonSays(id));

  // Personality, light touches only (brief §6): a paper star hanging into some sections from the one
  // above (sways with plain CSS), and the peeking moon in a corner with a one-liner in the couple's voice.
  const STARS = { schedule: 'star-yellow', stay: 'star-pink', travel: 'star-big', qa: 'star-yellow', rsvp: 'star-pink' };
  function hangingStar(id) {
    const star = STARS[id];
    if (!star) return null;
    return h('img.hang-star', { src: `img/kit/${star}-sm.webp`, alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async' });
  }
  function moonSays(id) {
    const line = data.t.moon && data.t.moon[id];
    if (!line) return null;
    // in Travel she peeks in from the left, for variety
    return h(`div.moon-says${id === 'travel' ? '.left' : ''}`, null,
      h('p.moon-says__line', { text: line }),
      h('img.moon-says__moon', { src: 'img/kit/moon-peek-1-sm.webp', alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async' }));
  }
  const title = (t) => h('h2.h2', null, t);
  const lede = (t) => (t ? h('p.lede', { text: t }) : null);
  const block = (b) => h('div.block', null, h('h3.h3', { text: b.h }), h('p', { text: b.t }));
  // "Alina" + "& Thomas" / "и Томас": only the "&" / "и" is italic, so neither name is set apart.
  // .l2 is the second line where names break in two (big names); inline under the stage.
  function names(W) {
    const m = /^(\S+)\s+(.+)$/.exec(W.second) || [null, '', W.second];
    return [W.first, ' ', h('span.l2', null, h('em', null, m[1]), ' ', m[2])];
  }

  // Welcome: the invitation first, then when and where, then the way into the details. The names
  // are already on the stage (and in the scene), so here they are for screen readers only.
  function secWelcome(T, S) {
    const W = T.welcome;
    return sec('welcome',
      h('h1.names', null, ...names(W)),
      W.line ? h('p.welcome__line', { text: W.line }) : null,
      h('p.welcome__when', null, W.weekend || W.date),
      h('p.welcome__place', { text: W.place }),
      countdown(W, S),
      h('ul.jump', null, ...['schedule', 'stay', 'travel', 'qa'].map((id) => h('li', null, h('a', { href: `#${id}` }, W.nav[id])))));
  }

  // The end of the page closes the show the way it opened: the moon falls asleep again.
  function finale(T) {
    const W = T.welcome;
    return h('section.finale', { id: 'finale', 'data-theme': 'cream' },
      h('img.finale__moon', { src: 'img/kit/moon-1-asleep-sm.webp', alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async' }),
      T.finale ? h('p.finale__line', { text: T.finale.line }) : null,
      h('p.finale__names', null, ...names(W)),
      h('p.finale__date', null, W.date));
  }

  function countdown(W, S) {
    // whole calendar days between today and the wedding day
    const [y, mo, d] = S.countdown_to.slice(0, 10).split('-').map(Number);
    const now = new Date();
    const n = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
    if (n <= 0) return h('p.count', null, h('span.count__n', null, n === 0 ? W.today : W.past));
    const form = new Intl.PluralRules(lang).select(n);
    return h('p.count', null, h('span.count__n', null, String(n)), h('span.count__l', null, W.countdown[form] || W.countdown.other));
  }

  function secSchedule(T, S) {
    const C = T.schedule;
    const days = ['fri', 'sat', 'sun'].map((day) => h('div.day', null,
      h('h3.label', null, C.days[day]),
      ...S.events.filter((e) => e.day === day).map((e) => eventCard(e, C.events[e.id], T.ui, S))));
    return sec('schedule', title(C.title), lede(C.line), ...days);
  }

  // "@church_tbc" in shared.json → that language's ui.church_tbc
  const whereOf = (e, U) => (e.where && e.where.startsWith('@') ? U[e.where.slice(1)] || '' : e.where);

  function eventCard(e, L, U, S) {
    const maps = e.maps === 'venue' ? S.venue.maps : e.maps;
    const actions = [];
    if (e.start) {
      actions.push(h('span.cal-label', null, U.calendar));
      actions.push(h('a.chip-link', { href: gcalUrl(e, L, S), target: '_blank', rel: 'noopener', 'aria-label': `${U.calendar}: ${clean(L.title)} (${U.google})` }, U.google));
      actions.push(h('button.chip-link', { type: 'button', onclick: () => downloadIcs(e, L, S), 'aria-label': `${U.calendar}: ${clean(L.title)} (${U.ics})` }, U.ics));
    }
    if (maps) actions.push(h('a.chip-link', { href: maps, target: '_blank', rel: 'noopener', 'aria-label': `${U.directions}: ${clean(placeOf(e, S))}` }, `${U.directions} ↗`));
    return h('article.ev', null,
      h('div.ev__time', { text: L.time }),
      h('h4.ev__title', { text: L.title }),
      // where, then the dress code, each on its own line (French puts a non-breaking space before a colon)
      h('p.ev__meta', null,
        h('span.ev__where', null, ...rich(whereOf(e, U))),
        h('span.ev__dress', null, `${U.dress}${lang === 'fr' ? ' :' : ':'} `, ...rich(L.dress))),
      h('p', { text: L.text }),
      actions.length ? h('div.ev__actions', null, ...actions) : null);
  }

  function secStay(T) {
    const C = T.stay;
    return sec('stay', title(C.title), lede(C.line), ...C.blocks.map(block));
  }

  function secTravel(T, S) {
    const C = T.travel;
    // the groups and their order come from the (encrypted) content, so no place names sit in this file
    const groups = Object.keys(C.taxi_groups).map((g) => h('div.taxi-group', null,
      h('p.label', null, C.taxi_groups[g]),
      ...S.taxis.filter((x) => x.group === g).map((x) =>
        h('div.taxi', null, h('span', null, x.name), h('a', { href: `tel:${x.phone.replace(/\s/g, '')}` }, x.phone)))));
    return sec('travel', title(C.title), lede(C.line), ...C.blocks.map(block),
      h('div.taxis', null, h('h3.h3', null, C.taxis_title), h('p', null, C.taxis_line), ...groups));
  }

  function secQA(T) {
    const C = T.qa;
    // the +/× mark is decoration: kept out of the question screen readers announce
    return sec('qa', title(C.title), h('div.qa', null,
      ...C.items.map((it) => h('details', null,
        h('summary', null, h('span', null, it.q), h('span.qa-mark', { 'aria-hidden': 'true' })),
        h('p', { text: it.a })))));
  }

  function secRSVP(T) {
    const C = T.rsvp;
    return sec('rsvp', title(C.title), lede(C.line), h('button.big-btn', { type: 'button', onclick: openRsvp }, C.open));
  }

  /* The top bar takes the colour of the section under it, and the RSVP button flips to
     contrast: a hit-test on scroll just below the bar. */
  let watching = false;
  function watchSections() {
    let queued = false;
    const update = () => {
      queued = false;
      const y = $('#topbar').offsetHeight + 1;
      for (const s of document.querySelectorAll('#site > section')) {
        const r = s.getBoundingClientRect();
        if (r.top <= y && r.bottom > y) {
          if (document.body.dataset.under !== s.dataset.theme) document.body.dataset.under = s.dataset.theme;
          return;
        }
      }
      // over the theatre: cream, or red once the scroll scene has covered the screen
      document.body.dataset.under = $('#theatre').dataset.scene === 'on' ? 'cherry' : 'gate';
    };
    update();
    if (watching) return;
    watching = true;
    const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
    document.addEventListener('scenechange', onScroll);
  }

  /* ---------- add to calendar ---------- */
  const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (s) => String(s).replace(/[[\]]/g, '');
  const icsEsc = (s) => clean(s).replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r\n|\r|\n/g, '\\n');
  const placeOf = (e, S) => (e.maps === 'venue' ? S.venue.address : whereOf(e, data.t.ui));

  function gcalUrl(e, L, S) {
    const q = new URLSearchParams({
      action: 'TEMPLATE',
      text: `${L.title} · ${pub.langs[lang].title}`,
      dates: `${icsDate(e.start)}/${icsDate(e.end || e.start)}`,
      location: clean(placeOf(e, S)),
      details: clean(L.text),
    });
    return `https://calendar.google.com/calendar/render?${q}`;
  }

  function downloadIcs(e, L, S) {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Alina & Thomas//Wedding//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${e.id}-2027@alina-thomas`,
      `DTSTAMP:${icsDate(new Date().toISOString())}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.end || e.start)}`,
      `SUMMARY:${icsEsc(`${L.title} · ${pub.langs[lang].title}`)}`,
      `LOCATION:${icsEsc(placeOf(e, S))}`,
      `DESCRIPTION:${icsEsc(L.text)}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = h('a', { href: url, download: `alina-thomas-${e.id}.ics` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* ---------- RSVP ---------- */
  function openRsvp() {
    const dlg = $('#rsvp-dialog');
    if (!dlg.open) dlg.showModal();
  }

  // The panel holds the form and, after sending, the thank-you; the "again" button brings the
  // filled form back instead of an empty one.
  let rsvpForm = null;
  function buildRsvp(T) {
    const C = T.rsvp;
    const F = C.form;
    const dlg = $('#rsvp-dialog');
    const chip = (type, name, value, label, extra = {}) =>
      h('label.chip', null, h('input', { type, name, value, ...extra }), h('span', null, label));
    const field = (id, label, hint, input) =>
      h('div.field', null, h('label', { for: id }, label, hint ? h('span.hint', null, hint) : null), input);

    const ifYes = h('div', null,
      h('fieldset.field', null, h('legend', null, F.days), h('div.chips', null,
        chip('checkbox', 'days', 'Fri', F.day_fri), chip('checkbox', 'days', 'Sat', F.day_sat, { checked: true }), chip('checkbox', 'days', 'Sun', F.day_sun))),
      field('r-food', F.food, F.food_hint, h('input.input', { id: 'r-food', name: 'food', autocomplete: 'off' })),
      field('r-song', F.song, null, h('input.input', { id: 'r-song', name: 'song', autocomplete: 'off' })),
      h('fieldset.field', null, h('legend', { text: F.shuttle }), h('div.chips', null,
        chip('radio', 'shuttle', 'yes', F.shuttle_yes), chip('radio', 'shuttle', 'no', F.shuttle_no))));

    const msg = h('p.form-msg', { id: 'r-msg', role: 'status', 'aria-live': 'polite' });
    const form = h('form', { id: 'rsvp-form', novalidate: true },
      field('r-names', F.names, F.names_hint, h('input.input', { id: 'r-names', name: 'names', autocomplete: 'name', required: true })),
      h('fieldset.field', { id: 'r-coming' }, h('legend', null, F.coming), h('div.chips', null,
        chip('radio', 'coming', 'yes', F.yes, { required: true }), chip('radio', 'coming', 'no', F.no))),
      ifYes,
      field('r-note', F.note, null, h('textarea.input', { id: 'r-note', name: 'note', rows: 3 })),
      // spam trap: hidden from people and screen readers, a meaningless name so autofill leaves it alone
      h('div.hp', { 'aria-hidden': 'true' }, h('label', null, 'Leave empty', h('input', { name: 'hp_x9', tabindex: '-1', autocomplete: 'off' }))),
      msg, // above the button, so it's on screen when Send is
      h('button.send', { type: 'submit' }, F.send));

    form.addEventListener('change', () => {
      ifYes.hidden = form.elements.coming.value === 'no';
      if (form.elements.coming.value) $('#r-coming', form).removeAttribute('aria-invalid');
    });
    form.addEventListener('input', (e) => { if (e.target.id === 'r-names' && e.target.value.trim()) e.target.removeAttribute('aria-invalid'); });
    form.addEventListener('submit', (ev) => submitRsvp(ev, form, T));
    rsvpForm = form;

    dlg.replaceChildren(h('div.panel', { id: 'rsvp-panel' },
      h('div.panel__top', null,
        h('h2.h2', { id: 'rsvp-heading' }, F.heading),
        h('button.panel__close', { type: 'button', 'aria-label': F.close, onclick: () => dlg.close() }, '×')),
      form));
  }

  async function submitRsvp(ev, form, T) {
    ev.preventDefault();
    if (rsvpBusy) return;
    const F = T.rsvp.form;
    const msg = $('#r-msg', form);
    const btn = $('.send', form);
    const fd = new FormData(form);
    const names = String(fd.get('names') || '').trim();
    const coming = fd.get('coming');
    if (!names || !coming) {
      // say what's missing, mark it, and take the guest there
      const nameField = $('#r-names', form);
      const comingField = $('#r-coming', form);
      // aria-invalid needs the value "true" (an empty attribute counts as false)
      for (const [el, bad] of [[nameField, !names], [comingField, !coming]]) {
        if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
      }
      nameField.setAttribute('aria-describedby', 'r-msg');
      comingField.setAttribute('aria-describedby', 'r-msg');
      msg.textContent = F.required;
      (!names ? nameField : $('input[name="coming"]', form)).focus();
      return;
    }
    const yes = coming === 'yes';
    const payload = {
      token: data.config.rsvp_token,
      lang,
      names,
      coming,
      days: yes ? fd.getAll('days').join(', ') : '',
      food: yes ? String(fd.get('food') || '') : '',
      song: yes ? String(fd.get('song') || '') : '',
      shuttle: yes ? String(fd.get('shuttle') || '') : '',
      note: String(fd.get('note') || ''),
      website: String(fd.get('hp_x9') || ''), // spam trap: real guests leave it empty
    };
    rsvpBusy = true;
    btn.disabled = true;
    btn.textContent = F.sending;
    msg.textContent = '';
    try {
      const url = data.config.rsvp_endpoint;
      if (url) {
        // text/plain keeps it a "simple" request: no CORS preflight, which Apps Script can't answer
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        const res = await r.json();
        if (!res.ok) throw new Error(res.error || 'RSVP failed');
      } else {
        console.warn('[rsvp] no endpoint yet — demo mode, nothing was saved', { ...payload, token: '…' });
        await new Promise((r) => setTimeout(r, 400));
      }
      showThanks(T, yes);
    } catch (e) {
      console.error(e);
      msg.textContent = F.error;
    } finally {
      rsvpBusy = false;
      btn.disabled = false;
      btn.textContent = F.send;
    }
  }

  function showThanks(T, yes) {
    const C = T.rsvp;
    const th = yes ? C.thanks_yes : C.thanks_no;
    const dlg = $('#rsvp-dialog');
    const panel = $('#rsvp-panel');
    panel.hidden = true;
    $('#rsvp-thanks', dlg)?.remove();
    const heading = h('h2.h2', { id: 'rsvp-thanks-heading', tabindex: '-1' }, th.h);
    dlg.append(h('div.panel.thanks', { id: 'rsvp-thanks' },
      heading,
      h('p.lede', null, th.t),
      h('div.row', null,
        h('button.chip-link', { type: 'button', onclick: changeAnswer }, C.again),
        h('button.chip-link', { type: 'button', onclick: () => dlg.close() }, C.form.close))));
    dlg.setAttribute('aria-labelledby', 'rsvp-thanks-heading');
    heading.focus(); // a screen reader hears that it went through
  }

  function changeAnswer() {
    const dlg = $('#rsvp-dialog');
    $('#rsvp-thanks', dlg)?.remove();
    $('#rsvp-panel').hidden = false;
    dlg.setAttribute('aria-labelledby', 'rsvp-heading');
    $('#r-names', rsvpForm).focus();
  }

  // Close by tapping outside the panel only: a press that starts and ends on the backdrop.
  // (On phones the panel fills the screen, so only × closes it; selecting text in a field and
  // releasing below it, or tapping the blank paper to hide the keyboard, no longer closes it.)
  function wireDialog() {
    const dlg = $('#rsvp-dialog');
    const outside = (e) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let downOutside = false;
    dlg.addEventListener('pointerdown', (e) => { downOutside = e.target === dlg && outside(e); });
    dlg.addEventListener('click', (e) => {
      if (downOutside && e.target === dlg && outside(e)) dlg.close();
      downOutside = false;
    });
    dlg.addEventListener('close', () => {
      if (rsvpStale && !rsvpBusy) { rsvpStale = false; buildRsvp(data.t); }
    });
  }

  /* ---------- start ---------- */
  async function init() {
    // Catch the ticket's submit first thing: an Enter before everything is ready waits instead of
    // being lost (index.html's CSP already stops the browser from sending the form by itself).
    let ready = false;
    let early = false;
    $('#gate-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (ready) onGateSubmit(); else early = true;
    });

    try {
      const inline = document.getElementById('public-data');
      pub = inline && inline.textContent.trim()
        ? JSON.parse(inline.textContent)
        : await (await fetch('i18n/public.json', { cache: 'no-cache' })).json();
    } catch (e) {
      console.error('public data', e);
      document.documentElement.classList.remove('fonts-wait', 'returning');
      return;
    }
    const params = new URLSearchParams(location.search);
    const openOnly = params.has('open'); // ?open — the open stage without unlocking (artwork only)
    if (params.has('reset')) { // ?reset — forget this device's unlock, to watch the show again
      store.del(LS.key);
      history.replaceState(null, '', location.pathname + (openOnly ? '?open' : ''));
    }
    lang = pickLang();
    document.querySelectorAll('#langs button').forEach((b) =>
      b.addEventListener('click', () => setLang(b.dataset.lang, true).catch(console.error)));
    await setLang(lang, false);
    fontsFor(pub.langs[lang].gate.prompt, GATE_FACES).then(() => document.documentElement.classList.remove('fonts-wait'));
    $('#gate-input').addEventListener('input', (e) => {
      // the first keystroke wakes the moon; a browser silently autofilling a saved password doesn't
      if (e.inputType) Stage.wake();
      if (gateState === 'wrong' || gateState === 'offline') gateText('prompt');
    });
    $('#rsvp-open').addEventListener('click', openRsvp);
    wireDialog();
    if (openOnly) Stage.open();

    if (await tryStoredKey()) {
      await fontsFor(sampleOf(data.t));
      await enterSite();
      return;
    }
    document.documentElement.classList.remove('returning'); // no valid key after all: show the gate
    ready = true;
    if (early && norm($('#gate-input').value)) onGateSubmit();
    else if (matchMedia('(pointer: fine)').matches) $('#gate-input').focus();
  }

  init();
})();
