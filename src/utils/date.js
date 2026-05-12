const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function createDateError(message, code) {
  const error = new Error(message);
  if (code) {
    error.code = code;
  }
  return error;
}

function parseIntegerTimestamp(text, field) {
  if (!/^-?\d+$/.test(text)) {
    return null;
  }

  const timestamp = Number(text);

  if (!Number.isSafeInteger(timestamp)) {
    throw createDateError(`${field} must be a safe millisecond timestamp.`, `invalid_${field}`);
  }

  return timestamp;
}

function parseDateOnly(text, field, options = {}) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const endOfDay = Object.prototype.hasOwnProperty.call(options, 'endOfDay')
    ? options.endOfDay === true
    : field === 'to';
  const timestamp = endOfDay
    ? Date.UTC(year, monthIndex, day, 23, 59, 59, 999)
    : Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === monthIndex &&
    parsed.getUTCDate() === day
  ) {
    return timestamp;
  }

  throw createDateError(`${field} must be a valid calendar date.`, `invalid_${field}`);
}

function parseDateInput(value, field, options = {}) {
  const required = options.required === true;

  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) {
      throw createDateError(`${field} is required.`, `missing_${field}`);
    }

    return null;
  }

  const text = String(value).trim();
  const timestamp = parseIntegerTimestamp(text, field);

  if (timestamp !== null) {
    return timestamp;
  }

  const dateOnly = parseDateOnly(text, field, options);

  if (dateOnly !== null) {
    return dateOnly;
  }

  if (!ISO_DATE_TIME_PATTERN.test(text)) {
    throw createDateError(
      `${field} must be a YYYY-MM-DD date, millisecond timestamp, or ISO-8601 timestamp with timezone.`,
      `invalid_${field}`
    );
  }

  const parsed = Date.parse(text);

  if (Number.isFinite(parsed)) {
    return parsed;
  }

  throw createDateError(
    `${field} must be a valid YYYY-MM-DD date, millisecond timestamp, or ISO-8601 timestamp with timezone.`,
    `invalid_${field}`
  );
}

function assertTimestampRange(fromTs, toTs, options = {}) {
  if (fromTs !== null && toTs !== null && fromTs > toTs) {
    throw createDateError(options.message || 'from must be less than or equal to to.', options.code || 'invalid_range');
  }

  if (fromTs !== null && toTs !== null && options.maxSpanMs && (toTs - fromTs) > options.maxSpanMs) {
    const maxDays = Math.floor(options.maxSpanMs / DAY_MS);
    throw createDateError(
      options.maxSpanMessage || `Date range must be ${maxDays} days or less.`,
      options.maxSpanCode || 'range_too_large'
    );
  }
}

module.exports = {
  DAY_MS,
  assertTimestampRange,
  parseDateInput
};
