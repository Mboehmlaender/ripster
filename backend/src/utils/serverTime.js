function padNumber(value, length = 2) {
  return String(value).padStart(length, '0');
}

function formatTimezoneOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${padNumber(hours)}:${padNumber(minutes)}`;
}

function getServerTimestamp(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);

  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`
    + `T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`
    + `.${padNumber(date.getMilliseconds(), 3)}${formatTimezoneOffset(-date.getTimezoneOffset())}`;
}

module.exports = {
  getServerTimestamp
};
