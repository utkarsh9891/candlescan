import { describe, it, expect } from 'vitest';
import { scoreText, parseRssItems, extractSymbols, buildNewsSentimentMap } from './newsSentiment.js';

describe('scoreText', () => {
  it('returns 0 for empty or null', () => {
    expect(scoreText('')).toBe(0);
    expect(scoreText(null)).toBe(0);
    expect(scoreText(undefined)).toBe(0);
  });

  it('returns 0 for neutral text', () => {
    expect(scoreText('This is a test headline')).toBe(0);
  });

  it('is positive for bullish text', () => {
    expect(scoreText('Reliance surges to new record high on strong profit')).toBeGreaterThan(0);
  });

  it('is negative for bearish text', () => {
    expect(scoreText('HDFC plunges after weak results, analysts downgrade')).toBeLessThan(0);
  });

  it('clamps to [-1, +1]', () => {
    expect(scoreText('surge rally jump soar rise gain profit strong buy upgrade bullish positive')).toBeLessThanOrEqual(1);
    expect(scoreText('fall drop plunge slump slide tumble crash down loss weak sell downgrade bearish')).toBeGreaterThanOrEqual(-1);
  });

  it('handles mixed sentiment', () => {
    const s = scoreText('Stock surges on strong results despite some concerns');
    // More bullish words than bearish → positive
    expect(s).toBeGreaterThan(0);
  });

  it('respects word boundaries (unprofitable is bearish, not bullish)', () => {
    const unprofitable = scoreText('Unprofitable company reports another loss');
    expect(unprofitable).toBeLessThan(0);
  });
});

describe('parseRssItems', () => {
  it('returns empty array for empty or invalid xml', () => {
    expect(parseRssItems('')).toEqual([]);
    expect(parseRssItems(null)).toEqual([]);
    expect(parseRssItems('<not-rss/>')).toEqual([]);
  });

  it('parses a simple RSS feed', () => {
    const xml = `
      <rss>
        <channel>
          <item>
            <title>Reliance stock rises</title>
            <description>RIL shares gained 2% today</description>
            <pubDate>Mon, 10 Apr 2026 10:00:00 GMT</pubDate>
          </item>
          <item>
            <title>TCS upgrades outlook</title>
            <description>Positive guidance for Q2</description>
            <pubDate>Mon, 10 Apr 2026 11:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Reliance stock rises');
    expect(items[0].description).toContain('RIL shares');
    expect(items[0].pubDate).toContain('10 Apr 2026');
  });

  it('parses CDATA-wrapped titles', () => {
    const xml = `
      <rss><channel>
        <item>
          <title><![CDATA[Stock of the day: HDFC Bank]]></title>
          <description><![CDATA[<p>Banking sector leader rallies</p>]]></description>
        </item>
      </channel></rss>
    `;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Stock of the day: HDFC Bank');
    // HTML tags stripped
    expect(items[0].description).not.toContain('<p>');
    expect(items[0].description).toContain('Banking sector leader');
  });
});

describe('extractSymbols', () => {
  const universe = new Set(['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN', 'ADANIENT']);

  it('finds a single symbol in headline', () => {
    expect(extractSymbols('Reliance hits new high', universe)).toEqual(['RELIANCE']);
  });

  it('finds multiple symbols', () => {
    const hits = extractSymbols('TCS and INFY beat estimates', universe);
    expect(hits.sort()).toEqual(['INFY', 'TCS']);
  });

  it('respects word boundaries', () => {
    // "tcshares" should NOT match TCS
    expect(extractSymbols('tcshares', universe)).not.toContain('TCS');
  });

  it('returns empty when no symbols mentioned', () => {
    expect(extractSymbols('Market volatility rises', universe)).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(extractSymbols('', universe)).toEqual([]);
    expect(extractSymbols('text', null)).toEqual([]);
  });
});

describe('buildNewsSentimentMap', () => {
  const universe = new Set(['RELIANCE', 'TCS', 'HDFCBANK']);

  // Mock fetch that returns controlled RSS content
  const mockFetch = (url) => {
    const xml = `
      <rss><channel>
        <item>
          <title>Reliance surges on strong quarterly profit</title>
          <description>RIL up 3% in morning trade</description>
        </item>
        <item>
          <title>TCS downgraded after weak results and concerns</title>
          <description>Brokerage cuts target price</description>
        </item>
        <item>
          <title>HDFC Bank steady despite market volatility</title>
          <description>Mixed signals</description>
        </item>
      </channel></rss>
    `;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(xml),
    });
  };

  it('builds a sentiment map from mock Moneycontrol fetcher', async () => {
    const map = await buildNewsSentimentMap(universe, {
      mode: 'moneycontrol',
      fetchFn: mockFetch,
    });
    expect(map.RELIANCE).toBeGreaterThan(0); // "surges", "strong", "profit"
    expect(map.TCS).toBeLessThan(0);          // "downgraded", "weak", "concerns"
    // HDFCBANK may or may not have a score depending on neutral handling
  });

  it('returns empty map on all fetch failures', async () => {
    const failFetch = () => Promise.reject(new Error('network down'));
    const map = await buildNewsSentimentMap(universe, {
      mode: 'moneycontrol',
      fetchFn: failFetch,
    });
    expect(map).toEqual({});
  });

  it('skips unknown symbols', async () => {
    const map = await buildNewsSentimentMap(universe, {
      mode: 'moneycontrol',
      fetchFn: mockFetch,
    });
    // UNKNOWN symbol shouldn't appear
    expect(map.UNKNOWN).toBeUndefined();
  });
});
