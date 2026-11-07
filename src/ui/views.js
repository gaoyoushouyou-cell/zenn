// 画面。どの画面も「見出し → 本文 → 操作」の順に並べ、
// キーボードとスクリーンリーダーで同じ順序でたどれるようにする。

import { h, clear, radioGroup, select, toggle, range, id } from './dom.js';
import * as S from '../core/session.js';
import * as History from '../core/history.js';
import { sitLabelMinutes } from '../core/format.js';
import { resolveScene } from '../visual/scene.js';

const PRESETS = [5, 10, 20, 30];

// ── ダイアログ ───────────────────────────────
export function openDialog(el, { title, body = [], content = null, actions = [], onCancel }) {
  if (!el) return;
  clear(el);
  const titleId = id('dlg');
  el.setAttribute('aria-labelledby', titleId);
  const form = h('div', { class: 'dialog-body' },
    h('h2', { id: titleId, class: 'dialog-title', text: title }),
    ...body.map((b) => (typeof b === 'string' ? h('p', { text: b }) : b)),
    content,
    actions.length ? h('div', { class: 'dialog-actions' }, ...actions.map((a) => h('button', {
      type: 'button',
      class: a.primary ? 'btn btn-primary' : a.danger ? 'btn btn-danger' : 'btn',
      'data-key': `dlg:${a.label}`,
      onclick: () => { if (a.close !== false) closeDialog(el); a.onClick && a.onClick(); },
    }, a.label))) : null,
  );
  el.append(form);
  el.oncancel = (e) => { e.preventDefault(); closeDialog(el); onCancel && onCancel(); };
  try { if (!el.open) el.showModal(); } catch { el.setAttribute('open', ''); }
  const first = el.querySelector('.btn-primary') || el.querySelector('input, select, textarea, button');
  first && first.focus();
}

let returnFocus = null;
export function closeDialog(el) {
  if (!el || !el.open) return;
  try { el.close(); } catch { el.removeAttribute('open'); }
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}
function rememberFocus() { returnFocus = document.activeElement; }

// ── 共通 ───────────────────────────────────
function topbar(ctx, { back = false, title } = {}) {
  const t = ctx.t;
  if (back) {
    return h('header', { class: 'topbar' },
      h('button', { type: 'button', class: 'btn-text back', 'data-key': 'back', onclick: () => ctx.nav('home') },
        h('span', { 'aria-hidden': 'true', text: '←  ' }), t.back),
      title ? h('span', { class: 'topbar-title', 'aria-hidden': 'true', text: '' }) : null,
    );
  }
  return h('header', { class: 'topbar' },
    h('span', { class: 'brand', 'aria-hidden': 'true', text: t.appName }),
    h('nav', { class: 'topnav', 'aria-label': t.appName },
      h('button', { type: 'button', class: 'btn-text', 'data-key': 'nav-history', onclick: () => ctx.nav('history') }, t.history),
      h('button', { type: 'button', class: 'btn-text', 'data-key': 'nav-settings', onclick: () => ctx.nav('settings') }, t.settings),
    ),
  );
}

function heading(text, cls = 'view-title') {
  return h('h1', { class: cls, tabindex: '-1', 'data-heading': '' }, text);
}

function sceneLabel(ctx) {
  // 「時刻に合わせる」のときは、いま見えている景色の名前を出す
  return ctx.t.sceneNow[resolveScene(ctx.state.settings.scene, new Date(ctx.now))];
}

function soundKey(settings) {
  if (!settings.bells) return 'silent';
  return settings.ambience === 'none' ? 'bells' : settings.ambience;
}

function summary(ctx) {
  const t = ctx.t;
  const s = ctx.state.settings;
  const parts = [s.openEnded ? t.openEnded : t.minutes(s.durationMin)];
  if (s.quiet) parts.push(t.quiet);
  else {
    parts.push(t.sound[soundKey(s)]);
    parts.push(sceneLabel(ctx));
  }
  return parts.join(' · ');
}

