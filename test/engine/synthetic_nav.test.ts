/**
 * @file synthetic_nav.test.ts
 * @notice Unit tests for Multi-Oracle consolidation, staleness filtering, and synthetic NAV valuation.
 */

import {
  normalizeOraclePrice,
  calculateMedian,
  consolidateAssetPrice,
  computeIndexSyntheticNAV,
  OracleFeedObservation,
} from "../../lib/engine/synthetic_nav";

describe("Synthetic NAV Engine Suite", () => {
  test("normalizes integer oracle answers across varying decimals", () => {
    // 8 decimals Chainlink USD feed: 135.50 * 10^8
    expect(normalizeOraclePrice(13550000000n, 8)).toBe(135.50);
    // 6 decimals USDC feed: 1.00 * 10^6
    expect(normalizeOraclePrice(1000000n, 6)).toBe(1.00);
    // 18 decimals feed
    expect(normalizeOraclePrice(1000000000000000000n, 18)).toBe(1.00);
  });

  test("calculates median of odd and even numerical arrays", () => {
    expect(calculateMedian([10, 20, 30])).toBe(20);
    expect(calculateMedian([10, 20, 30, 40])).toBe(25);
    expect(calculateMedian([50])).toBe(50);
    expect(calculateMedian([])).toBe(0);
  });

  test("consolidates multiple oracle feeds filtering stale observations", () => {
    const now = Math.floor(Date.now() / 1000);
    const observations: OracleFeedObservation[] = [
      {
        source: "CHAINLINK",
        ticker: "NVDA",
        priceUSD: 135.0,
        decimals: 8,
        publishTimestamp: now - 300, // 5 min ago (fresh)
      },
      {
        source: "PYTH",
        ticker: "NVDA",
        priceUSD: 135.2,
        decimals: 8,
        publishTimestamp: now - 120, // 2 min ago (fresh)
      },
      {
        source: "UNISWAP_TWAP",
        ticker: "NVDA",
        priceUSD: 134.8,
        decimals: 18,
        publishTimestamp: now - 4000, // > 1h ago (stale)
      },
    ];

    const result = consolidateAssetPrice("NVDA", observations, now);
    expect(result.activeSourcesCount).toBe(2); // Only 2 fresh sources
    expect(result.isStale).toBe(false);
    expect(result.medianPriceUSD).toBe(135.1); // Median of 135.0 and 135.2
    expect(result.spreadBps).toBeLessThan(100);
  });

  test("computes total index synthetic NAV across multiple constituent holdings", () => {
    const now = Math.floor(Date.now() / 1000);
    const holdings = [
      { ticker: "NVDA", balanceUnits: 10n * 10n ** 18n, decimals: 18 }, // 10 tokens
      { ticker: "AAPL", balanceUnits: 20n * 10n ** 18n, decimals: 18 }, // 20 tokens
    ];

    const observations: OracleFeedObservation[] = [
      { source: "CHAINLINK", ticker: "NVDA", priceUSD: 100.0, decimals: 8, publishTimestamp: now - 60 },
      { source: "CHAINLINK", ticker: "AAPL", priceUSD: 200.0, decimals: 8, publishTimestamp: now - 60 },
    ];

    // Total NAV = 10 * $100 + 20 * $200 = $1,000 + $4,000 = $5,000
    // Total supply = 50 index tokens -> NAV per token = $100
    const report = computeIndexSyntheticNAV(
      holdings,
      observations,
      50n * 10n ** 18n,
      now
    );

    expect(report.totalNAVUSD).toBeCloseTo(5000, 2);
    expect(report.navPerTokenUSD).toBeCloseTo(100, 2);
    expect(report.isReliable).toBe(true);
    expect(report.stalenessAlerts.length).toBe(0);
  });
});
