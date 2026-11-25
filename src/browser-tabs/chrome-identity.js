'use strict';

/**
 * Makes an external browser tab present itself exactly like desktop Google Chrome.
 *
 * Electron is an unbranded Chromium: even with a Chrome user agent string, it
 * announces `navigator.userAgentData.brands = [Chromium, Not?A_Brand]` (no
 * "Google Chrome"), sends no `Sec-CH-UA` request headers and exposes an empty
 * `window.chrome`. Google sign-in reads these signals and refuses the browser
 * ("This browser or app may not be secure"). We align all three with Chrome:
 *  - brands / platform metadata through CDP `Emulation.setUserAgentOverride`
 *    (only way to change `navigator.userAgentData`, kept across navigations);
 *  - `Sec-CH-UA*` headers on HTTPS requests of the browser session;
 *  - the `window.chrome` properties Chrome defines on every page.
 */

const NOT_A_BRAND = { brand: 'Not?A_Brand', version: '24' };

const PLATFORMS = {
  darwin: { platform: 'macOS', navigatorPlatform: 'MacIntel', architecture: 'arm', platformVersion: '15.0.0' },
  win32: { platform: 'Windows', navigatorPlatform: 'Win32', architecture: 'x86', platformVersion: '19.0.0' },
  linux: { platform: 'Linux', navigatorPlatform: 'Linux x86_64', architecture: 'x86', platformVersion: '6.0.0' },
};

/**
 * Version du système telle que Chromium la calcule (`Sec-CH-UA-Platform-Version`).
 * Jamais une valeur figée : les protections anti-robots (Akamai : L'Équipe…) comparent cette
 * valeur aux autres signaux et refusent la session si elle ne colle pas (« Access Denied »).
 * macOS : version du produit (`15.8.3`) ; Linux : noyau ; Windows : valeur par défaut gardée.
 */