// ── ホーム ─────────────────────────────────
function home(ctx) {
  const t = ctx.t;
  const st = ctx.state;
  const s = st.settings;
  const returning = History.isReturning(st.history, ctx.now);
  const first = st.sessions === 0 && !st.seenGuide;
  const isPreset = !s.openEnded && PRESETS.includes(s.durationMin);
  const customLabel = s.openEnded ? '∞' : isPreset ? t.custom : t.minutes(s.durationMin);

  const durations = radioGroup({
    legend: t.durationGroup,
    legendClass: 'sr-only',
    name: 'duration',
    className: 'durations',
    value: isPreset ? s.durationMin : null,
    options: PRESETS.map((m) => ({ value: m, label: t.minutes(m) })),
    onChange: (v) => ctx.updateSettings({ durationMin: v, openEnded: false }),
  });
  // 「自由」はラジオではなくボタン（矢印キーで選ぶ途中にダイアログが開かないように）
  durations.querySelector('.choice-row').append(h('button', {
    type: 'button', class: 'choice choice-btn', 'aria-pressed': isPreset ? 'false' : 'true', 'data-key': 'custom',
    'aria-label': isPreset ? t.custom : `${t.custom}: ${s.openEnded ? t.openEnded : t.minutes(s.durationMin)}`,
    onclick: () => customDialog(ctx),
  }, h('span', { text: customLabel })));

  return h('section', { class: 'view home', 'data-view': 'home' },
    topbar(ctx),
    h('div', { class: 'home-center' },
      heading(h('span', {}, h('span', { class: 'sr-only', text: `${t.appName} — ` }), returning ? t.homeWelcomeBack : t.homeLead), 'home-lead'),
      h('button', {
        type: 'button', class: 'sit', 'data-key': 'sit', id: 'sit',
        onclick: () => ctx.start({ kind: 'zazen' }),
      }, h('span', { class: 'sit-label', text: t.sit }), h('span', { class: 'sit-sub', text: summary(ctx) })),
      durations,
      h('div', { class: 'home-row' },
        h('button', { type: 'button', class: 'chip', 'data-key': 'arrange', onclick: () => arrangeDialog(ctx) }, t.arrange),
        h('button', {
          type: 'button', class: 'chip', 'aria-pressed': s.quiet ? 'true' : 'false', 'data-key': 'quiet',
          'aria-describedby': 'quiet-hint',
          onclick: () => ctx.updateSettings({ quiet: !s.quiet }),
        }, t.quiet),
      ),
      h('p', { class: 'sr-only', id: 'quiet-hint', text: t.quietHint }),
    ),
    h('div', { class: 'home-foot' },
      h('button', { type: 'button', class: 'btn-text', 'data-key': 'guide', onclick: () => { guideStep = 0; ctx.nav('guide'); } }, t.beginner),
      h('button', { type: 'button', class: 'btn-text', 'data-key': 'kinhin', onclick: () => ctx.nav('kinhin') }, t.kinhin),
      h('button', { type: 'button', class: 'btn-text', 'data-key': 'safety', onclick: () => safetyDialog(ctx) }, t.safetyLink),
      first ? h('p', { class: 'hint', text: t.homeFirstHint }) : null,
    ),
  );
}

function customDialog(ctx) {
  const t = ctx.t;
  const s = ctx.state.settings;
  rememberFocus();
  let minutes = s.durationMin;
  const inputId = id('min');
  const input = h('input', { type: 'number', id: inputId, min: 1, max: 240, step: 1, inputmode: 'numeric', value: minutes, class: 'num' });
  const clamp = (v) => Math.max(1, Math.min(240, Math.round(Number(v) || 1)));
  const step = (d) => { minutes = clamp(Number(input.value) + d); input.value = minutes; };
  const open = h('input', { type: 'checkbox', id: id('open') });
  open.checked = s.openEnded;
  const content = h('div', { class: 'custom' },
    h('div', { class: 'stepper' },
      h('button', { type: 'button', class: 'btn round', 'aria-label': t.decrease, onclick: () => step(-1) }, '−'),
      h('label', { for: inputId, class: 'stepper-field' }, input, h('span', { text: t.customMinutes })),
      h('button', { type: 'button', class: 'btn round', 'aria-label': t.increase, onclick: () => step(1) }, '+'),
    ),
    h('label', { class: 'check', for: open.id }, open, h('span', { text: t.customOpenEnded })),
  );
  openDialog(ctx.dialogEl, {
    title: t.customTitle,
    content,
    actions: [
      { label: t.ok, primary: true, onClick: () => ctx.updateSettings({ durationMin: clamp(input.value), openEnded: open.checked }) },
      { label: t.cancel, onClick: () => ctx.render({ keepFocus: true }) },
    ],
    onCancel: () => ctx.render({ keepFocus: true }),
  });
  input.focus();
  input.select?.();
}

