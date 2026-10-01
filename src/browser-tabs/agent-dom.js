'use strict';

/**
 * In-page runtime for the AI agent browser tools. Serialized with
 * Function#toString and executed in an isolated world, so it must stay
 * self-contained (no closures over module scope).
 *
 * Element refs (e1, e2, …) live in the isolated world's global and are only
 * valid until the next snapshot or navigation.
 */
function pageAgentRuntime(command) {
  const state = window.__lascoAgent || (window.__lascoAgent = { refs: new Map(), seq: 0 });

  const collapse = (value, max) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return max && text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return collapse(aria, 100);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ');
      if (text.trim()) return collapse(text, 100);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      const candidate = label || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title');
      if (candidate) return collapse(candidate, 100);
      if (tag === 'input' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
        return collapse(el.value, 100);
      }
    }
    const text = el.innerText || el.textContent || '';
    if (text.trim()) return collapse(text, 100);
    const img = el.querySelector && el.querySelector('img[alt]');
    return collapse(el.getAttribute('alt') || el.getAttribute('title') || (img && img.getAttribute('alt')) || '', 100);
  };

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    ...[
      'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch',
      'combobox', 'textbox', 'searchbox', 'slider', 'treeitem',
    ].map((role) => `[role="${role}"]`),
  ].join(',');

  const describe = (el, ref) => {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const entry = {
      ref,
      role: roleOf(el),
      name: nameOf(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      inViewport:
        rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
    };
    if (tag === 'a' && el.href) entry.href = collapse(el.href, 160);
    if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value) {
      entry.value = collapse(el.value, 120);
    }
    if (tag === 'select') {
      entry.value = collapse(el.options[el.selectedIndex]?.text || '', 80);
      entry.options = Array.from(el.options).slice(0, 25).map((option) => collapse(option.text, 60));
    }
    if (el.type === 'checkbox' || el.type === 'radio') entry.checked = Boolean(el.checked);
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked) entry.checked = ariaChecked === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
    return entry;
  };

  const snapshot = (opts) => {
    const maxElements = Math.max(10, Math.min(Number(opts.maxElements) || 150, 400));
    const maxText = Math.max(0, Math.min(Number(opts.maxText) || 12000, 60000));
    state.refs = new Map();
    state.seq = 0;
    const visible = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible);
    const describedAll = visible.map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const inView = describedAll.filter(
      ({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
    );
    const offView = describedAll.filter((item) => !inView.includes(item));
    const ordered = [...inView, ...offView].slice(0, maxElements);
    const elements = ordered.map(({ el }) => {
      state.seq += 1;
      const ref = `e${state.seq}`;
      state.refs.set(ref, el);
      return describe(el, ref);
    });
    const rawText = opts.includeText === false ? '' : (document.body ? document.body.innerText : '') || '';
    const text = rawText.replace(/\n{3,}/g, '\n\n').trim();
    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      },
      elements,
      totalInteractive: visible.length,
      ...(maxText > 0 ? { text: text.slice(0, maxText), textTruncated: text.length > maxText } : {}),
    };
  };

  const resolveRef = (ref) => {
    const el = state.refs.get(String(ref || ''));
    if (!el || !el.isConnected) return null;
    return el;
  };

  const locate = (ref) => {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: 'stale-ref' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      ok: true,
      x,
      y,
      covered: Boolean(hit && hit !== el && !el.contains(hit) && !hit.contains(el)),
    };
  };

  const focusRef = (ref, clear) => {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: 'stale-ref' };
    el.focus();
    if (clear) {
      if (typeof el.select === 'function') {
        el.select();
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    return { ok: true };
  };

  const selectOption = (ref, value) => {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: 'stale-ref' };
    if (el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'not-a-select' };
    const wanted = String(value == null ? '' : value).trim().toLowerCase();
    const option = Array.from(el.options).find(
      (opt) => opt.value.toLowerCase() === wanted || collapse(opt.text).toLowerCase() === wanted,
    ) || Array.from(el.options).find((opt) => collapse(opt.text).toLowerCase().includes(wanted));
    if (!option) return { ok: false, error: 'option-not-found' };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: collapse(option.text, 80) };
  };

  const scrollPage = (opts) => {
    if (opts.ref) {
      const el = resolveRef(opts.ref);
      if (!el) return { ok: false, error: 'stale-ref' };
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      return { ok: true };
    }
    const amount = Number(opts.amount) || Math.round(window.innerHeight * 0.8);
    const dy = opts.direction === 'up' ? -amount : opts.direction === 'down' ? amount : 0;
    const dx = opts.direction === 'left' ? -amount : opts.direction === 'right' ? amount : 0;
    let target = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    while (target && target !== document.body && target !== document.documentElement) {
      const style = window.getComputedStyle(target);
      const scrollableY = /(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight;
      const scrollableX = /(auto|scroll)/.test(style.overflowX) && target.scrollWidth > target.clientWidth;
      if ((dy && scrollableY) || (dx && scrollableX)) break;
      target = target.parentElement;
    }
    if (target && target !== document.body && target !== document.documentElement) {
      target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    } else {
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    }
    return { ok: true, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
  };

  switch (command && command.op) {
    case 'snapshot':
      return snapshot(command);
    case 'locate':
      return locate(command.ref);
    case 'focus':
      return focusRef(command.ref, Boolean(command.clear));
    case 'select':
      return selectOption(command.ref, command.value);
    case 'scroll':
      return scrollPage(command);
    default:
      return { ok: false, error: 'unknown-op' };
  }
}

function buildPageAgentScript(command) {
  return `(${pageAgentRuntime.toString()})(${JSON.stringify(command)})`;
}

module.exports = { buildPageAgentScript, pageAgentRuntime };
