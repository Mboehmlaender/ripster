const { randomUUID } = require('crypto');
const logger = require('../services/logger').child('HTTP');

function truncate(value, maxLen = 1500) {
  if (value === undefined) {
    return undefined;
  }

  let str;
  if (typeof value === 'string') {
    str = value;
  } else {
    try {
      str = JSON.stringify(value);
    } catch (error) {
      str = '[unserializable-body]';
    }
  }
  if (str.length <= maxLen) {
    return str;
  }

  return `${str.slice(0, maxLen)}...[truncated ${str.length - maxLen} chars]`;
}

module.exports = function requestLogger(req, res, next) {
  const reqId = randomUUID();
  const startedAt = Date.now();

  req.reqId = reqId;

  logger.info('request:start', {
    reqId,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    query: req.query,
    body: truncate(req.body)
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      logger.warn('request:aborted', {
        reqId,
        method: req.method,
        url: req.originalUrl,
        durationMs: Date.now() - startedAt
      });
    }
  });

  next();
};