function arrangeDialog(ctx) {
  const t = ctx.t;
  rememberFocus();
  const s = () => ctx.state.settings;
  const content = h('div', { class: 'arrange' },
    radioGroup({
      legend: t.soundLegend, name: 'sound', value: soundKey(s()),
      options: Object.keys(t.sound).map((k) => ({ value: k, label: t.sound[k] })),
      onChange: (v) => ctx.updateSettings(v === 'silent' ? { bells: false, ambience: 'none' } : { bells: true, ambience: v === 'bells' ? 'none' : v }, { rerender: false }),
    }),
    h('p', { class: 'note', text: t.silentNote }),
    radioGroup({
      legend: t.sScene, name: 'scene', value: s().scene,
      options: Object.keys(t.scene).map((k) => ({ value: k, label: t.scene[k] })),
      onChange: (v) => ctx.updateSettings({ scene: v }, { rerender: false }),
    }),
    radioGroup({
      legend: t.sRemaining, name: 'remaining', value: s().remaining,
      options: Object.keys(t.remaining).map((k) => ({ value: k, label: t.remaining[k] })),
      onChange: (v) => ctx.updateSettings({ remaining: v }, { rerender: false }),
    }),
  );
  openDialog(ctx.dialogEl, {
    title: t.arrangeTitle,
    content,
    actions: [{ label: t.close, primary: true, onClick: () => ctx.render({ keepFocus: true }) }],
    onCancel: () => ctx.render({ keepFocus: true }),
  });
}

function safetyDialog(ctx) {
  rememberFocus();
  const t = ctx.t;
  openDialog(ctx.dialogEl, {
    title: t.safetyTitle,
    content: h('ul', { class: 'list' }, ...t.safetyBody.map((x) => h('li', { text: x }))),
    actions: [{ label: t.close, primary: true }],
  });
}

// ── 座禅中 ─────────────────────────────────
let controlsTimer = 0;
function session(ctx) {
  const t = ctx.t;
  const st = ctx.state;
  const s = st.session;
  if (!s) return home(ctx);
  const mono = ctx.mono;
  const ph = S.phase(s, mono);
  const paused = s.status === S.STATUS.PAUSED;
  const isKinhin = s.kind === 'kinhin';

  const notice = st.notice ? h('div', { class: 'notice', role: 'status' },
    h('p', { text: st.notice === 'route' ? t.audioRouteChanged : st.notice === 'unavailable' ? t.audioUnavailable : t.audioSuspended }),
    st.notice === 'route' ? h('button', { type: 'button', class: 'btn', onclick: () => { ctx.state.notice = null; ctx.restoreAudio(); ctx.render({ keepFocus: true }); } }, t.audioRestore) : null,
  ) : null;

  const controls = h('div', { class: 'controls', role: 'group', 'aria-label': t.sittingSr },
    h('button', { type: 'button', class: 'btn', 'data-key': 'pause', onclick: () => (paused ? ctx.resume() : ctx.pause()) }, paused ? t.resume : t.pause),
    s.durationMs !== null ? h('button', { type: 'button', class: 'btn', 'data-key': 'extend', onclick: () => ctx.extend() }, t.extend) : null,
    h('button', { type: 'button', class: 'btn', 'data-key': 'end', onclick: () => ctx.endEarly() }, t.end),
    h('button', { type: 'button', class: 'btn-text', 'data-key': 'say', onclick: () => ctx.sayRemaining() }, t.sayRemaining),
  );

  const view = h('section', {
    class: 'view session', 'data-view': 'session', 'data-phase': paused ? 'paused' : ph, 'data-controls': paused ? 'shown' : 'hidden',
  },
    heading(isKinhin ? t.kinhinTitle : t.sittingSr, 'sr-only'),
    h('div', { class: 'prep', 'aria-hidden': 'true' },
      h('p', { class: 'prep-title', text: isKinhin ? t.kinhinBody : t.prepTitle }),
      st.meta?.firstEver ? h('p', { class: 'prep-note', text: t.prepFirstTime }) : null,
      h('p', { class: 'prep-count', 'data-prep-count': '' }),
      h('div', { class: 'prep-line' }, h('span', { 'data-prep-bar': '' })),
    ),
    h('p', { class: 'paused-title', text: t.pausedTitle }),
    h('p', { class: 'remaining', 'data-remaining': '', 'aria-hidden': 'true' }),
    h('p', { class: 'cue', 'data-cue': '', 'aria-hidden': 'true', 'data-show': 'false' }),
    notice,
    h('p', { class: 'controls-hint', text: t.controlsHint }),
    controls,
  );

  const show = () => {
    view.dataset.controls = 'shown';
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
      if (!view.contains(document.activeElement) || document.activeElement === view.querySelector('[data-heading]')) {
        if (ctx.state.session?.status !== S.STATUS.PAUSED) view.dataset.controls = 'hidden';
      }
    }, 7000);
  };
  view.addEventListener('pointerdown', (e) => {
    show();
    if (ctx.state.notice === 'suspended') ctx.restoreAudio();
    if (!e.target.closest('button')) e.preventDefault?.();
  });
  view.addEventListener('focusin', show);
  return view;
}

