'use strict';

const { normalizeBadgeCount, renderBadgePng } = require('./badge-overlay');

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const TAG = /^[a-zA-Z0-9:._-]{1,80}$/;

function applyBadgeCount({ app, platform, getWindow, nativeImage, count }) {
  const n = normalizeBadgeCount(count);
  if (app && typeof app.setBadgeCount === 'function') app.setBadgeCount(n);
  if (platform === 'win32') {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    const alive = win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed());
    if (alive && typeof win.setOverlayIcon === 'function') {
      if (n === 0) win.setOverlayIcon(null, '');
      else {
        const image = nativeImage.createFromBuffer(renderBadgePng(n));
        win.setOverlayIcon(image, `${n} messages non lus`);
      }
    }
  }
  return { ok: true, count: n };
}

/** Relative portal path only. Rejects protocol-relative and absolute URLs. */
function safePortalPath(value) {
  if (typeof value !== 'string') return '';
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//')) return '';
  if (path.includes('://') || path.includes('\\') || /\s/.test(path)) return '';
  return path.slice(0, 500);
}

function safeTag(value) {
  if (typeof value !== 'string') return '';
  const tag = value.trim();
  return TAG.test(tag) ? tag : '';
}

/**
 * System notification. Same tag replaces the previous one (one bubble per source).
 * `silent: true` skips the OS sound so a burst plays at most one sound.
 * No custom `sound` file: Focus / Ne pas déranger stays in charge.
 * A click focuses the window and asks the portal to open the conversation or the path.
 */
function showAgentNotification({ Notification, getWindow, payload, openNotifications, onFailed }) {
  const rawAgent = typeof payload?.agentId === 'string' ? payload.agentId : '';
  const rawConversation = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
  const agentId = OBJECT_ID.test(rawAgent) ? rawAgent : '';
  const conversationId = OBJECT_ID.test(rawConversation) ? rawConversation : '';
  const hasAgent = Boolean(agentId && conversationId);
  if ((rawAgent || rawConversation) && !hasAgent) return { ok: false, error: 'invalid' };
  const actionUrl = safePortalPath(payload?.actionUrl);
  if (!hasAgent && !actionUrl) return { ok: false, error: 'invalid' };

  const title = String(payload?.title || 'Lasco').slice(0, 120);
  const body = String(payload?.body || '').slice(0, 180);
  const tag = safeTag(payload?.tag);
  const silent = payload?.silent === true;
  if (tag && openNotifications && typeof openNotifications.get === 'function') {
    const previous = openNotifications.get(tag);
    if (previous && typeof previous.close === 'function') {
      try {
        previous.close();
      } catch {
        // The OS may already have dismissed it.
      }
    }
  }

  const notification = new Notification({
    title,
    body,
    silent,
    ...(tag ? { tag } : {}),
  });
  notification.on('click', () => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
    if (typeof win.show === 'function') win.show();
    if (typeof win.focus === 'function') win.focus();
    const openPayload = {};
    if (hasAgent) {
      openPayload.agentId = agentId;
      openPayload.conversationId = conversationId;
    }
    if (actionUrl) openPayload.actionUrl = actionUrl;
    if (tag) openPayload.tag = tag;
    win.webContents.send('lasco-notification-open', openPayload);
  });
  if (typeof notification.on === 'function') {
    notification.on('failed', () => {
      if (typeof onFailed === 'function') onFailed();
    });
  }
  if (tag && openNotifications && typeof openNotifications.set === 'function') {
    openNotifications.set(tag, notification);
  }
  if (typeof notification.show === 'function') notification.show();
  return { ok: true };
}

function closeDesktopNotification({ openNotifications, tag }) {
  const key = safeTag(tag);
  if (!key || !openNotifications || typeof openNotifications.get !== 'function') {
    return { ok: false, error: 'invalid' };
  }
  const current = openNotifications.get(key);
  if (current && typeof current.close === 'function') {
    try {
      current.close();
    } catch {
      // Already gone.
    }
  }
  if (typeof openNotifications.delete === 'function') openNotifications.delete(key);
  return { ok: true };
}

function readNotificationPermission({ Notification, failed }) {
  if (Notification && typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
    return 'unsupported';
  }
  if (failed) return 'denied';
  return 'prompt';
}

function notificationSettingsTarget(platform) {
  if (platform === 'win32') return 'ms-settings:notifications';
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
  return null;
}

module.exports = {
  applyBadgeCount,
  showAgentNotification,
  closeDesktopNotification,
  readNotificationPermission,
  notificationSettingsTarget,
  safePortalPath,
  safeTag,
};
