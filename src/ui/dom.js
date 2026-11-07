// 小さな DOM ヘルパー。innerHTML を使わない（XSS を構造的に防ぐ）。

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let uid = 0;
export function id(prefix = 'z') {
  uid += 1;
  return `${prefix}-${uid}`;
}

/** ラジオボタンの群（ネイティブ要素なので矢印キーとスクリーンリーダーが標準で動く） */
export function radioGroup({ legend, name, options, value, onChange, className = 'choices', legendClass = '', key }) {
  const fs = h('fieldset', { class: className });
  fs.append(h('legend', { class: legendClass, text: legend }));
  const wrap = h('div', { class: 'choice-row' });
  for (const opt of options) {
    const inputId = id(name);
    const input = h('input', { type: 'radio', name, id: inputId, value: String(opt.value), 'data-key': `${key || name}:${opt.value}` });
    input.checked = String(opt.value) === String(value);
    input.addEventListener('change', () => { if (input.checked) onChange(opt.value); });
    wrap.append(h('label', { class: 'choice', for: inputId }, input, h('span', { text: opt.label })));
  }
  fs.append(wrap);
  return fs;
}

export function select({ label, options, value, onChange, note, key }) {
  const sid = id('sel');
  const nid = note ? id('note') : null;
  const sel = h('select', { id: sid, 'aria-describedby': nid, 'data-key': key || label });
  for (const o of options) {
    const opt = h('option', { value: String(o.value), text: o.label });
    if (String(o.value) === String(value)) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    const o = options.find((x) => String(x.value) === sel.value);
    onChange(o ? o.value : sel.value);
  });
  return h('div', { class: 'field' },
    h('label', { for: sid, text: label }),
    sel,
    note ? h('p', { class: 'note', id: nid, text: note }) : null,
  );
}

export function toggle({ label, checked, onChange, note, key }) {
  const tid = id('tg');
  const nid = note ? id('note') : null;
  const input = h('input', { type: 'checkbox', id: tid, role: 'switch', 'aria-describedby': nid, 'data-key': key || label });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('div', { class: 'field field-toggle' },
    h('label', { for: tid, class: 'toggle' }, input, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), h('span', { class: 'toggle-label', text: label })),
    note ? h('p', { class: 'note', id: nid, text: note }) : null,
  );
}

export function range({ label, value, min = 0, max = 1, step = 0.05, onInput, format = (v) => `${Math.round(v * 100)}%`, key }) {
  const rid = id('rg');
  const out = h('output', { for: rid, text: format(value) });
  const input = h('input', { type: 'range', id: rid, min, max, step, value, 'data-key': key || label });
  input.value = value;
  input.setAttribute('aria-valuetext', format(value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    input.setAttribute('aria-valuetext', format(v));
    onInput(v);
  });
  return h('div', { class: 'field field-range' }, h('label', { for: rid }, label, ' ', out), input);
}