/** 座禅中のキーボード: どのキーでも操作を表示、P で一時停止/再開 */
export function sessionKeydown(ctx, e) {
  if (ctx.state.view !== 'session' || !ctx.state.session) return;
  if (e.target.closest && e.target.closest('dialog')) return;
  const view = document.querySelector('[data-view="session"]');
  if (!view) return;
  if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    if (ctx.state.session.status === S.STATUS.PAUSED) ctx.resume(); else ctx.pause();
    return;
  }
  if (e.key === 'Escape') { view.dataset.controls = 'hidden'; view.querySelector('[data-heading]')?.focus(); return; }
  view.dataset.controls = 'shown';
  if (ctx.state.notice === 'suspended') ctx.restoreAudio();
}

// ── 余韻 ───────────────────────────────────
let afterTimer = 0;
function afterglow(ctx) {
  const t = ctx.t;
  const a = ctx.state.after;
  if (!a) return home(ctx);
  const chosen = new Set();
  const noteId = id('note');
  const note = h('textarea', { id: noteId, rows: 3, maxlength: 2000, placeholder: t.notePlaceholder, 'data-key': 'note' });
  const tags = h('fieldset', { class: 'tags' },
    h('legend', { text: t.afterRecordQ }),
    h('div', { class: 'choice-row' }, ...History.TAGS.map((tag) => {
      const cid = id('tag');
      const cb = h('input', { type: 'checkbox', id: cid, value: tag, 'data-key': `tag:${tag}` });
      cb.addEventListener('change', () => (cb.checked ? chosen.add(tag) : chosen.delete(tag)));
      return h('label', { class: 'choice', for: cid }, cb, h('span', { text: t.tags[tag] }));
    })),
  );
  const reflect = h('div', { class: 'reflect', 'data-show': 'false' },
    tags,
    h('div', { class: 'field' }, h('label', { for: noteId, text: t.note }), note),
    h('div', { class: 'reflect-actions' },
      h('button', { type: 'button', class: 'btn', 'data-key': 'save', onclick: () => ctx.closeAfterglow({ save: true, tags: [...chosen], note: note.value }) }, t.save),
      h('button', { type: 'button', class: 'btn', 'data-key': 'nosave', onclick: () => ctx.closeAfterglow({ save: false }) }, t.noSave),
    ),
    a.canExtend ? h('button', { type: 'button', class: 'btn-text', 'data-key': 'more', onclick: () => ctx.extend() }, t.extendAfter) : null,
  );
  const view = h('section', { class: 'view afterglow', 'data-view': 'afterglow' },
    heading(t.afterTitle),
    a.away ? h('p', { class: 'after-note', text: t.afterAway }) : a.early ? h('p', { class: 'after-note', text: t.afterEarly }) : null,
    h('p', { class: 'after-body', text: t.afterBody }),
    reflect,
  );
  const reveal = () => {
    if (reflect.dataset.show === 'true') return;
    reflect.dataset.show = 'true';
    clearTimeout(afterTimer);
  };
  clearTimeout(afterTimer);
  const delay = a.away ? 0 : ctx.state.settings.afterglowSec * 1000;
  afterTimer = setTimeout(reveal, delay);
  view.addEventListener('keydown', reveal);
  view.addEventListener('pointerdown', reveal);
  // フォーカスが隠れた要素に入ったら即座に表示（キーボード・読み上げ利用者を待たせない）
  reflect.addEventListener('focusin', reveal);
  return view;
}

