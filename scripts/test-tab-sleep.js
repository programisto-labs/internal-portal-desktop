'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSiteHost,
  normalizeTabSleepSettings,
  isNeverSleepSite,
  resolveTabSleepDelayMs,
  selectTabsToSleep,
  tabSleepBlocker,
  tabSleepCheckIntervalMs,
  PAGE_SLEEP_PROBE_SCRIPT,
} = require('../src/browser-tabs/tab-sleep');

const MIN = 60_000;
const NOW = 1_000 * MIN;
const tab = (tabId, extra = {}) => ({
  tabId,
  url: `https://${tabId}.example.com/`,
  hiddenSince: NOW - 31 * MIN,
  ...extra,
});
const options = (extra = {}) => ({ now: NOW, delayMs: 30 * MIN, activeTabId: 'shown', neverSites: [], ...extra });

describe('tab sleep: which tabs go to sleep', () => {
  it('puts to sleep the tabs hidden for longer than the delay, not the recent ones', () => {
    const tabs = [tab('old'), tab('recent', { hiddenSince: NOW - 29 * MIN }), tab('edge', { hiddenSince: NOW - 30 * MIN })];
    assert.deepEqual(selectTabsToSleep(tabs, options()), ['old', 'edge']);
  });

  it('never the shown tab, nor one that was never hidden', () => {
    const tabs = [tab('shown'), tab('fresh', { hiddenSince: null })];
    assert.deepEqual(selectTabsToSleep(tabs, options()), []);
    assert.equal(tabSleepBlocker(tabs[0], options()), 'active');
    assert.equal(tabSleepBlocker(tabs[1], options()), 'shown');
  });

  it('keeps awake audio, fullscreen, agent, popup, devtools, loading and media tabs', () => {
    const cases = {
      audible: 'audible',
      htmlFullscreen: 'fullscreen',
      agentControlled: 'agent',
      hasOpener: 'opener',
      devToolsOpened: 'devtools',
      loading: 'loading',
      capturingMedia: 'media',
    };
    for (const [flag, reason] of Object.entries(cases)) {
      const t = tab(flag, { [flag]: true });
      assert.equal(tabSleepBlocker(t, options()), reason, flag);
      assert.deepEqual(selectTabsToSleep([t], options()), [], flag);
    }
  });

  it('« Jamais » (0) disables everything', () => {
    assert.deepEqual(selectTabsToSleep([tab('a'), tab('b')], options({ delayMs: 0 })), []);
  });

  it('skips the sites of the « never » list, subdomains included', () => {
    const tabs = [
      tab('figma', { url: 'https://www.figma.com/file/x' }),
      tab('notfigma', { url: 'https://notfigma.com/' }),
      tab('local', { url: 'http://localhost:3001/a' }),
    ];
    assert.deepEqual(selectTabsToSleep(tabs, options({ neverSites: ['figma.com', 'localhost:3001'] })), ['notfigma']);
  });

  it('skips non-web pages and already sleeping tabs', () => {
    assert.equal(tabSleepBlocker(tab('blank', { url: 'about:blank' }), options()), 'not-web');
    assert.equal(tabSleepBlocker(tab('zz', { discarded: true }), options()), 'discarded');
  });
});

