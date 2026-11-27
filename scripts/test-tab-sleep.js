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
    assert.deepEqual(normalizeTabSleepSettings(null), { tabSleepMinutes: 30, tabSleepNeverSites: [] });
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
