function errorToMeta(error) {
  if (!error) {
    return {};
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    signal: error.signal,
    statusCode: error.statusCode
  };
}

module.exports = {
  errorToMeta
};