describe('tab sleep settings', () => {
  it('defaults to 30 min and an empty list', () => {
    assert.deepEqual(normalizeTabSleepSettings(null), {
      tabSleepMinutes: 30,
      tabSleepNeverSites: [],
      tabSleepMaxLive: 10,
      tabSleepPinned: false,
    });
    assert.equal(normalizeTabSleepSettings({ tabSleepMinutes: 7 }).tabSleepMinutes, 30);
    assert.equal(normalizeTabSleepSettings({ tabSleepMinutes: 0 }).tabSleepMinutes, 0);
    assert.equal(normalizeTabSleepSettings({ tabSleepMinutes: 120 }).tabSleepMinutes, 120);
  });

  it('normalizes and dedupes the never-sleep sites', () => {
    const { tabSleepNeverSites } = normalizeTabSleepSettings({
      tabSleepNeverSites: ['https://www.Figma.com/file/1', 'figma.com', '*.notion.so', 'javascript:alert(1)', '', 42],
    });
    assert.deepEqual(tabSleepNeverSites, ['figma.com', 'notion.so']);
    assert.equal(normalizeSiteHost('localhost:3001'), 'localhost:3001');
    assert.equal(normalizeSiteHost('file:///etc/passwd'), null);
    assert.equal(normalizeSiteHost('pas un site'), null);
  });

  it('matches exact hosts and subdomains only', () => {
    assert.equal(isNeverSleepSite('https://figma.com/', ['figma.com']), true);
    assert.equal(isNeverSleepSite('https://a.b.figma.com/', ['figma.com']), true);
    assert.equal(isNeverSleepSite('https://evilfigma.com/', ['figma.com']), false);
    assert.equal(isNeverSleepSite('not a url', ['figma.com']), false);
  });

  it('LASCO_TAB_SLEEP_MS overrides the delay (development)', () => {
    assert.equal(resolveTabSleepDelayMs({ tabSleepMinutes: 30 }, {}), 30 * MIN);
    assert.equal(resolveTabSleepDelayMs({ tabSleepMinutes: 0 }, {}), 0);
    assert.equal(resolveTabSleepDelayMs({ tabSleepMinutes: 30 }, { LASCO_TAB_SLEEP_MS: '20000' }), 20_000);
    assert.equal(resolveTabSleepDelayMs({}, { LASCO_TAB_SLEEP_MS: '10' }), 1000);
  });

  it('checks a quarter of the delay, between 1 s and 1 min', () => {
    assert.equal(tabSleepCheckIntervalMs(30 * MIN), 60_000);
    assert.equal(tabSleepCheckIntervalMs(20_000), 5_000);
    assert.equal(tabSleepCheckIntervalMs(1_000), 1_000);
  });

  it('the page probe is a self-invoking expression', () => {
    assert.match(PAGE_SLEEP_PROBE_SCRIPT, /^\(\(\) => \{/);
    assert.match(PAGE_SLEEP_PROBE_SCRIPT, /\}\)\(\)$/);
  });
});

