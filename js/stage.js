/* The paper theatre, moving like stop-motion (think Fantastic Mr. Fox):
 *   - everything moves in steps, ~8–12 frames a second, never with smooth easing;
 *   - each step gets a tiny random nudge (±1.5px, ±0.5°), as if a hand moved the paper between photos;
 *   - faces change by swapping images, never by morphing.
 * Layers are only ever moved through CSS variables — --ty (reveal), --rot/--skew (swing), --mx/--my/--sc
 * (the scroll scene) and the hand-nudge wobble --wx/--wy/--wr; css/site.css composes them into one
 * transform. No libraries.
 *
 * API used by app.js: Stage.wake(), Stage.wrong(), Stage.reveal(), Stage.open(),
 *                     Stage.nudge(el)
 */
(() => {
  'use strict';

  const FRAME = 100; // ms per frame for the idle loop (10 fps)
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);

  // "Be kind": phones set to reduce motion get stills (curtain simply open, no scroll scene).
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function nudge(el, amount = 1) {
    if (!el || still()) return;
    el.style.setProperty('--wx', `${(rnd(-1.5, 1.5) * amount).toFixed(1)}px`);
    el.style.setProperty('--wy', `${(rnd(-1.5, 1.5) * amount).toFixed(1)}px`);
    el.style.setProperty('--wr', `${(rnd(-0.5, 0.5) * amount).toFixed(2)}deg`);
  }

  /* ---------- the doorkeeper moon ---------- */
  const MOONS = ['moon-1-asleep', 'moon-2-drowsy', 'moon-3-awake', 'moon-4-unimpressed'];
  const moonImgs = () => MOONS.map((n) => $(`.stage .l-${n}`));
  function showMoon(i) {
    const imgs = moonImgs();
    const target = imgs[i];
    if (!target || !target.complete || !target.naturalWidth) return; // not downloaded yet: keep this face
    imgs.forEach((el, k) => { if (el) el.hidden = k !== i; });
    nudge(target);
  }

  let awake = false;
  let grumpy = null;

  // first keystroke: asleep → drowsy → awake, ~120 ms a frame. She watches you from now on.
  async function wake() {
    if (awake) return;
    awake = true;
    if (still()) { showMoon(2); return; }
    showMoon(1);
    await sleep(120);
    showMoon(2);
  }

  // wrong password: thoroughly unimpressed for ~1.2 s, then back to watching
  function wrong() {
    awake = true;
    showMoon(3);
    clearTimeout(grumpy);
    grumpy = setTimeout(() => showMoon(2), 1200);
  }

  /* ---------- right password → curtain up ---------- */
  async function reveal() {
    clearTimeout(grumpy);
    showMoon(2); // no wink frame: she stays fully awake
    // stills: no show, but leave the sign up long enough for a screen reader to say "come in"
    if (still()) { await sleep(900); return; }
    // the sign says "oh, it's you! come in." — and meanwhile the stage behind the curtain finishes
    // loading, so the curtain never lifts on half-arrived paper (gives up after 3 s)
    const behind = $$('.stage .inner img:not(.only-closed):not([hidden])').map((img) => (img.decode ? img.decode().catch(() => {}) : null));
    await Promise.all([sleep(800), Promise.race([Promise.all(behind), sleep(3000)])]);

    // the moon slides up behind the arch while the sign and ticket drop away: 6 frames
    const moons = moonImgs();
    const props = $('#gate');
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      moons.forEach((m) => m.style.setProperty('--ty', `${(-100 * k).toFixed(1)}%`));
      nudge(moons[2]);
      props.style.setProperty('--ty', `${(115 * k * k).toFixed(1)}vh`);
      props.style.setProperty('--rot', `${(7 * k).toFixed(1)}deg`);
      nudge(props, 2);
      await sleep(100);
    }
    props.hidden = true;

    // lights on, and the curtain goes up in 8 jerky steps (~1 s), a hand that speeds up a little
    const shade = $('.stage .l-shade');
    if (shade) shade.hidden = true;
    const curtain = $('.stage .l-curtain');
    for (const k of [0.06, 0.14, 0.25, 0.38, 0.53, 0.69, 0.85, 1]) {
      curtain.style.setProperty('--ty', `${(-125 * k).toFixed(1)}%`);
      nudge(curtain, 1.5);
      await sleep(125);
    }
  }

  /* ---------- open stage + idle life ---------- */
  function open() {
    $('#theatre').dataset.state = 'open';
    startIdle();
    startScroll();
  }

  /* ---------- the scroll scene: the frame is taken away, the scene fills the screen ----------
   * While the page scrolls, the theatre screen stays put (CSS sticky) and the scroll position is
   * turned into 8 steps: the frame is lifted off, the drapes pulled aside, the red paper covers the
   * screen, and the pieces move to their places in a full-screen scene; the names come in last.
   * Scrolling back plays it backwards. Pieces move through --mx/--my/--sc (and the frame's --rot).
   *
   * Targets live in a centred "scene column" of width u = min(screen width, screen height × 0.5):
   *   cx = centre x as a fraction of u · ty / by = top / bottom as a fraction of the screen height
   *   w  = width as a fraction of u.  Hanging stars use s (scale) and hang from the top edge;
   *   their cx is the point their string is tied to.
   */
  // (short strings hang a little lower, so their stars clear the top bar)
  const SCENE = {
    'star-big':          { cx: 0.14, ty: 0.045, s: 1.7 },
    'star-pink':         { cx: 0.30, ty: 0.01, s: 1.7 },
    'star-yellow':       { cx: 0.46, ty: -0.01, s: 1.7 },
    'star-shooting':     { cx: 0.62, ty: 0.06, s: 1.6 },
    'moon-peek-1':       { cx: 0.76, ty: 0.15, w: 0.40 },
    'moon-peek-2-blink': { cx: 0.76, ty: 0.15, w: 0.40 },
    'star-stick':        { cx: 0.78, by: 0.86, w: 0.13 },
    'floor':             { cx: 0.50, ty: 0.815, w: 1.40 },
    'couple-1':          { cx: 0.50, by: 0.90, w: 0.42 },
    'couple-2-blink':    { cx: 0.50, by: 0.90, w: 0.42 },
  };
  const SCENE_STEPS = 8;
  const SCENE_RUN = 0.72; // share of the scroll track that plays the move; the rest holds the scene

  let moves = null;
  let sized = { w: 0, h: 0 }; // the sticky screen's size at the last measure()
  let titleZone = null; // where the big names may sit in the finished scene: {top, bottom} in px
  let sceneK = -1;

  function startScroll() {
    if (still() || moves) return;
    $('#theatre').dataset.scroll = '';
    measure();
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; applyScene(sceneProgress()); });
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', () => {
      const r = $('#theatre-sticky').getBoundingClientRect();
      if (Math.round(r.width) === sized.w && Math.round(r.height) === sized.h) return; // nothing moved
      measure();
      sceneK = -1;
      onScroll();
    }, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(placeTitle).observe($('#scene-title'));
    applyScene(sceneProgress());
  }

  function sceneProgress() {
    const theatre = $('#theatre');
    const r = theatre.getBoundingClientRect();
    const track = r.height - $('#theatre-sticky').offsetHeight;
    const p = Math.min(1, Math.max(0, -r.top / (track * SCENE_RUN)));
    return Math.round(p * SCENE_STEPS) / SCENE_STEPS;
  }

  // Work out, for every moving piece, the translate + scale that carries its box (as laid out on the
  // stage, before any transform) onto its target box, honouring its transform-origin.
  function measure() {
    const V = $('#theatre-sticky').getBoundingClientRect();
    const S = $('#stage').getBoundingClientRect();
    const VW = V.width;
    const VH = V.height;
    sized = { w: Math.round(VW), h: Math.round(VH) };
    const u = Math.min(VW, VH * 0.5);
    const colX = (VW - u) / 2;
    // Boxes come from the layers' own inline % (of the stage box): hidden blink frames measure 0×0.
    const pct = (v) => parseFloat(v) / 100;
    const box = (el) => ({
      x: S.left - V.left + pct(el.style.left) * S.width,
      y: S.top - V.top + pct(el.style.top) * S.height,
      w: pct(el.style.width) * S.width,
      h: pct(el.style.height) * S.height,
    });
    // only the star hangers set a transform-origin (inline, e.g. "55.2% 0"); everything else turns round its centre
    const originOf = (el) => {
      const o = el.style.transformOrigin;
      if (!o) return [0.5, 0.5];
      const [x, y] = o.split(' ');
      return [pct(x), y && y.endsWith('%') ? pct(y) : 0];
    };
    const list = [];
    // speed > 1: the piece finishes its move early (the red paper should cover the screen fast)
    const move = (el, B, T, s, rot = 0, speed = 1) => {
      const [ox, oy] = originOf(el);
      list.push({
        el, s, rot, speed,
        dx: T.x + s * ox * B.w - (B.x + ox * B.w),
        dy: T.y + s * oy * B.h - (B.y + oy * B.h),
      });
    };

    // the red paper covers the whole screen
    const bd = $('.stage .l-backdrop');
    if (bd) {
      const B = box(bd);
      const s = Math.max(VW / B.w, VH / B.h) * 1.04;
      move(bd, B, { x: (VW - B.w * s) / 2, y: (VH - B.h * s) / 2 }, s, 0, 1.6); // covers the screen at step 5 of 8
    }
    // the frame is lifted up and away, the drapes pulled off to the sides
    const fr = $('.stage .l-frame');
    if (fr) { const B = box(fr); move(fr, B, { x: B.x - B.w * 0.05, y: -B.h * 1.15 - 40 }, 1.1, -4, 1.6); }
    const dl = $('.stage .l-drape-left');
    if (dl) { const B = box(dl); move(dl, B, { x: -B.w * 1.3 - 20, y: B.y }, 1.3, 0, 1.6); }
    const dr = $('.stage .l-drape-right');
    if (dr) { const B = box(dr); move(dr, B, { x: VW + 20, y: B.y }, 1.3, 0, 1.6); }
    // everything else takes its place in the scene
    for (const [name, t] of Object.entries(SCENE)) {
      const el = $(`.stage .hang[data-name="${name}"]`) || $(`.stage .l-${name}`);
      if (!el) continue;
      const B = box(el);
      if (t.s) {
        const [ox] = originOf(el);
        move(el, B, { x: colX + t.cx * u - ox * B.w * t.s, y: t.ty * VH }, t.s);
      } else {
        const s = (t.w * u) / B.w;
        const y = t.ty != null ? t.ty * VH : t.by * VH - B.h * s;
        move(el, B, { x: colX + t.cx * u - (B.w * s) / 2, y }, s);
        // the couple's heads (a little below the image box, which carries the shadow margin)
        if (name === 'couple-1') titleZone = { top: VH * 0.26, bottom: y + B.h * s * 0.04 - 14 };
      }
    }
    moves = list;
    placeTitle();
  }

  // The big names sit just above the couple's heads (not at a fixed % of the screen: with big names
  // on some screens the date ran into Thomas's head). If there isn't room between the hanging stars
  // and the heads, the names shrink to fit, anchored at the bottom.
  function placeTitle() {
    const title = $('#scene-title');
    if (!title || !titleZone) return;
    const h = title.offsetHeight;
    if (!h) return;
    const room = titleZone.bottom - titleZone.top;
    const scale = Math.max(0.6, Math.min(1, room / h));
    title.style.setProperty('--st-scale', scale.toFixed(3));
    title.style.top = `${Math.round(titleZone.bottom - h)}px`;
  }

  function applyScene(k) {
    if (!moves || k === sceneK) return;
    sceneK = k;
    $('.stage .inner').classList.toggle('unclipped', k > 0);
    for (const m of moves) {
      if (![m.dx, m.dy, m.s].every(Number.isFinite)) continue; // a broken measure must never reach CSS
      const q = Math.min(1, k * m.speed);
      m.el.style.setProperty('--mx', `${(m.dx * q).toFixed(1)}px`);
      m.el.style.setProperty('--my', `${(m.dy * q).toFixed(1)}px`);
      m.el.style.setProperty('--sc', (1 + (m.s - 1) * q).toFixed(4));
      if (m.rot) m.el.style.setProperty('--rot', `${(m.rot * q).toFixed(2)}deg`);
      if (q > 0 && q < 1) nudge(m.el, 1.3);
    }
    // the names under the stage go as soon as things move; the big names arrive in the last 3 steps
    $('#stage-caption').style.visibility = k > 0 ? 'hidden' : '';
    const title = $('#scene-title');
    const tk = Math.max(0, (k - 0.625) / 0.375);
    title.style.visibility = tk > 0 ? 'visible' : 'hidden';
    title.style.opacity = tk >= 1 ? '1' : String((0.35 + 0.45 * tk).toFixed(2));
    title.style.setProperty('--ty', `${((1 - tk) * -22).toFixed(1)}px`);
    if (tk > 0 && tk < 1) nudge(title);
    else ['--wx', '--wy', '--wr'].forEach((v) => title.style.removeProperty(v));
    // the top bar turns red only once the red paper has actually reached it (app.js reads this flag)
    const paper = $('.stage .l-backdrop');
    const reached = k > 0 && paper && paper.getBoundingClientRect().top <= $('#topbar').offsetHeight + 2;
    $('#theatre').dataset.scene = reached ? 'on' : 'off';
    document.dispatchEvent(new Event('scenechange'));
  }

  let idling = false;
  let onScreen = true;
  function startIdle() {
    if (idling || still()) return;
    idling = true;
    new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; }).observe($('#stage'));

    // each star swings on its string around the string's top, each at its own pace;
    // the shooting star hangs from two strings, so it sways flat (skew) instead of rotating
    const swings = $$('.stage .hang').map((el) => ({
      el,
      skew: el.classList.contains('skew'),
      amp: el.classList.contains('skew') ? rnd(1.6, 2.2) : rnd(2.2, 3.4),
      period: rnd(2300, 3800),
      phase: rnd(0, Math.PI * 2),
    }));
    const t0 = performance.now();
    setInterval(() => {
      if (!onScreen || document.hidden) return;
      const t = performance.now() - t0;
      for (const s of swings) {
        const a = s.amp * Math.sin(s.phase + (t / s.period) * Math.PI * 2);
        s.el.style.setProperty(s.skew ? '--skew' : '--rot', `${a.toFixed(2)}deg`);
        nudge(s.el, 0.35);
      }
    }, FRAME);

    blink('.l-couple-1', '.l-couple-2-blink', 4000, 7000);      // us: every 4–7 s
    blink('.l-moon-peek-1', '.l-moon-peek-2-blink', 5000, 12000); // the silly moon: now and then
  }

  function blink(openSel, shutSel, min, max) {
    const eyesOpen = $(`.stage ${openSel}`);
    const eyesShut = $(`.stage ${shutSel}`);
    if (!eyesOpen || !eyesShut) return;
    const once = async () => {
      if (onScreen && !document.hidden) {
        // same nudge as the open-eyes frame (each was nudged separately during the scroll scene,
        // so in the finished scene they sat a few px apart and the heads hopped on every blink)
        for (const v of ['--wx', '--wy', '--wr']) eyesShut.style.setProperty(v, eyesOpen.style.getPropertyValue(v));
        eyesShut.hidden = false;
        eyesOpen.hidden = true;
        await sleep(150);
        eyesOpen.hidden = false;
        eyesShut.hidden = true;
      }
      setTimeout(once, rnd(min, max));
    };
    setTimeout(once, rnd(min, max));
  }

  // Decode every stage image once the page has loaded, so the first blink or scene step on a slow
  // phone doesn't wait for a decode.
  addEventListener('load', () => {
    const warm = () => $$('.stage img').forEach((img) => img.decode && img.decode().catch(() => {}));
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
  });

  window.Stage = { wake, wrong, reveal, open, nudge };
})();
