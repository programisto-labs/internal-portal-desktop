'use strict';

/**
 * Browser shell of Lasco Desktop in VM mode (docs/vm-mode.md): tab strip and address bar over the native web
 * views of Desktop (`lascoDesktop.browserTabs`). No portal, no Lasco account: the VM never holds a Lasco session.
 *
 * Looks and behaves like the portal's internal browser (internal-portal-front: PortalBrowserTabBar,
 * PortalExternalBrowserToolbar, PortalOmnibox, PortalSiteInfoButton, PortalExternalBrowserMenu), so a person who
 * takes control of the VM recognises Lasco. Only the options that make sense in the VM are kept.
 */
(function vmShell() {
  const desktop = window.lascoDesktop;
  if (!desktop || !desktop.browserTabs || !desktop.vm) return;
  const bt = desktop.browserTabs;

  // --- Icons (lucide, same as the portal) ------------------------------------------------------------------------
  const ICONS = {
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    house:
      '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'triangle-alert':
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'shield-alert':
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-.97c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    printer:
      '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  for (const node of document.querySelectorAll('[data-icon]')) node.prepend(icon(node.getAttribute('data-icon')));

  // --- State ----------------------------------------------------------------------------------------------------
  /** @type {Map<string, { url: string, title: string, favicon: string | null, loading: boolean, security: string | null, canGoBack: boolean, canGoForward: boolean, zoomFactor: number, audible: boolean, muted: boolean }>} */
  const tabs = new Map();
  const order = [];
  /** @type {Map<string, HTMLElement>} */
  const tabNodes = new Map();
  let activeId = null;
  let homeUrl = 'https://www.google.com/';
  let seq = 0;

  const el = (id) => document.getElementById(id);
  const tabsEl = el('tabs');
  const address = el('address');
  const content = el('content');
  const freeze = el('freeze');
  const menu = el('menu');
  const menuButton = el('menu-button');
  const sitePanel = el('site-panel');
  const siteButton = el('site-info');
  const suggestionsEl = el('suggestions');
  const findBar = el('find-bar');
  const findInput = el('find-input');

  function newTabId() {
    seq += 1;
    return `shell-${Date.now().toString(36)}-${seq}`;
  }

  /** Same rule as the portal's omnibox (resolveOmniboxInput): an address, else a Google search. */
  function resolveInput(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|\d{1,3}(\.\d{1,3}){3})/i.test(text) && !/\s/.test(text)) return `http://${text}`;
    if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
    return searchUrl(text);
  }

  function searchUrl(text) {
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }

  /** The address shows the domain until it is focused (collapseToDomain). */
  function displayDomain(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) return url;
      const defaultPort = (parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80');
      return parsed.hostname + (parsed.port && !defaultPort ? `:${parsed.port}` : '');
    } catch {
      return url;
    }
  }

  function safeImage(src) {
    return typeof src === 'string' && /^(https?:|data:image\/)/i.test(src) ? src : null;
  }

  function sendBounds() {
    const rect = content.getBoundingClientRect();
    void bt.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }

  function ensureTab(tabId, url, { afterId } = {}) {
    if (!tabs.has(tabId)) {
      tabs.set(tabId, {
        url: url || '',
        title: url || 'Nouvel onglet',
        favicon: null,
        loading: true,
        security: null,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        audible: false,
        muted: false,
      });
      const after = afterId ? order.indexOf(afterId) : -1;
      if (after >= 0) order.splice(after + 1, 0, tabId);
      else order.push(tabId);
    }
    return tabs.get(tabId);
  }

  // --- View suspension (an HTML menu cannot be drawn over the native page) ----------------------------------------
  // Like the portal: freeze the page in an image, hide the native view while the menu is open.
  const suspendReasons = new Set();
  let suspendToken = 0;

  async function suspendView(reason) {
    const first = suspendReasons.size === 0;
    suspendReasons.add(reason);
    if (!first) return;
    const token = ++suspendToken;
    if (activeId) {
      const shot = await bt.capture({ tabId: activeId, quality: 70 }).catch(() => null);
      if (token !== suspendToken || !suspendReasons.size) return;
      if (shot && shot.ok && typeof shot.dataUrl === 'string') {
        freeze.src = shot.dataUrl;
        freeze.hidden = false;
      }
    }
    if (token !== suspendToken || !suspendReasons.size) return;
    await bt.setOverlay({ active: true });
  }

  function resumeView(reason) {
    if (!suspendReasons.delete(reason) || suspendReasons.size) return;
    suspendToken += 1;
    void bt.setOverlay({ active: false });
    freeze.hidden = true;
    freeze.removeAttribute('src');
  }

  // --- Tab strip ------------------------------------------------------------------------------------------------
  function tabLabel(tab) {
    return (tab.title || '').trim() || tab.url || 'Nouvel onglet';
  }

  function buildTabNode(tabId) {
    const node = document.createElement('div');
    node.className = 'tab';
    node.setAttribute('role', 'tab');
    node.dataset.tabId = tabId;
    const iconWrap = document.createElement('span');
    iconWrap.className = 'tab-icon';
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.append(document.createElement('span'));
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.append(icon('x'));
    close.addEventListener('pointerdown', (event) => event.stopPropagation());
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tabId);
    });
    node.append(iconWrap, title, close);
    node.addEventListener('pointerdown', (event) => onTabPointerDown(event, tabId, node));
    // Clic molette : ferme l'onglet, comme Chrome.
    node.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    node.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      closeTab(tabId);
    });
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showTabMenu(tabId, event.clientX, event.clientY);
    });
    return node;
  }

  function renderTabs() {
    for (const [tabId, node] of tabNodes) {
      if (!tabs.has(tabId)) {
        node.remove();
        tabNodes.delete(tabId);
      }
    }
    order.forEach((tabId, index) => {
      const tab = tabs.get(tabId);
      if (!tab) return;
      let node = tabNodes.get(tabId);
      if (!node) {
        node = buildTabNode(tabId);
        tabNodes.set(tabId, node);
      }
      if (tabsEl.children[index] !== node) tabsEl.insertBefore(node, tabsEl.children[index] || null);
      const active = tabId === activeId;
      const previous = index > 0 ? order[index - 1] : null;
      node.classList.toggle('active', active);
      // Séparateur entre deux onglets non sélectionnés (pas à côté de l'actif).
      node.classList.toggle('separated', Boolean(previous) && !active && previous !== activeId);
      node.setAttribute('aria-selected', String(active));
      const label = tabLabel(tab);
      node.title = label;
      const iconWrap = node.querySelector('.tab-icon');
      const favicon = safeImage(tab.favicon);
      const iconKey = tab.loading ? 'loading' : favicon || 'globe';
      if (iconWrap.dataset.key !== iconKey) {
        iconWrap.dataset.key = iconKey;
        iconWrap.textContent = '';
        if (tab.loading) {
          const spinner = document.createElement('span');
          spinner.className = 'tab-spinner';
          iconWrap.append(spinner);
        } else if (favicon) {
          const img = document.createElement('img');
          img.src = favicon;
          img.alt = '';
          img.addEventListener('error', () => {
            iconWrap.dataset.key = 'globe';
            iconWrap.textContent = '';
            iconWrap.append(icon('globe'));
          });
          iconWrap.append(img);
        } else {
          iconWrap.append(icon('globe'));
        }
      }
      node.querySelector('.tab-title span').textContent = label;
      node.querySelector('.tab-close').setAttribute('aria-label', `Fermer ${label}`);
    });
  }

  // Glisser pour réordonner (axe horizontal seul), comme la barre d'onglets du portail.
  let drag = null;

  function onTabPointerDown(event, tabId, node) {
    if (event.button !== 0) return;
    // Comme Chrome : l'onglet est sélectionné à l'appui.
    if (tabId !== activeId) void selectTab(tabId);
    drag = { tabId, node, startX: event.clientX, originLeft: node.offsetLeft, moved: false, pointerId: event.pointerId };
    node.setPointerCapture(event.pointerId);
  }

  function onTabPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 5) return;
    drag.moved = true;
    const { node, tabId } = drag;
    node.classList.add('dragging');
    const center = drag.originLeft + dx + node.offsetWidth / 2;
    let target = 0;
    for (const other of order) {
      if (other === tabId) continue;
      const otherNode = tabNodes.get(other);
      if (otherNode && otherNode.offsetLeft + otherNode.offsetWidth / 2 < center) target += 1;
    }
    const current = order.indexOf(tabId);
    if (current !== target) {
      order.splice(current, 1);
      order.splice(target, 0, tabId);
      renderTabs();
    }
    const lastNode = tabNodes.get(order[order.length - 1]);
    const maxLeft = lastNode ? lastNode.offsetLeft : 0;
    const left = Math.min(Math.max(drag.originLeft + dx, 0), Math.max(maxLeft, 0));
    node.style.transform = `translateX(${left - node.offsetLeft}px)`;
  }

  function onTabPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.node.classList.remove('dragging');
    drag.node.style.transform = '';
    drag = null;
    renderTabs();
  }

  // « + » juste après le dernier onglet, dans la même rangée (il ne rétrécit jamais).
  tabsEl.append(el('new-tab-wrap'));

  tabsEl.addEventListener('pointermove', onTabPointerMove);
  tabsEl.addEventListener('pointerup', onTabPointerUp);
  tabsEl.addEventListener('pointercancel', onTabPointerUp);

  // Menu contextuel natif (tab-menu.js) : dessiné au-dessus de la page, jamais rogné.
  function showTabMenu(tabId, x, y) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const actions = ['reload', 'duplicate'];
    if (tab.muted) actions.push('unmute');
    else if (tab.audible) actions.push('mute');
    actions.push('close', 'close-others', 'close-right');
    void bt.showTabContextMenu({ tabId, actions, tabCount: order.length, tabIndex: order.indexOf(tabId), x, y });
  }

  bt.onTabContextMenuAction((payload) => {
    if (!payload || !tabs.has(payload.tabId)) return;
    const { tabId, action } = payload;
    const tab = tabs.get(tabId);
    if (action === 'reload') void bt.reload({ tabId });
    else if (action === 'duplicate') void openTab(tab.url, { afterId: tabId });
    else if (action === 'mute' || action === 'unmute') void bt.setMuted({ tabId, muted: action === 'mute' });
    else if (action === 'close') closeTab(tabId);
    else if (action === 'close-others') {
      for (const other of [...order]) if (other !== tabId) closeTab(other);
      void selectTab(tabId);
    } else if (action === 'close-right') {
      for (const other of order.slice(order.indexOf(tabId) + 1)) closeTab(other);
    }
  });

  // --- Toolbar --------------------------------------------------------------------------------------------------
  const SECURITY = {
    secure: { icon: 'lock', tone: 'secure', badge: null, title: 'La connexion est sécurisée', description: 'Les informations que vous envoyez à ce site (mots de passe, cartes bancaires) restent privées.' },
    local: { icon: 'house', tone: 'local', badge: null, title: 'Page de cet ordinateur', description: "Cette page est servie par l'ordinateur Lasco, elle n'a pas besoin de connexion chiffrée." },
    insecure: { icon: 'triangle-alert', tone: 'warning', badge: 'Non sécurisé', title: "La connexion à ce site n'est pas sécurisée", description: "N'y saisissez aucune information sensible (mot de passe, carte bancaire) : elle pourrait être lue par un tiers." },
    dangerous: { icon: 'shield-alert', tone: 'danger', badge: 'Non sécurisé', title: "Le certificat de ce site n'est pas valide", description: "Lasco n'a pas ouvert la page : quelqu'un pourrait tenter d'intercepter vos informations." },
  };

  let addressFocused = false;

  function renderToolbar() {
    const active = activeId ? tabs.get(activeId) : null;
    el('back').disabled = !active || !active.canGoBack;
    el('forward').disabled = !active || !active.canGoForward;
    const reload = el('reload');
    const stopping = Boolean(active && active.loading);
    reload.disabled = !active;
    if (reload.dataset.mode !== (stopping ? 'stop' : 'reload')) {
      reload.dataset.mode = stopping ? 'stop' : 'reload';
      reload.textContent = '';
      reload.append(icon(stopping ? 'x' : 'rotate-cw'));
      reload.title = stopping ? 'Arrêter' : 'Actualiser';
      reload.setAttribute('aria-label', reload.title);
    }
    el('loading-bar').hidden = !stopping;

    const security = active && SECURITY[active.security];
    siteButton.hidden = !security;
    if (security && siteButton.dataset.key !== active.security) {
      siteButton.dataset.key = active.security;
      siteButton.textContent = '';
      siteButton.append(icon(security.icon));
      if (security.badge) {
        const badge = document.createElement('span');
        badge.textContent = security.badge;
        siteButton.append(badge);
      }
      siteButton.title = security.title;
      siteButton.classList.toggle('danger', security.tone === 'danger');
    }

    const addressIcon = el('address-icon');
    const favicon = active ? safeImage(active.favicon) : null;
    const iconKey = favicon || 'globe';
    if (addressIcon.dataset.key !== iconKey) {
      addressIcon.dataset.key = iconKey;
      addressIcon.textContent = '';
      if (favicon) {
        const img = document.createElement('img');
        img.src = favicon;
        img.alt = '';
        addressIcon.append(img);
      } else {
        addressIcon.append(icon('globe'));
      }
    }
    if (!addressFocused) address.value = active ? displayDomain(active.url) : '';

    const zoom = active ? active.zoomFactor : 1;
    const zoomText = `${Math.round((zoom || 1) * 100)} %`;
    const badge = el('zoom-badge');
    badge.hidden = !active || Math.abs((zoom || 1) - 1) < 0.001;
    badge.textContent = zoomText;
    el('zoom-value').textContent = zoomText;
    document.title = active ? `${tabLabel(active)} — Lasco` : 'Lasco';
  }

  function render() {
    renderTabs();
    renderToolbar();
  }

  // --- Tabs -----------------------------------------------------------------------------------------------------
  async function selectTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeId = tabId;
    closeFloating();
    sendBounds();
    render();
    await bt.select({ tabId });
  }

  async function openTab(url, { background = false, afterId } = {}) {
    const safe = resolveInput(url) || homeUrl;
    const tabId = newTabId();
    ensureTab(tabId, safe, { afterId });
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

  function focusAddress() {
    if (document.body.dataset.view === 'page') return;
    address.focus();
    address.select();
  }

  function runShortcut(action) {
    if (action === 'new-tab') {
      void openTab(homeUrl).then(() => focusAddress());
    } else if (action === 'focus-address') focusAddress();
    else if (action === 'find') openFind();
    else if (action === 'find-next') findStep(true);
    else if (action === 'find-previous') findStep(false);
    else if (action === 'close-tab') {
      if (activeId) closeTab(activeId);
    } else if (action === 'next-tab') cycle(1);
    else if (action === 'previous-tab') cycle(-1);
    else if (action === 'select-last-tab' && order.length) void selectTab(order[order.length - 1]);
    else if (typeof action === 'string' && action.startsWith('select-tab-')) {
      const target = order[Number(action.slice('select-tab-'.length)) - 1];
      if (target) void selectTab(target);
    }
  }

  // --- Floating surfaces (menu, site info, suggestions) -----------------------------------------------------------
  function place(panel, anchor, align) {
    const rect = anchor.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    if (align === 'end') {
      panel.style.left = '';
      panel.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
    } else {
      panel.style.right = '';
      panel.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    }
  }

  async function openMenu() {
    closeSitePanel();
    menuButton.setAttribute('aria-expanded', 'true');
    await suspendView('menu');
    if (menuButton.getAttribute('aria-expanded') !== 'true') return;
    menu.hidden = false;
    place(menu, menuButton, 'end');
    const first = menu.querySelector('.menu-item');
    if (first) first.focus();
  }

  function closeMenu() {
    if (menuButton.getAttribute('aria-expanded') !== 'true') return;
    menuButton.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    resumeView('menu');
  }

  let siteChanged = false;

  function renderSitePanel(info) {
    const active = activeId ? tabs.get(activeId) : null;
    const security = SECURITY[(info && info.security) || (active && active.security)] || SECURITY.secure;
    const head = el('site-panel-icon');
    head.textContent = '';
    head.append(icon(security.icon));
    head.classList.toggle('danger', security.tone === 'danger');
    el('site-host').textContent = (info && info.host) || '';
    el('site-host').hidden = !(info && info.host);
    el('site-title').textContent = security.title;
    el('site-title').classList.toggle('danger', security.tone === 'danger');
    el('site-description').textContent = security.description;
    const permissions = (info && Array.isArray(info.permissions) && info.permissions) || [];
    const list = el('site-permissions');
    list.textContent = '';
    for (const item of permissions) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = PERMISSION_LABELS[item.permission] || item.permission;
      const select = document.createElement('select');
      select.setAttribute('aria-label', label.textContent);
      for (const [value, text] of [['allow', 'Autoriser'], ['block', 'Bloquer'], ['ask', 'Demander']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
      }
      select.value = item.decision === 'allow' || item.decision === 'block' ? item.decision : 'ask';
      select.addEventListener('change', () => {
        const decision = select.value === 'ask' ? null : select.value;
        void bt.setSitePermission({ tabId: activeId, permission: item.permission, decision }).then(applySiteResult);
      });
      row.append(label, select);
      list.append(row);
    }
    el('site-empty').hidden = permissions.length > 0;
    el('site-reset').hidden = permissions.length === 0;
    el('site-changed').hidden = !siteChanged;
  }

  function applySiteResult(result) {
    if (!result || !result.ok) return;
    siteChanged = true;
    renderSitePanel(result);
  }

  const PERMISSION_LABELS = {
    microphone: 'Micro',
    camera: 'Caméra',
    geolocation: 'Position',
    notifications: 'Notifications',
    'clipboard-read': 'Lecture du presse-papiers',
    midi: 'Appareils MIDI',
    midiSysex: 'Contrôle des appareils MIDI',
    'idle-detection': "Détection d'inactivité",
    'window-management': 'Gestion des fenêtres',
    fileSystem: 'Modification de fichiers',
  };

  async function openSitePanel() {
    if (!activeId) return;
    closeMenu();
    siteChanged = false;
    siteButton.setAttribute('aria-expanded', 'true');
    const load = bt.siteInfo({ tabId: activeId }).catch(() => null);
    await suspendView('site');
    const info = await load;
    if (siteButton.getAttribute('aria-expanded') !== 'true') return;
    renderSitePanel(info && info.ok ? info : null);
    sitePanel.hidden = false;
    place(sitePanel, siteButton, 'start');
  }

  function closeSitePanel() {
    if (siteButton.getAttribute('aria-expanded') !== 'true') return;
    siteButton.setAttribute('aria-expanded', 'false');
    sitePanel.hidden = true;
    resumeView('site');
  }

  function closeFloating() {
    closeMenu();
    closeSitePanel();
    closeSuggestions();
  }

  // --- Omnibox --------------------------------------------------------------------------------------------------
  let suggestions = [];
  let suggestionIndex = -1;
  let suggestionQuery = '';
  let suggestTimer = 0;
  let suggestSeq = 0;

  function highlight(parent, text, query) {
    const needle = query.trim().toLowerCase();
    const lower = text.toLowerCase();
    let from = 0;
    if (needle) {
      let at = lower.indexOf(needle);
      while (at >= 0) {
        if (at > from) parent.append(text.slice(from, at));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(at, at + needle.length);
        parent.append(mark);
        from = at + needle.length;
        at = lower.indexOf(needle, from);
      }
    }
    parent.append(text.slice(from));
  }

  function renderSuggestions() {
    suggestionsEl.textContent = '';
    const rows = [...suggestions.map((entry) => ({ kind: 'history', entry })), { kind: 'search' }];
    rows.forEach((row, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === suggestionIndex));
      if (row.kind === 'history') {
        const favicon = safeImage(row.entry.favicon);
        if (favicon) {
          const img = document.createElement('img');
          img.src = favicon;
          img.alt = '';
          item.append(img);
        } else item.append(icon('globe'));
        const title = document.createElement('span');
        title.className = 'suggestion-title';
        highlight(title, row.entry.title || row.entry.url, suggestionQuery);
        const url = document.createElement('span');
        url.className = 'suggestion-url';
        highlight(url, row.entry.url, suggestionQuery);
        item.append(title, url);
      } else {
        item.append(icon('search'));
        const label = document.createElement('span');
        label.className = 'suggestion-title';
        label.textContent = `Rechercher « ${suggestionQuery} »`;
        item.append(label);
      }
      item.addEventListener('mouseenter', () => {
        suggestionIndex = index;
        for (const [i, child] of [...suggestionsEl.children].entries()) child.setAttribute('aria-selected', String(i === index));
      });
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => pickSuggestion(index));
      suggestionsEl.append(item);
    });
  }

  function openSuggestions() {
    if (!suggestionsEl.hidden) {
      renderSuggestions();
      return;
    }
    address.setAttribute('aria-expanded', 'true');
    renderSuggestions();
    void suspendView('suggestions').then(() => {
      if (address.getAttribute('aria-expanded') !== 'true') return;
      const rect = address.getBoundingClientRect();
      suggestionsEl.style.left = `${Math.round(rect.left)}px`;
      suggestionsEl.style.top = `${Math.round(rect.bottom + 4)}px`;
      suggestionsEl.style.width = `${Math.round(rect.width)}px`;
      suggestionsEl.hidden = false;
    });
  }

  function closeSuggestions() {
    clearTimeout(suggestTimer);
    suggestSeq += 1;
    suggestions = [];
    suggestionIndex = -1;
    if (address.getAttribute('aria-expanded') !== 'true') return;
    address.setAttribute('aria-expanded', 'false');
    suggestionsEl.hidden = true;
    resumeView('suggestions');
  }

  function querySuggestions() {
    clearTimeout(suggestTimer);
    const query = address.value.trim();
    if (!query) {
      closeSuggestions();
      return;
    }
    const mySeq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      const result = await bt.historySuggest({ query, limit: 8 }).catch(() => null);
      if (mySeq !== suggestSeq || !addressFocused) return;
      suggestions = result && result.ok && Array.isArray(result.items) ? result.items.filter((item) => item && typeof item.url === 'string') : [];
      suggestionQuery = query;
      suggestionIndex = -1;
      openSuggestions();
    }, 80);
  }

  function navigateTo(url) {
    address.blur();
    closeSuggestions();
    if (activeId) {
      const tab = tabs.get(activeId);
      if (tab) {
        tab.url = url;
        tab.loading = true;
      }
      render();
      void bt.navigate({ tabId: activeId, url });
    } else void openTab(url);
  }

  function pickSuggestion(index) {
    const picked = suggestions[index];
    navigateTo(picked ? picked.url : searchUrl(suggestionQuery));
  }

  el('omnibox').addEventListener('submit', (event) => {
    event.preventDefault();
    if (suggestionIndex >= 0 && address.getAttribute('aria-expanded') === 'true') {
      pickSuggestion(suggestionIndex);
      return;
    }
    const url = resolveInput(address.value);
    if (url) navigateTo(url);
  });
  address.addEventListener('focus', () => {
    addressFocused = true;
    const active = activeId ? tabs.get(activeId) : null;
    // Le champ passe du domaine à l'adresse complète, sélectionnée.
    const full = active ? active.url : '';
    address.value = full;
    address.select();
    // Le clic place le curseur après l'événement focus : resélectionner, sauf si la frappe a déjà commencé.
    requestAnimationFrame(() => {
      if (address.value === full) address.select();
    });
  });
  address.addEventListener('blur', () => {
    addressFocused = false;
    closeSuggestions();
    renderToolbar();
  });
  address.addEventListener('input', querySuggestions);
  address.addEventListener('keydown', (event) => {
    const open = address.getAttribute('aria-expanded') === 'true';
    const count = suggestions.length + 1;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (open) closeSuggestions();
      else address.blur();
    } else if (open && event.key === 'ArrowDown') {
      event.preventDefault();
      suggestionIndex = (suggestionIndex + 1) % count;
      renderSuggestions();
    } else if (open && event.key === 'ArrowUp') {
      event.preventDefault();
      suggestionIndex = suggestionIndex <= 0 ? count - 1 : suggestionIndex - 1;
      renderSuggestions();
    }
  });

  // --- Find in page ---------------------------------------------------------------------------------------------
  let findTabId = null;

  function openFind() {
    if (!activeId) return;
    findTabId = activeId;
    findBar.hidden = false;
    requestAnimationFrame(sendBounds);
    findInput.focus();
    findInput.select();
    if (findInput.value) findStep(true, true);
  }

  function closeFind() {
    if (findBar.hidden) return;
    if (findTabId) void bt.stopFindInPage({ tabId: findTabId });
    findBar.hidden = true;
    findTabId = null;
    el('find-count').textContent = '';
    requestAnimationFrame(sendBounds);
  }

  function findStep(forward, newSession = false) {
    if (findBar.hidden || !findTabId) return;
    const text = findInput.value;
    if (!text) {
      void bt.stopFindInPage({ tabId: findTabId });
      el('find-count').textContent = '';
      return;
    }
    void bt.findInPage({ tabId: findTabId, text, forward, newSession });
  }

  findInput.addEventListener('input', () => findStep(true, true));
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findStep(!event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  el('find-next').addEventListener('click', () => findStep(true));
  el('find-previous').addEventListener('click', () => findStep(false));
  el('find-close').addEventListener('click', closeFind);
  bt.onFindResult((result) => {
    if (!result || result.tabId !== findTabId || findBar.hidden) return;
    el('find-count').textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : '0/0';
  });

  // --- Menu actions ---------------------------------------------------------------------------------------------
  menu.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action.startsWith('zoom-')) {
      if (activeId) void bt.zoom({ tabId: activeId, direction: action.slice(5) });
      return;
    }
    closeMenu();
    if (action === 'new-tab') runShortcut('new-tab');
    else if (action === 'find') openFind();
    else if (action === 'print' && activeId) void bt.print({ tabId: activeId });
    else if (action === 'copy-link' && activeId) {
      const tab = tabs.get(activeId);
      if (tab && tab.url) void navigator.clipboard.writeText(tab.url).catch(() => undefined);
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('.menu-item')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
    items[next].focus();
  });

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
    tab.zoomFactor = typeof state.zoomFactor === 'number' ? state.zoomFactor : 1;
    tab.audible = Boolean(state.audible);
    tab.muted = Boolean(state.muted);
    render();
  });
  // Pop-ups and « open in a new tab » of the pages, links handed to Desktop, the browser daemon's `open`.
  bt.onOpenRequest(
    (request) => {
      if (!request || typeof request.url !== 'string') return;
      const background = request.disposition === 'background-tab';
      // Comme Chrome : à droite de l'onglet d'origine.
      const afterId = typeof request.openerTabId === 'string' ? request.openerTabId : activeId;
      if (typeof request.adoptedTabId === 'string') {
        ensureTab(request.adoptedTabId, request.url, { afterId });
        if (!background) void selectTab(request.adoptedTabId);
        else render();
        return;
      }
      void openTab(request.url, { background, afterId });
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
  el('back').addEventListener('click', () => activeId && bt.goBack({ tabId: activeId }));
  el('forward').addEventListener('click', () => activeId && bt.goForward({ tabId: activeId }));
  el('reload').addEventListener('click', () => {
    if (!activeId) return;
    const tab = tabs.get(activeId);
    if (tab && tab.loading) void bt.stop({ tabId: activeId });
    else void bt.reload({ tabId: activeId });
  });
  el('new-tab').addEventListener('click', () => runShortcut('new-tab'));
  el('zoom-badge').addEventListener('click', () => activeId && bt.zoom({ tabId: activeId, direction: 'reset' }));
  menuButton.addEventListener('click', () => {
    if (menuButton.getAttribute('aria-expanded') === 'true') closeMenu();
    else void openMenu();
  });
  siteButton.addEventListener('click', () => {
    if (siteButton.getAttribute('aria-expanded') === 'true') closeSitePanel();
    else void openSitePanel();
  });
  el('site-reset').addEventListener('click', () => {
    if (activeId) void bt.resetSitePermissions({ tabId: activeId }).then(applySiteResult);
  });
  el('site-reload').addEventListener('click', () => {
    closeSitePanel();
    if (activeId) void bt.reload({ tabId: activeId });
  });
  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (!menu.hidden && !menu.contains(target) && !menuButton.contains(target)) closeMenu();
    if (!sitePanel.hidden && !sitePanel.contains(target) && !siteButton.contains(target)) closeSitePanel();
  });
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape' && (!menu.hidden || !sitePanel.hidden)) {
      closeMenu();
      closeSitePanel();
    } else if (mod && key === 't') runShortcut('new-tab');
    else if (mod && key === 'l') runShortcut('focus-address');
    else if (mod && key === 'w') runShortcut('close-tab');
    else if (mod && key === 'f') openFind();
    else if (mod && key === 'r' && activeId) void bt.reload({ tabId: activeId });
    else if (event.ctrlKey && event.key === 'Tab') cycle(event.shiftKey ? -1 : 1);
    else if (mod && /^[1-9]$/.test(event.key)) runShortcut(event.key === '9' ? 'select-last-tab' : `select-tab-${event.key}`);
    else return;
    event.preventDefault();
  });
  new ResizeObserver(sendBounds).observe(content);
  window.addEventListener('resize', () => {
    closeFloating();
    sendBounds();
  });

  // --- Vue page / vue ordinateur ---------------------------------------------------------------------------------
  // Page : la page active seule, en plein écran (Desktop passe la fenêtre en plein écran). Ordinateur : tout le
  // navigateur. Choisi depuis la vue en direct du portail, par le point de contrôle (`POST /v1/view`).
  function setViewMode(mode) {
    const next = mode === 'desktop' ? 'desktop' : 'page';
    if (document.body.dataset.view === next) return;
    document.body.dataset.view = next;
    closeFloating();
    if (next === 'page' && document.activeElement === address) address.blur();
    requestAnimationFrame(sendBounds);
  }
  if (typeof desktop.vm.onViewMode === 'function') desktop.vm.onViewMode((payload) => payload && setViewMode(payload.mode));

  // --- Start ----------------------------------------------------------------------------------------------------
  render();
  void desktop.vm.getInfo().then((info) => {
    if (info && info.ok) {
      if (typeof info.viewMode === 'string') setViewMode(info.viewMode);
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