describe('tab sleep: live budget (docs/many-tabs-perf.md)', () => {
  const {
    selectTabsOverLiveBudget,
    isMemoryPressure,
    DEFAULT_TAB_SLEEP_MAX_LIVE,
  } = require('../src/browser-tabs/tab-sleep');
  const hiddenFor = (tabId, minutes, extra = {}) => tab(tabId, { hiddenSince: NOW - minutes * MIN, ...extra });
  const budget = (extra = {}) => ({ now: NOW, maxLive: 3, activeTabId: 'shown', neverSites: [], ...extra });

  it('defaults to 10 live tabs and keeps the settings valid', () => {
    assert.equal(DEFAULT_TAB_SLEEP_MAX_LIVE, 10);
    assert.equal(normalizeTabSleepSettings({}).tabSleepMaxLive, 10);
    assert.equal(normalizeTabSleepSettings({ tabSleepMaxLive: 20 }).tabSleepMaxLive, 20);
    assert.equal(normalizeTabSleepSettings({ tabSleepMaxLive: 7 }).tabSleepMaxLive, 10);
    assert.equal(normalizeTabSleepSettings({ tabSleepMaxLive: 0 }).tabSleepMaxLive, 0);
    assert.equal(normalizeTabSleepSettings({}).tabSleepPinned, false);
    assert.equal(normalizeTabSleepSettings({ tabSleepPinned: true }).tabSleepPinned, true);
  });

  it('sleeps the oldest hidden tabs beyond the budget, not the recent ones', () => {
    const tabs = [hiddenFor('a', 10), hiddenFor('b', 9), hiddenFor('c', 8), hiddenFor('d', 7), hiddenFor('e', 6), tab('shown')];
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget()), ['a', 'b']);
  });

  it('does nothing within the budget, or without a limit', () => {
    const tabs = [hiddenFor('a', 10), hiddenFor('b', 9)];
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget()), []);
    const many = Array.from({ length: 30 }, (_, i) => hiddenFor(`t${i}`, 10 + i));
    assert.deepEqual(selectTabsOverLiveBudget(many, budget({ maxLive: 0 })), []);
  });

  it('keeps a tab left less than 2 minutes ago awake', () => {
    const tabs = [hiddenFor('a', 1), hiddenFor('b', 1.5), hiddenFor('c', 0.5), hiddenFor('d', 0.2)];
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget()), []);
  });

  it('exempt tabs count in the budget but never sleep: the next oldest goes instead', () => {
    const tabs = [
      hiddenFor('audio', 20, { audible: true }),
      hiddenFor('agent', 19, { agentControlled: true }),
      hiddenFor('pinned', 18, { pinned: true }),
      hiddenFor('call', 17, { capturingMedia: true }),
      hiddenFor('plain', 16),
      hiddenFor('recent', 5),
    ];
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget()), ['plain', 'recent']);
  });

  it('pinned tabs sleep when the person chose so', () => {
    const tabs = [hiddenFor('pinned', 20, { pinned: true }), hiddenFor('b', 10)];
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget({ maxLive: 1 })), ['b']);
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget({ maxLive: 1, sleepPinned: true })), ['pinned']);
    assert.equal(tabSleepBlocker(tabs[0], options({ delayMs: 10 * MIN })), 'pinned');
  });

  it('under memory pressure: budget of 3, tabs left 30 s ago', () => {
    const tabs = Array.from({ length: 6 }, (_, i) => hiddenFor(`t${i}`, 1 - i * 0.1));
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget({ maxLive: 10 })), []);
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget({ maxLive: 10, pressure: true })), ['t0', 't1', 't2']);
    assert.deepEqual(selectTabsOverLiveBudget(tabs, budget({ maxLive: 0, pressure: true })), ['t0', 't1', 't2']);
  });

  it('recognizes memory pressure from the system memory info (KB)', () => {
    const GB = 1024 * 1024;
    assert.equal(isMemoryPressure({ total: 16 * GB, free: 0.5 * GB }), true);
    assert.equal(isMemoryPressure({ total: 16 * GB, free: 4 * GB }), false);
    // 6 % libre mais 2 Go : pas de pression sur une grosse machine.
    assert.equal(isMemoryPressure({ total: 32 * GB, free: 2 * GB }), false);
    assert.equal(isMemoryPressure(null), false);
    assert.equal(isMemoryPressure({ total: 0, free: 0 }), false);
    // macOS : la mémoire « libre » seule est toujours basse ; le cache de fichiers se libère.
    assert.equal(isMemoryPressure({ total: 24 * GB, free: 0.6 * GB, fileBacked: 3 * GB, purgeable: 0 }), false);
    assert.equal(isMemoryPressure({ total: 24 * GB, free: 0.3 * GB, fileBacked: 0.5 * GB, purgeable: 0.1 * GB }), true);
  });
});

describe('perf metrics: aggregated snapshot, no personal data', () => {
  const { summarizeAppMetrics, processKind } = require('../src/perf-metrics');

  it('groups processes by kind and rounds to MB', () => {
    const snapshot = summarizeAppMetrics(
      [
        { type: 'Browser', memory: { workingSetSize: 200 * 1024 }, cpu: { percentCPUUsage: 1.24 } },
        { type: 'GPU', memory: { workingSetSize: 150 * 1024 }, cpu: { percentCPUUsage: 0.5 } },
        { type: 'Tab', memory: { workingSetSize: 100 * 1024 }, cpu: { percentCPUUsage: 2 } },
        { type: 'Tab', memory: { workingSetSize: 50 * 1024 + 300 }, cpu: { percentCPUUsage: 0 } },
        { type: 'Utility', memory: { workingSetSize: 20 * 1024 } },
      ],
      { webLive: 3, webSleeping: 12 },
    );
    assert.equal(snapshot.processes, 5);
    assert.equal(snapshot.memoryMb, 520);
    assert.equal(snapshot.cpuPercent, 3.7);
    assert.deepEqual(snapshot.byKind.renderer, { count: 2, memoryMb: 150, cpuPercent: 2 });
    assert.deepEqual(snapshot.tabs, { webLive: 3, webSleeping: 12 });
    assert.equal(processKind('Renderer'), 'renderer');
    assert.equal(processKind('Pepper Plugin'), 'other');
    // Aucun champ venu d'une page : ni nom, ni adresse, ni pid.
    assert.doesNotMatch(JSON.stringify(snapshot), /pid|name|url|title/);
  });

  it('survives an empty or odd list', () => {
    assert.equal(summarizeAppMetrics(null).processes, 0);
    assert.equal(summarizeAppMetrics([null, {}]).processes, 1);
  });
});
