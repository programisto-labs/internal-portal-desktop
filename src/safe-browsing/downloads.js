'use strict';

/**
 * Verdict Safe Browsing d'un téléchargement (docs/safe-browsing.md) : le fichier (redirections
 * comprises) et la page qui le propose. Le plus grave l'emporte.
 */

const PRIORITY = ['malware', 'phishing', 'unwanted'];

function worst(results) {
  const threats = results.filter((r) => r && r.verdict === 'dangerous').map((r) => r.threat);
  for (const threat of PRIORITY) if (threats.includes(threat)) return { verdict: 'dangerous', threat };
  return threats.length ? { verdict: 'dangerous', threat: threats[0] } : null;
}

function assessDownloadDanger(service, urls) {
  const list = [...new Set((urls || []).filter((u) => /^https?:\/\//i.test(String(u || ''))))];
  if (!service || !list.length) return { verdict: 'safe' };
  const first = list.map((url) => service.classify(url));
  const dangerous = worst(first);
  if (dangerous) return dangerous;
  const pending = list.filter((_url, i) => first[i].verdict === 'check');
  if (!pending.length) return { verdict: 'safe' };
  return {
    verdict: 'check',
    check: async () => worst(await Promise.all(pending.map((url) => service.check(url)))) || { verdict: 'safe' },
  };
}

module.exports = { assessDownloadDanger };