// ── はじめての座禅 ───────────────────────────
let guideStep = 0;
let guidePosture = 'floor';
function guide(ctx) {
  const t = ctx.t;
  const cards = t.guideCards;
  // 0: 安全, 1: 座る場所, 2..: 姿勢・手・目・呼吸・考え, last: 始める
  const steps = [
    { kind: 'card', card: cards[0] },
    { kind: 'posture' },
    ...cards.slice(1).map((card) => ({ kind: 'card', card })),
    { kind: 'start' },
  ];
  const n = steps.length;
  guideStep = Math.max(0, Math.min(n - 1, guideStep));
  const step = steps[guideStep];
  const go = (d) => { guideStep += d; ctx.render({ focusSelector: '[data-step-title]' }); };

  let body;
  if (step.kind === 'card') {
    body = h('div', { class: 'card' },
      h('h2', { class: 'card-title', tabindex: '-1', 'data-step-title': '', text: step.card.title }),
      h('p', { text: step.card.body }),
    );
  } else if (step.kind === 'posture') {
    const desc = h('p', { class: 'posture-desc', 'aria-live': 'polite', text: t.posture[guidePosture].body });
    body = h('div', { class: 'card' },
      h('h2', { class: 'card-title', tabindex: '-1', 'data-step-title': '', text: t.postureQ }),
      radioGroup({
        legend: t.postureQ, legendClass: 'sr-only', name: 'posture', value: guidePosture,
        options: Object.keys(t.posture).map((k) => ({ value: k, label: t.posture[k].label })),
        onChange: (v) => { guidePosture = v; desc.textContent = t.posture[v].body; },
      }),
      desc,
    );
  } else {
    body = h('div', { class: 'card' },
      h('h2', { class: 'card-title', tabindex: '-1', 'data-step-title': '', text: t.guideTitle }),
      h('p', { class: 'note', text: t.guideTradition }),
      h('button', { type: 'button', class: 'btn btn-primary wide', 'data-key': 'guided', onclick: () => { ctx.markGuideSeen(); ctx.start({ kind: 'guided', minutes: 5 }); } }, t.guideStartGuided),
    );
  }

  return h('section', { class: 'view guide', 'data-view': 'guide' },
    topbar(ctx, { back: true }),
    h('div', { class: 'narrow' },
      heading(t.guideTitle),
      guideStep === 0 ? h('p', { class: 'lead', text: t.guideIntro }) : null,
      h('p', { class: 'progress', text: t.guideStep(guideStep + 1, n) }),
      body,
      h('div', { class: 'guide-nav' },
        guideStep > 0 ? h('button', { type: 'button', class: 'btn', 'data-key': 'g-back', onclick: () => go(-1) }, t.back) : h('span'),
        guideStep < n - 1 ? h('button', { type: 'button', class: 'btn btn-primary', 'data-key': 'g-next', onclick: () => go(1) }, t.next) : h('span'),
      ),
      h('button', { type: 'button', class: 'btn-text skip-guide', 'data-key': 'g-skip', onclick: () => { ctx.markGuideSeen(); ctx.start({ kind: 'zazen' }); } }, t.guideSkip),
    ),
  );
}