function realPlatformVersion(platform, fallback, getSystemVersion = process.getSystemVersion, osRelease) {
  let raw = '';
  try {
    if (platform === 'darwin' && typeof getSystemVersion === 'function') raw = String(getSystemVersion() || '');
    if (platform === 'linux') raw = String((osRelease || require('os').release)() || '').split('-')[0];
  } catch (_) {
    raw = '';
  }
  const parts = raw.split('.').filter((part) => /^\d+$/.test(part));
  if (parts.length === 0) return fallback;
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

function platformInfo(platform = process.platform, arch = process.arch, getSystemVersion, osRelease) {
  const info = { ...(PLATFORMS[platform] || PLATFORMS.linux) };
  info.architecture = arch === 'arm64' ? 'arm' : 'x86';
  info.platformVersion = realPlatformVersion(platform, info.platformVersion, getSystemVersion, osRelease);
  return info;
}

function buildChromeBrands(chromeVersion = process.versions.chrome) {
  const major = String(chromeVersion || '').split('.')[0] || '0';
  return [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, NOT_A_BRAND];
}

function buildUserAgentMetadata(chromeVersion = process.versions.chrome, platform, arch) {
  const full = String(chromeVersion || '0.0.0.0');
  const brands = buildChromeBrands(full);
  const info = platformInfo(platform, arch);
  return {
    brands,
    fullVersionList: brands.map((b) => ({ brand: b.brand, version: b === NOT_A_BRAND ? '24.0.0.0' : full })),
    fullVersion: full,
    platform: info.platform,
    platformVersion: info.platformVersion,
    architecture: info.architecture,
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

/** `"Google Chrome";v="152", "Chromium";v="152", "Not?A_Brand";v="24"` */
function formatBrandsHeader(brands) {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

function buildClientHintHeaders(chromeVersion = process.versions.chrome, platform, arch) {
  const meta = buildUserAgentMetadata(chromeVersion, platform, arch);
  return {
    'sec-ch-ua': formatBrandsHeader(meta.brands),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${meta.platform}"`,
  };
}

/** Same `window.chrome` surface Chrome exposes to web pages (no extension APIs). */
const CHROME_OBJECT_SCRIPT = `(() => {
  try {
    const c = window.chrome || {};
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails() { return null; },
        getIsInstalled() { return false; },
        runningState() { return 'cannot_run'; },
      };
    }
    if (!c.csi) {
      const start = performance.timeOrigin || Date.now();
      c.csi = function csi() {
        return { startE: start, onloadT: start + performance.now(), pageT: performance.now(), tran: 15 };
      };
    }
    if (!c.loadTimes) {
      c.loadTimes = function loadTimes() {
        const t = (performance.timeOrigin || Date.now()) / 1000;
        return {
          requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t, finishLoadTime: t,
          firstPaintTime: t, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true,
          wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
        };
      };
    }
    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: c, writable: true, configurable: true });
  } catch (_) {}
})();`;

/**
 * Electron has no passkey UI (Chrome's account picker, phone QR code, security
 * key prompt) and no access to iCloud Keychain passkeys: a WebAuthn request
 * waits forever with nothing on screen. Answer like a browser without any
 * authenticator so sites (Google « Verifying it's you… ») switch to another
 * method at once. Conditional (autofill) requests stay pending until aborted.
 */
const PASSKEY_FALLBACK_SCRIPT = `(() => {
  try {
    const creds = navigator.credentials;
    if (!creds || creds.__lascoPasskeyFallback) return;
    const notAllowed = () =>
      new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
    const wrap = (original) =>
      function (options) {
        if (!options || !options.publicKey) return original.apply(this, arguments);
        if (options.mediation === 'conditional') {
          return new Promise((_resolve, reject) => {
            const signal = options.signal;
            if (signal) signal.addEventListener('abort', () => reject(signal.reason || notAllowed()), { once: true });
          });
        }
        return Promise.reject(notAllowed());
      };
    const get = creds.get, create = creds.create;
    Object.defineProperty(creds, 'get', { value: wrap(get), configurable: true, writable: true });
    Object.defineProperty(creds, 'create', { value: wrap(create), configurable: true, writable: true });
    Object.defineProperty(creds, '__lascoPasskeyFallback', { value: true });
    const PKC = window.PublicKeyCredential;
    if (PKC) {
      PKC.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
    }
  } catch (_) {}
})();`;

/** Adds `Sec-CH-UA*` to every HTTPS request of the browser session (Chrome never sends them over plain HTTP). */
function installClientHintHeaders(browserSession) {
  const headers = buildClientHintHeaders();
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const [name, value] of Object.entries(headers)) {
      const present = Object.keys(requestHeaders).some((key) => key.toLowerCase() === name);
      if (!present) requestHeaders[name] = value;
    }
    callback({ requestHeaders });
  });
}

/**
 * Attaches the Chrome identity to a tab. Must run once the tab has a live
 * renderer (attaching before the first navigation closes the CDP target), so
 * the caller loads `about:blank` first. Failures are swallowed: the tab keeps
 * working with the plain Chrome user agent.
 */
async function applyChromeIdentity(webContents, userAgent) {
  try {
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const info = platformInfo();
    await dbg.sendCommand('Emulation.setUserAgentOverride', {
      userAgent,
      platform: info.navigatorPlatform,
      userAgentMetadata: buildUserAgentMetadata(),
    });
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_OBJECT_SCRIPT });
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PASSKEY_FALLBACK_SCRIPT });
    return true;
  } catch (error) {
    console.warn('[browser-tabs] chrome identity unavailable:', error && error.message);
    return false;
  }
}

module.exports = {
  realPlatformVersion,
  buildChromeBrands,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  formatBrandsHeader,
  installClientHintHeaders,
  applyChromeIdentity,
  CHROME_OBJECT_SCRIPT,
  PASSKEY_FALLBACK_SCRIPT,
};
