const logger = require('../services/logger').child('ERROR_HANDLER');
const { errorToMeta } = require('../utils/errorMeta');

module.exports = function errorHandler(error, req, res, next) {
  const statusCode = error.statusCode || 500;

  logger.error('request:error', {
    reqId: req?.reqId,
    method: req?.method,
    url: req?.originalUrl,
    statusCode,
    error: errorToMeta(error)
  });

  res.status(statusCode).json({
    error: {
      message: error.message || 'Interner Fehler',
      statusCode,
      reqId: req?.reqId,
      details: Array.isArray(error.details) ? error.details : undefined
    }
  });
};
