/**
 * NSE market-hours awareness.
 *
 * Window: 09:15–15:30 IST, Monday–Friday, excluding NSE holidays
 * (see holidays.mjs for the calendar).
 */

import { isNseHoliday } from './holidays.mjs';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function nowIst() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function hhmm(d) {
  return (
    String(d.getUTCHours()).padStart(2, '0') +
    ':' +
    String(d.getUTCMinutes()).padStart(2, '0')
  );
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {{
 *   open: boolean,
 *   hhmm: string,
 *   weekday: number,
 *   date: string,
 *   reason?: 'weekend'|'holiday'|'pre-open'|'after-close'
 * }}
 */
export function marketState() {
  const now = nowIst();
  const day = now.getUTCDay();
  const date = ymd(now);
  const time = hhmm(now);

  if (day === 0 || day === 6) {
    return { open: false, hhmm: time, weekday: day, date, reason: 'weekend' };
  }
  if (isNseHoliday(date)) {
    return { open: false, hhmm: time, weekday: day, date, reason: 'holiday' };
  }
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const openMin = 9 * 60 + 15;
  const closeMin = 15 * 60 + 30;
  if (minutes < openMin) {
    return { open: false, hhmm: time, weekday: day, date, reason: 'pre-open' };
  }
  if (minutes > closeMin) {
    return { open: false, hhmm: time, weekday: day, date, reason: 'after-close' };
  }
  return { open: true, hhmm: time, weekday: day, date };
}
