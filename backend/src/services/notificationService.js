const settingsService = require('./settingsService');
const logger = require('./logger').child('PUSHOVER');
const { toBoolean } = require('../utils/validators');
const { errorToMeta } = require('../utils/errorMeta');

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

const EVENT_TOGGLE_KEYS = {
  metadata_ready: 'pushover_notify_metadata_ready',
  rip_started: 'pushover_notify_rip_started',
  encoding_started: 'pushover_notify_encoding_started',
  job_finished: 'pushover_notify_job_finished',
  job_error: 'pushover_notify_job_error',
  job_cancelled: 'pushover_notify_job_cancelled',
  reencode_started: 'pushover_notify_reencode_started',
  reencode_finished: 'pushover_notify_reencode_finished'
};

function truncate(value, maxLen = 1024) {
  const text = String(value || '').trim();
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 20)}...[truncated]`;
}

function normalizePriority(raw) {
  const n = Number(raw);
  if (Number.isNaN(n)) {
    return 0;
  }
  if (n < -2) {
    return -2;
  }
  if (n > 2) {
    return 2;
  }
  return Math.round(n);
}

class NotificationService {
  async notify(eventKey, payload = {}) {
    const settings = await settingsService.getSettingsMap();
    return this.notifyWithSettings(settings, eventKey, payload);
  }

  async sendTest({ title, message } = {}) {
    return this.notify('test', {
      title: title || 'Ripster Test',
      message: message || 'PushOver Testnachricht von Ripster.'
    });
  }

  async notifyWithSettings(settings, eventKey, payload = {}) {
    const enabled = toBoolean(settings.pushover_enabled);
    if (!enabled) {
      logger.debug('notify:skip:disabled', { eventKey });
      return { sent: false, reason: 'disabled', eventKey };
    }

    const toggleKey = EVENT_TOGGLE_KEYS[eventKey];
    if (toggleKey && !toBoolean(settings[toggleKey])) {
      logger.debug('notify:skip:event-disabled', { eventKey, toggleKey });
      return { sent: false, reason: 'event-disabled', eventKey };
    }

    const token = String(settings.pushover_token || '').trim();
    const user = String(settings.pushover_user || '').trim();
    if (!token || !user) {
      logger.warn('notify:skip:missing-credentials', {
        eventKey,
        hasToken: Boolean(token),
        hasUser: Boolean(user)
      });
      return { sent: false, reason: 'missing-credentials', eventKey };
    }

    const prefix = String(settings.pushover_title_prefix || 'Ripster').trim();
    const title = truncate(payload.title || `${prefix} - ${eventKey}`, 120);
    const message = truncate(payload.message || eventKey, 1024);
    const priority = normalizePriority(
      payload.priority !== undefined ? payload.priority : settings.pushover_priority
    );
    const timeoutMs = Math.max(1000, Number(settings.pushover_timeout_ms || 7000));

    const form = new URLSearchParams();
    form.set('token', token);
    form.set('user', user);
    form.set('title', title);
    form.set('message', message);
    form.set('priority', String(priority));

    const device = String(settings.pushover_device || '').trim();
    if (device) {
      form.set('device', device);
    }

    if (payload.url) {
      form.set('url', String(payload.url));
    }
    if (payload.urlTitle) {
      form.set('url_title', String(payload.urlTitle));
    }
    if (payload.sound) {
      form.set('sound', String(payload.sound));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(PUSHOVER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: controller.signal
      });

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (error) {
        data = null;
      }

      if (!response.ok) {
        const messageText = data?.errors?.join(', ') || data?.error || rawText || `HTTP ${response.status}`;
        const error = new Error(`PushOver HTTP ${response.status}: ${messageText}`);
        error.statusCode = response.status;
        throw error;
      }

      if (data && data.status !== 1) {
        const messageText = data.errors?.join(', ') || data.error || 'Unbekannte PushOver Antwort.';
        throw new Error(`PushOver Fehler: ${messageText}`);
      }

      logger.info('notify:sent', {
        eventKey,
        title,
        priority,
        requestId: data?.request || null
      });
      return {
        sent: true,
        eventKey,
        requestId: data?.request || null
      };
    } catch (error) {
      logger.error('notify:failed', {
        eventKey,
        title,
        error: errorToMeta(error)
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = new NotificationService();
