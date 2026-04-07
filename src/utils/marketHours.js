const IST_OFFSET = 5.5 * 60 * 60 * 1000; // 5h30m in ms

export function getISTNow() {
  const now = new Date();
  return new Date(now.getTime() + (IST_OFFSET + now.getTimezoneOffset() * 60000));
}

export function getMarketStatus() {
  const ist = getISTNow();
  const day = ist.getDay(); // 0=Sun, 6=Sat
  const hm = ist.getHours() * 60 + ist.getMinutes();
  const openMin = 9 * 60 + 15;  // 09:15
  const closeMin = 15 * 60 + 30; // 15:30

  const isWeekday = day >= 1 && day <= 5;
  const isOpen = isWeekday && hm >= openMin && hm < closeMin;

  // Calculate next open/close
  let nextEventMs = 0;
  let nextLabel = '';

  if (isOpen) {
    const closeToday = new Date(ist);
    closeToday.setHours(15, 30, 0, 0);
    nextEventMs = closeToday - ist;
    nextLabel = 'Closes';
  } else {
    const nextOpen = new Date(ist);
    if (isWeekday && hm < openMin) {
      nextOpen.setHours(9, 15, 0, 0);
    } else {
      let daysAhead = 1;
      const nextDay = new Date(ist);
      nextDay.setDate(nextDay.getDate() + 1);
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
        nextDay.setDate(nextDay.getDate() + 1);
        daysAhead++;
      }
      nextOpen.setDate(ist.getDate() + daysAhead);
      nextOpen.setHours(9, 15, 0, 0);
    }
    nextEventMs = nextOpen - ist;
    nextLabel = 'Opens';
  }

  return { isOpen, nextEventMs: Math.max(0, nextEventMs), nextLabel };
}

export function formatCountdown(ms, nextLabel) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  // For long durations (>4h), show the target time instead of countdown
  if (h >= 4) {
    const target = new Date(Date.now() + ms);
    const ist = new Date(target.getTime() + (5.5 * 3600000 + target.getTimezoneOffset() * 60000));
    const hh = String(ist.getHours()).padStart(2, '0');
    const mm = String(ist.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
