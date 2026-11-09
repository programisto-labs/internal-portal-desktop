'use strict';

const { normalizeBadgeCount, renderBadgePng } = require('./badge-overlay');

const OBJECT_ID = /^[a-f0-9]{24}$/i;

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

function showAgentNotification({ Notification, getWindow, payload }) {
  const agentId = typeof payload?.agentId === 'string' && OBJECT_ID.test(payload.agentId) ? payload.agentId : '';
  const conversationId =
    typeof payload?.conversationId === 'string' && OBJECT_ID.test(payload.conversationId) ? payload.conversationId : '';
  if (!agentId || !conversationId) return { ok: false, error: 'invalid' };
  const title = String(payload.title || 'Lasco').slice(0, 120);
  const body = String(payload.body || '').slice(0, 180);
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
    if (typeof win.show === 'function') win.show();
    if (typeof win.focus === 'function') win.focus();
    win.webContents.send('lasco-notification-open', { agentId, conversationId });
  });
  if (typeof notification.show === 'function') notification.show();
  return { ok: true };
}

module.exports = { applyBadgeCount, showAgentNotification };
