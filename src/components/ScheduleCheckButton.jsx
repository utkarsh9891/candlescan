/**
 * ScheduleCheckButton — small button that queues a scheduled check for
 * a given symbol via the shared useScheduledChecks registry.
 *
 * Used on:
 *   - Novice Mode watch cards (imminent / building / early tiers)
 *   - Expert Index Scanner result cards (WAIT / near-threshold)
 *   - Anywhere else we want "remind me to check this in N minutes"
 *
 * Caller passes `scheduledChecks` (the return value from
 * useScheduledChecks in App.jsx) plus the per-symbol metadata. The
 * button handles the duration math based on `tier` and stops click
 * propagation so tapping it doesn't also trigger the parent card's
 * onClick.
 */

import { DEFAULT_DURATIONS_MS } from '../hooks/useScheduledChecks.js';

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60000);
  return `${mins} min`;
}

export default function ScheduleCheckButton({
  scheduledChecks,
  symbol,
  company,
  direction,
  beforeClass,
  beforeHint,
  tier = 'imminent',
  // Optional visual variants — 'compact' for tight cards, 'full' for
  // detail views.
  size = 'compact',
}) {
  if (!scheduledChecks || !symbol) return null;

  const alreadyPending = scheduledChecks.checks.find(
    (c) => c.symbol === symbol && c.status === 'pending'
  );

  const durationMs = DEFAULT_DURATIONS_MS[tier] || DEFAULT_DURATIONS_MS.imminent;
  const label = alreadyPending
    ? `⏱ checking in ${Math.max(0, Math.round((alreadyPending.scheduledAt - Date.now()) / 1000))}s`
    : `⏰ Check in ${formatDuration(durationMs)}`;

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (alreadyPending) {
      // Toggle: dismiss existing pending schedule instead of creating
      // another one.
      scheduledChecks.dismiss(alreadyPending.id);
      return;
    }
    scheduledChecks.schedule({
      symbol,
      company,
      direction,
      beforeClass,
      beforeHint,
      tier,
    });
  };

  const isCompact = size === 'compact';

  return (
    <button
      type="button"
      onClick={handleClick}
      title={alreadyPending
        ? 'Tap to cancel this scheduled check'
        : `Tap to remind me to re-check ${symbol} in ${formatDuration(durationMs)}`}
      style={{
        padding: isCompact ? '4px 8px' : '6px 12px',
        fontSize: isCompact ? 10 : 12,
        fontWeight: 700,
        borderRadius: 6,
        border: '1px solid',
        borderColor: alreadyPending ? '#fbbf24' : '#93c5fd',
        background: alreadyPending ? '#fffbeb' : '#eff6ff',
        color: alreadyPending ? '#b45309' : '#1d4ed8',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </button>
  );
}
