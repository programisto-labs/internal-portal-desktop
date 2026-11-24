'use strict';

const { execFile } = require('child_process');

/**
 * Identity check before the portal shows a saved password (docs/passwords.md, « Show a password »).
 * Same idea as Chrome's password manager: the operating system asks the person sitting at the
 * computer to prove it is them.
 *
 * - macOS: Touch ID (Electron `promptTouchID`, attributed to Lasco); without Touch ID, the system
 *   LocalAuthentication sheet that accepts the session password (`LAPolicyDeviceOwnerAuthentication`).
 * - Windows: Windows Hello (`UserConsentVerifier`: PIN, face, fingerprint). Without Hello configured
 *   the check is refused and the user is told to set it up.
 * - Other systems: not available.
 *
 * A success is remembered for one minute (Chrome does the same), so revealing several passwords in a
 * row asks once. It only gates what this computer shows: the server still checks ownership and logs
 * every view.
 */

const VERIFIED_TTL_MS = 60 * 1000;
const PROMPT_TIMEOUT_MS = 120 * 1000;
const MAX_REASON_LENGTH = 160;

/** JXA: LocalAuthentication with biometrics OR the session password. `check` only tests availability. */
const MAC_LA_SCRIPT = `
function run(argv) {
  ObjC.import('LocalAuthentication');
  ObjC.import('Foundation');
  var ctx = $.LAContext.alloc.init;
  var POLICY_DEVICE_OWNER = 2;
  if (!ctx.canEvaluatePolicyError(POLICY_DEVICE_OWNER, null)) return 'unavailable';
  if (argv[1] === 'check') return 'available';
  var state = { done: false, ok: false };
  ctx.evaluatePolicyLocalizedReasonReply(POLICY_DEVICE_OWNER, argv[0], function (success, error) {
    state.ok = success;
    state.done = true;
  });
  var deadline = Date.now() + ${PROMPT_TIMEOUT_MS};
  while (!state.done && Date.now() < deadline) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
  return state.ok ? 'ok' : state.done ? 'denied' : 'timeout';
}
`;

const WINDOWS_HELLO_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
[void][Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier]
$availability = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @($verifier::CheckAvailabilityAsync())).Result
if ($availability -ne 'Available') { 'unavailable'; exit 0 }
$result = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($verifier::RequestVerificationAsync($env:LASCO_VERIFY_REASON))).Result
if ($result -eq 'Verified') { 'ok' } else { 'denied' }
`;

function cleanReason(reason) {
  const text = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return (text || 'afficher un mot de passe enregistré').slice(0, MAX_REASON_LENGTH);
}

function runScript(runFile, file, args, options) {
  return new Promise((resolve) => {
    runFile(file, args, { timeout: PROMPT_TIMEOUT_MS + 5000, windowsHide: true, ...options }, (error, stdout) => {
      if (error) {
        resolve('error');
        return;
      }
      resolve(String(stdout || '').trim().split(/\r?\n/).pop() || 'error');
    });
  });
}

function createVaultAuth({ platform = process.platform, systemPreferences, runFile = execFile, now = Date.now, env = process.env } = {}) {
  let verifiedAt = 0;
  let pending = null;

  async function promptMac(reason) {
    if (systemPreferences && typeof systemPreferences.canPromptTouchID === 'function' && systemPreferences.canPromptTouchID()) {
      try {
        // Electron prefixes the reason with the app name: « Lasco veut … ».
        await systemPreferences.promptTouchID(reason);
        return 'ok';
      } catch (_) {
        return 'denied';
      }
    }
    return runScript(runFile, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_LA_SCRIPT, reason]);
  }

  function promptWindows(reason) {
    return runScript(
      runFile,
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_HELLO_SCRIPT],
      // The reason goes through the environment: never interpolated into the script.
      { env: { ...env, LASCO_VERIFY_REASON: reason } },
    );
  }

  async function verifyOnce(reason) {
    let outcome;
    if (platform === 'darwin') outcome = await promptMac(reason);
    else if (platform === 'win32') outcome = await promptWindows(reason);
    else return { ok: false, error: 'unsupported' };
    if (outcome === 'ok') {
      verifiedAt = now();
      return { ok: true };
    }
    if (outcome === 'unavailable') return { ok: false, error: 'unavailable' };
    if (outcome === 'denied' || outcome === 'timeout') return { ok: false, error: 'denied' };
    return { ok: false, error: 'failed' };
  }

  return {
    /** `{ ok }` or `{ ok: false, error: 'denied' | 'unavailable' | 'unsupported' | 'failed' }`. */
    verifyUser(payload = {}) {
      if (verifiedAt && now() - verifiedAt < VERIFIED_TTL_MS) return Promise.resolve({ ok: true, recent: true });
      if (!pending) {
        pending = verifyOnce(cleanReason(payload.reason)).finally(() => {
          pending = null;
        });
      }
      return pending;
    },
    /** Forget a recent success (portal logout, screen lock). */
    reset() {
      verifiedAt = 0;
      return { ok: true };
    },
  };
}

module.exports = { createVaultAuth, MAC_LA_SCRIPT, WINDOWS_HELLO_SCRIPT, VERIFIED_TTL_MS };
