'use strict';

// Taiwan business-date helpers. All POS day cuts run in Asia/Taipei (UTC+8, no DST),
// not UTC, otherwise an order created at 23:30 local would attribute to the next
// business day for cross-store reporting.

const TZ = 'Asia/Taipei';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function taipeiNow(now = new Date()) {
  // Asia/Taipei is fixed UTC+8 (no DST). Use parts via Intl to avoid env reliance.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function taipeiBusinessDate(now = new Date()) {
  return taipeiNow(now).date;
}

function isValidBusinessDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizeBusinessDate(value, fallbackNow = new Date()) {
  if (isValidBusinessDate(value)) return value;
  return taipeiBusinessDate(fallbackNow);
}

module.exports = { TZ, taipeiNow, taipeiBusinessDate, isValidBusinessDate, normalizeBusinessDate };