// ── 経行 ───────────────────────────────────
function kinhin(ctx) {
  const t = ctx.t;
  const s = ctx.state.settings;
  return h('section', { class: 'view kinhin', 'data-view': 'kinhin' },
    topbar(ctx, { back: true }),
    h('div', { class: 'narrow' },
      heading(t.kinhinTitle),
      h('p', { class: 'lead', text: t.kinhinBody }),
      h('ul', { class: 'list' }, ...t.kinhinHow.map((x) => h('li', { text: x }))),
      h('p', { class: 'caution', text: t.kinhinSafety }),
      radioGroup({
        legend: t.durationGroup, name: 'kinhin-min', className: 'durations', value: s.kinhinMin,
        options: [5, 10, 15, 20].map((m) => ({ value: m, label: t.minutes(m) })),
        onChange: (v) => ctx.updateSettings({ kinhinMin: v }, { rerender: false }),
      }),
      h('button', { type: 'button', class: 'btn btn-primary wide', 'data-key': 'kinhin-start', onclick: () => ctx.start({ kind: 'kinhin', minutes: ctx.state.settings.kinhinMin }) }, t.kinhinStart(ctx.state.settings.kinhinMin)),
    ),
  );
}

// ── 記録 ───────────────────────────────────
function historyView(ctx) {
  const t = ctx.t;
  const list = ctx.state.history;
  const now = ctx.now;
  const tot = History.totals(list);
  const rh = History.rhythm(list, now, 28);
  const satDays = rh.filter((d) => d.minutes > 0).length;
  const fmt = new Intl.DateTimeFormat(ctx.lang === 'ja' ? 'ja-JP' : 'en', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

  const rhythm = h('div', { class: 'rhythm', role: 'img', 'aria-label': t.historyRhythmAria(satDays) },
    ...rh.map((d) => {
      const dot = h('span', { class: 'rhythm-day', dataset: { sat: d.minutes > 0 ? 'true' : 'false', today: d.offset === 0 ? 'true' : 'false' } });
      // CSP（style-src 'self'）に従い、style 属性ではなく CSSOM で設定する
      if (d.minutes > 0) dot.style.setProperty('--a', Math.min(1, 0.35 + d.minutes / 40).toFixed(2));
      return dot;
    }),
  );

  const items = list.map((e) => {
    const m = sitLabelMinutes(e.sitMs);
    const meta = [t.kind[e.kind], t.entryMinutes(m)];
    if (!e.completed) meta.push(t.entryEnded);
    if (e.extendedMs) meta.push(t.entryExtended(Math.round(e.extendedMs / 60_000)));
    const li = h('li', { class: 'entry' },
      h('div', { class: 'entry-head' },
        h('time', { datetime: new Date(e.startedAt).toISOString(), text: fmt.format(e.startedAt) }),
        h('span', { class: 'entry-meta', text: meta.join(' · ') }),
      ),
      e.tags.length ? h('p', { class: 'entry-tags', text: e.tags.map((x) => t.tags[x]).join('、') }) : null,
      e.note ? h('details', { class: 'entry-note' }, h('summary', { text: t.note.replace(/（.*?）|\(.*?\)/g, '').trim() }), h('p', { text: e.note })) : null,
      h('button', {
        type: 'button', class: 'btn-text small', 'data-key': `del:${e.id}`,
        onclick: () => { rememberFocus(); openDialog(ctx.dialogEl, { title: t.deleteEntry, body: [fmt.format(e.startedAt)], actions: [{ label: t.deleteAllDo, danger: true, onClick: () => ctx.deleteEntry(e.id) }, { label: t.cancel, primary: true }] }); },
      }, t.deleteEntry),
    );
    li.style.setProperty('--fresh', History.freshness(e, now).toFixed(2));
    return li;
  });

  return h('section', { class: 'view history', 'data-view': 'history' },
    topbar(ctx, { back: true }),
    h('div', { class: 'narrow' },
      heading(t.historyTitle),
      h('p', { class: 'lead', text: t.historyLead }),
      list.length ? h('p', { class: 'totals', text: t.historyTotal(tot.count, tot.minutes) }) : null,
      list.length ? h('div', { class: 'rhythm-wrap' }, h('h2', { class: 'small-title', text: t.historyRhythm }), rhythm) : null,
      list.length ? h('ul', { class: 'entries' }, ...items) : h('p', { class: 'empty', text: t.historyEmpty }),
      h('div', { class: 'data-actions' },
        h('button', { type: 'button', class: 'btn', 'data-key': 'export', onclick: () => ctx.exportData() }, t.exportData),
        h('button', { type: 'button', class: 'btn btn-danger-quiet', 'data-key': 'delete-all', onclick: () => confirmDeleteAll(ctx) }, t.deleteAll),
      ),
    ),
  );
}

function confirmDeleteAll(ctx) {
  const t = ctx.t;
  rememberFocus();
  openDialog(ctx.dialogEl, {
    title: t.deleteAll,
    body: [t.deleteAllConfirm],
    actions: [{ label: t.deleteAllDo, danger: true, onClick: () => ctx.deleteAll() }, { label: t.cancel, primary: true }],
  });
}

// ── 設定 ───────────────────────────────────
function settingsView(ctx) {
  const t = ctx.t;
  const s = ctx.state.settings;
  const set = (patch) => ctx.updateSettings(patch, { rerender: false });
  const opts = (obj) => Object.keys(obj).map((k) => ({ value: k, label: obj[k] }));
  const sec = (title, ...fields) => h('section', { class: 'settings-sec', 'aria-labelledby': id('sec') },
    h('h2', { class: 'small-title', text: title }), ...fields);
  // aria-labelledby を見出しに結ぶ
  const fixLabel = (el) => { const hd = el.querySelector('h2'); hd.id = el.getAttribute('aria-labelledby'); return el; };
  const offline = !!(globalThis.navigator?.serviceWorker?.controller);

  return h('section', { class: 'view settings', 'data-view': 'settings' },
    topbar(ctx, { back: true }),
    h('div', { class: 'narrow' },
      heading(t.settingsTitle),
      fixLabel(sec(t.sec.sitting,
        select({ label: t.sDuration, key: 'durationMin', value: s.durationMin, options: [5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 90].concat(PRESETS.includes(s.durationMin) ? [] : [s.durationMin]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((m) => ({ value: m, label: t.minutes(m) })), onChange: (v) => set({ durationMin: v, openEnded: false }) }),
        select({ label: t.sPrep, key: 'prepSec', value: s.prepSec, options: [0, 5, 10, 20, 30, 60].map((v) => ({ value: v, label: t.sPrepOpt(v) })), onChange: (v) => set({ prepSec: v }) }),
        select({ label: t.sInterval, key: 'intervalMin', value: s.intervalMin, options: [0, 5, 10, 15, 20, 30].map((v) => ({ value: v, label: t.sIntervalOpt(v) })), onChange: (v) => set({ intervalMin: v }) }),
        select({ label: t.sAfterglow, key: 'afterglowSec', value: s.afterglowSec, options: [5, 10, 20, 40, 60].map((v) => ({ value: v, label: t.sAfterglowOpt(v) })), onChange: (v) => set({ afterglowSec: v }) }),
        toggle({ label: t.sQuiet, key: 'quiet', checked: s.quiet, note: t.quietHint, onChange: (v) => set({ quiet: v }) }),
      )),
      fixLabel(sec(t.sec.sound,
        toggle({ label: t.sBells, key: 'bells', checked: s.bells, note: t.silentNote, onChange: (v) => set({ bells: v }) }),
        select({ label: t.sBellStyle, key: 'bellStyle', value: s.bellStyle, options: opts(t.bellStyle), note: t.sBellStyleNote, onChange: (v) => set({ bellStyle: v }) }),
        select({ label: t.sBellTone, key: 'bellTone', value: s.bellTone, options: opts(t.bellTone), onChange: (v) => set({ bellTone: v }) }),
        range({ label: t.sBellVolume, key: 'bellVolume', value: s.bellVolume, onInput: (v) => set({ bellVolume: v }) }),
        h('button', { type: 'button', class: 'btn', 'data-key': 'test-bell', onclick: () => ctx.testBell() }, t.sTestBell),
        select({ label: t.sAmbience, key: 'ambience', value: s.ambience, options: opts(t.ambience), onChange: (v) => set({ ambience: v }) }),
        range({ label: t.sAmbienceVolume, key: 'ambienceVolume', value: s.ambienceVolume, onInput: (v) => set({ ambienceVolume: v }) }),
        toggle({ label: t.sCaptions, key: 'captions', checked: s.captions, onChange: (v) => set({ captions: v }) }),
        ctx.speechSupported ? toggle({ label: t.sSpeech, key: 'speech', checked: s.speech, note: t.sSpeechNote, onChange: (v) => set({ speech: v }) }) : null,
      )),
      fixLabel(sec(t.sec.display,
        select({ label: t.sScene, key: 'scene', value: s.scene, options: opts(t.scene), onChange: (v) => set({ scene: v }) }),
        select({ label: t.sRemaining, key: 'remaining', value: s.remaining, options: opts(t.remaining), onChange: (v) => set({ remaining: v }) }),
        select({ label: t.sTheme, key: 'theme', value: s.theme, options: opts(t.theme), onChange: (v) => set({ theme: v }) }),
        select({ label: t.sTextScale, key: 'textScale', value: s.textScale, options: [1, 1.25, 1.5, 2].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })), onChange: (v) => set({ textScale: v }) }),
        select({ label: t.sContrast, key: 'contrast', value: s.contrast, options: opts(t.contrast), onChange: (v) => set({ contrast: v }) }),
        select({ label: t.sMotion, key: 'motion', value: s.motion, options: opts(t.motion), onChange: (v) => set({ motion: v }) }),
        select({ label: t.sPower, key: 'power', value: s.power, options: opts(t.power), onChange: (v) => set({ power: v }) }),
        select({ label: t.sLang, key: 'lang', value: s.lang, options: opts(t.lang), onChange: (v) => ctx.updateSettings({ lang: v }) }),
      )),
      fixLabel(sec(t.sec.device,
        ctx.wakeLockSupported ? toggle({ label: t.sWakeLock, key: 'wakeLock', checked: s.wakeLock, note: t.sWakeLockNote, onChange: (v) => set({ wakeLock: v }) }) : null,
        select({ label: t.sVibrate, key: 'vibrate', value: s.vibrate, options: opts(t.vibrate), onChange: (v) => set({ vibrate: v }) }),
        ctx.notificationsSupported ? toggle({ label: t.sNotify, key: 'notifyEnd', checked: s.notifyEnd, note: t.sNotifyNote, onChange: (v, input) => ctx.enableNotify(v, input) }) : null,
      )),
      fixLabel(sec(t.sec.data,
        select({ label: t.sForget, key: 'forgetDays', value: s.forgetDays, options: [0, 30, 90, 365].map((v) => ({ value: v, label: t.forget(v) })), onChange: (v) => set({ forgetDays: v }) }),
        h('div', { class: 'data-actions' },
          h('button', { type: 'button', class: 'btn', 'data-key': 's-export', onclick: () => ctx.exportData() }, t.exportData),
          h('button', { type: 'button', class: 'btn btn-danger-quiet', 'data-key': 's-delete-all', onclick: () => confirmDeleteAll(ctx) }, t.deleteAll),
        ),
      )),
      fixLabel(sec(t.sec.about,
        h('p', { text: t.aboutBody }),
        h('p', { text: t.aboutMedical }),
        h('p', { text: t.aboutLicense }),
        h('p', { class: 'note', text: `${t.aboutVersion(ctx.version)} · ${offline ? t.aboutOffline : t.aboutOnlineOnly}` }),
      )),
    ),
  );
}

const VIEWS = { home, session, afterglow, guide, kinhin, history: historyView, settings: settingsView };

export function renderView(root, view, ctx, { focus = false, keepFocus = false, focusSelector } = {}) {
  const prevKey = keepFocus ? document.activeElement?.closest?.('[data-key]')?.dataset.key : null;
  const fn = VIEWS[view] || home;
  const el = fn(ctx);
  clear(root);
  root.append(el);
  if (prevKey) {
    const target = root.querySelector(`[data-key="${CSS.escape(prevKey)}"]`);
    if (target) { target.focus(); return; }
  }
  if (focusSelector) { root.querySelector(focusSelector)?.focus(); return; }
  if (focus) root.querySelector('[data-heading]')?.focus({ preventScroll: true });
}
