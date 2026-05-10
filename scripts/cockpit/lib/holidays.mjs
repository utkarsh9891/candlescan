/**
 * NSE holiday calendar.
 *
 * Hardcoded for 2026 + 2027 from NSE's official trading-holidays list.
 * Refresh annually — when the user enters a new year, drop in the new
 * dates from https://www.nseindia.com/resources/exchange-communication-holidays
 *
 * Returns true if the given IST date (YYYY-MM-DD) is an NSE holiday.
 * Weekends are handled separately by market-hours.mjs.
 */

const HOLIDAYS = new Set([
  // 2026 (NSE published calendar — keep in sync if any change announced)
  '2026-01-26', // Republic Day
  '2026-02-19', // Mahashivratri
  '2026-03-03', // Holi
  '2026-03-31', // Eid-Ul-Fitr (Ramadan Eid)
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. B. R. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Eid
  '2026-06-26', // Muharram
  '2026-08-15', // Independence Day (Saturday — typically a market holiday by extension)
  '2026-08-26', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-21', // Dussehra
  '2026-11-09', // Diwali Laxmi Pujan (Muhurat trading separately)
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-25', // Guru Nanak Jayanti
  '2026-12-25', // Christmas

  // 2027 (placeholder — refresh when NSE publishes the official 2027 calendar)
  '2027-01-26', // Republic Day
  '2027-03-23', // Holi
  '2027-03-26', // Good Friday
  '2027-04-14', // Ambedkar Jayanti
  '2027-05-01', // Maharashtra Day
  '2027-08-15', // Independence Day (Sunday)
  '2027-09-15', // Ganesh Chaturthi
  '2027-10-02', // Gandhi Jayanti (Saturday)
  '2027-10-29', // Diwali Laxmi Pujan (Muhurat trading separately)
  '2027-11-15', // Guru Nanak Jayanti
  '2027-12-25', // Christmas (Saturday)
]);

export function isNseHoliday(istDate) {
  return HOLIDAYS.has(istDate);
}

export function _allHolidays() {
  return Array.from(HOLIDAYS).sort();
}
