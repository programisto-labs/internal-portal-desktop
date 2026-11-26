'use strict';

/**
 * Browser shell of Lasco Desktop in VM mode (docs/vm-mode.md): tab strip and address bar over the native web
 * views of Desktop (`lascoDesktop.browserTabs`). No portal, no Lasco account: the VM never holds a Lasco session.
 */
(function vmShell() {
  const desktop = window.lascoDesktop;
  if (!desktop || !desktop.browserTabs || !desktop.vm) return;
  const bt = desktop.browserTabs;

  /** @type {Map<string, { url: string, title: string, favicon: string | null, loading: boolean, security: string | null, canGoBack: boolean, canGoForward: boolean }>} */
  const tabs = new Map();
  const order = [];
  let activeId = null;
  let homeUrl = 'https://www.google.com/';
  let seq = 0;

  const el = (id) => document.getElementById(id);
  const tabsEl = el('tabs');
  const address = el('address');
  const content = el('content');
  const panel = el('managed-panel');
  const managed = el('managed');

  function newTabId() {
    seq += 1;
    return `shell-${Date.now().toString(36)}-${seq}`;
  }

  /** Text of the address bar → URL: an address, else a search. */
  function resolveInput(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
    if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }

  function sendBounds() {
    const rect = content.getBoundingClientRect();
    void bt.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }

  function ensureTab(tabId, url) {
    if (!tabs.has(tabId)) {
      tabs.set(tabId, { url: url || '', title: url || 'Nouvel onglet', favicon: null, loading: true, security: null, canGoBack: false, canGoForward: false });
      order.push(tabId);
    }
    return tabs.get(tabId);
  }

  function render() {
    tabsEl.textContent = '';
    for (const tabId of order) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      const button = document.createElement('div');
      button.className = `tab${tabId === activeId ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tabId === activeId));
      button.title = tab.title;
      if (tab.favicon && /^(https?:|data:image\/)/i.test(tab.favicon)) {
        const img = document.createElement('img');
        img.src = tab.favicon;
        img.alt = '';
        button.append(img);
      } else {
        const dot = document.createElement('span');
        dot.className = 'dot';
        button.append(dot);
      }
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.title || tab.url || 'Nouvel onglet';
      const close = document.createElement('button');
      close.className = 'close';
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Fermer l’onglet');
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tabId);
      });
      button.append(title, close);
      button.addEventListener('mousedown', (event) => {
        if (event.button === 1) closeTab(tabId);
        else if (event.button === 0) selectTab(tabId);
      });
      tabsEl.append(button);
    }
    const active = activeId ? tabs.get(activeId) : null;
    el('back').disabled = !active || !active.canGoBack;
    el('forward').disabled = !active || !active.canGoForward;
    el('reload').disabled = !active;
    el('lock').className = `lock ${active && active.security ? active.security : ''}`;
    if (document.activeElement !== address) address.value = active ? active.url : '';
    document.title = active ? `${active.title} — Lasco` : 'Lasco';
  }

  async function selectTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeId = tabId;
    sendBounds();
    await bt.select({ tabId });
    render();
  }

  async function openTab(url, { background = false } = {}) {
    const safe = resolveInput(url) || homeUrl;
    const tabId = newTabId();
    ensureTab(tabId, safe);
    const result = await bt.create({ tabId, url: safe });
    if (!result || !result.ok) {
      tabs.delete(tabId);
      order.splice(order.indexOf(tabId), 1);
      render();
      return null;
    }
    if (!background || !activeId) await selectTab(tabId);
    else render();
    return tabId;
  }

  function forgetTab(tabId) {
    if (!tabs.has(tabId)) return;
    const index = order.indexOf(tabId);
    tabs.delete(tabId);
    if (index >= 0) order.splice(index, 1);
    if (activeId === tabId) {
      activeId = null;
      const next = order[Math.min(index, order.length - 1)];
      if (next) void selectTab(next);
      else void openTab(homeUrl);
    }
    render();
  }

  function closeTab(tabId) {
    void bt.close({ tabId });
    forgetTab(tabId);
  }

  function cycle(delta) {
    if (order.length < 2 || !activeId) return;
    const index = order.indexOf(activeId);
    void selectTab(order[(index + delta + order.length) % order.length]);
  }

  function runShortcut(action) {
    if (action === 'new-tab') {
      void openTab(homeUrl);
      address.focus();
      address.select();
    } else if (action === 'focus-address') {
      address.focus();
      address.select();
    } else if (action === 'close-tab') {
      if (activeId) closeTab(activeId);
    } else if (action === 'next-tab') cycle(1);
    else if (action === 'previous-tab') cycle(-1);
    else if (action === 'select-last-tab' && order.length) void selectTab(order[order.length - 1]);
    else if (typeof action === 'string' && action.startsWith('select-tab-')) {
      const target = order[Number(action.slice('select-tab-'.length)) - 1];
      if (target) void selectTab(target);
    }
  }

  function setPanel(open) {
    panel.hidden = !open;
    managed.setAttribute('aria-expanded', String(open));
    // The native page is drawn above this document: hide it while the panel is open.
    void bt.setOverlay({ active: open });
  }

  // --- Native events -------------------------------------------------------------------------------------------
  bt.onState((state) => {
    if (!state || typeof state.tabId !== 'string') return;
    const tab = ensureTab(state.tabId, state.url);
    tab.url = state.url || tab.url;
    tab.title = state.title || tab.url;
    tab.favicon = state.favicon || null;
    tab.loading = Boolean(state.isLoading);
    tab.security = state.security || null;
    tab.canGoBack = Boolean(state.canGoBack);
    tab.canGoForward = Boolean(state.canGoForward);
    render();
  });
  // Pop-ups and « open in a new tab » of the pages, links handed to Desktop, the browser daemon's `open`.
  bt.onOpenRequest(
    (request) => {
      if (!request || typeof request.url !== 'string') return;
      const background = request.disposition === 'background-tab';
      if (typeof request.adoptedTabId === 'string') {
        ensureTab(request.adoptedTabId, request.url);
        if (!background) void selectTab(request.adoptedTabId);
        else render();
        return;
      }
      void openTab(request.url, { background });
    },
    { adoptPopups: true }
  );
  bt.onClosed((payload) => payload && forgetTab(payload.tabId));
  bt.onShortcut((payload) => payload && runShortcut(payload.action));
  desktop.vm.onTabOpened((payload) => {
    if (!payload || typeof payload.tabId !== 'string') return;
    ensureTab(payload.tabId, payload.url);
    if (payload.active) activeId = payload.tabId;
    render();
  });
  desktop.vm.onTabActivated((payload) => {
    if (!payload || !tabs.has(payload.tabId)) return;
    activeId = payload.tabId;
    render();
  });

  // --- Chrome ---------------------------------------------------------------------------------------------------
  el('omnibox').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = resolveInput(address.value);
    if (!url) return;
    address.blur();
    if (activeId) void bt.navigate({ tabId: activeId, url });
    else void openTab(url);
  });
  address.addEventListener('focus', () => address.select());
  address.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      address.blur();
      render();
    }
  });
  el('back').addEventListener('click', () => activeId && bt.goBack({ tabId: activeId }));
  el('forward').addEventListener('click', () => activeId && bt.goForward({ tabId: activeId }));
  el('reload').addEventListener('click', () => activeId && bt.reload({ tabId: activeId }));
  el('new-tab').addEventListener('click', () => runShortcut('new-tab'));
  managed.addEventListener('click', () => setPanel(panel.hidden));
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape' && !panel.hidden) setPanel(false);
    else if (mod && event.key.toLowerCase() === 't') runShortcut('new-tab');
    else if (mod && event.key.toLowerCase() === 'l') runShortcut('focus-address');
    else if (mod && event.key.toLowerCase() === 'w') runShortcut('close-tab');
    else if (event.ctrlKey && event.key === 'Tab') cycle(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  });
  new ResizeObserver(sendBounds).observe(content);
  window.addEventListener('resize', sendBounds);

  // --- Start ----------------------------------------------------------------------------------------------------
  void desktop.vm.getInfo().then((info) => {
    if (info && info.ok) {
      if (typeof info.homeUrl === 'string') homeUrl = info.homeUrl;
      if (info.downloadsDirectory) el('downloads-dir').textContent = info.downloadsDirectory;
      el('version').textContent = `Lasco Desktop ${info.version}`;
    }
    sendBounds();
    // A tab may already exist (opened by the daemon or a link before this page was ready).
    if (order.length === 0) void openTab(homeUrl);
    else if (!activeId) void selectTab(order[0]);
  });
})();
