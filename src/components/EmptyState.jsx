/**
 * EmptyState — what we show on the single-stock view when there's nothing
 * to display. Two variants: "no symbol picked yet" (the initial state) and
 * "loading risk for the picked symbol".
 *
 * Previously this was a single bland "Enter a symbol and tap Scan" line
 * regardless of context. Beginners landing on the app couldn't tell whether
 * the app was working or what to do next. Now we give them a clearer prompt
 * plus a hint about Novice Mode (the real "easy button") for newcomers.
 */
export default function EmptyState({ variant = 'pick', onOpenNovice }) {
  if (variant === 'loading') {
    return (
      <div
        style={{
          padding: '28px 16px',
          textAlign: 'center',
          color: '#8892a8',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontSize: 18, marginBottom: 6 }}>...</div>
        <div>Loading data for this symbol — this can take a few seconds.</div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '28px 16px',
        textAlign: 'center',
        color: '#8892a8',
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontSize: 26, marginBottom: 6 }}>📊</div>
      <div style={{ marginBottom: 10 }}>
        Type a symbol above and tap{' '}
        <strong style={{ color: '#4a5068' }}>Scan</strong>, or pick a quick ticker.
      </div>
      {onOpenNovice && (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={onOpenNovice}
            style={{
              fontSize: 12, fontWeight: 600,
              padding: '6px 14px', borderRadius: 999,
              border: '1px solid #dbeafe', background: '#f0f4ff',
              color: '#2563eb', cursor: 'pointer',
            }}
          >
            New here? Try Novice Mode →
          </button>
        </div>
      )}
    </div>
  );
}
