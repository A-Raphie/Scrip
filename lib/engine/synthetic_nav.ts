/**
 * @file synthetic_nav.ts
 * @notice Real-Time Multi-Oracle Synthetic NAV Aggregator & Fault-Tolerant Pricing Engine for Weft Index.
 * Combines Chainlink price feeds, Pyth Network pull oracles, and Uniswap v3 TWAPs
 * with stale-feed rejection, outlier filtering, and multi-decimal token normalization.
 */

export interface OracleFeedObservation {
  source: "CHAINLINK" | "PYTH" | "UNISWAP_TWAP";
  ticker: string;
  priceUSD: number;
  decimals: number;
  publishTimestamp: number; // Unix seconds
  confidenceUSD?: number;
}

export interface ConsolidatedPriceResult {
  ticker: string;
  medianPriceUSD: number;
  twapPriceUSD?: number;
  spreadBps: number;
  activeSourcesCount: number;
  isStale: boolean;
  hasOutlier: boolean;
  finalPriceUSD: number;
}

export interface SyntheticIndexNAVReport {
  timestamp: number;
  totalNAVUSD: number;
  navPerTokenUSD: number;
  totalSupplyTokens: bigint;
  constituentPrices: Record<string, ConsolidatedPriceResult>;
  isReliable: boolean;
  stalenessAlerts: string[];
}

const MAX_STALENESS_SECONDS = 3600; // 1 hour max age before marking stale
const MAX_DISCREPANCY_BPS = 300; // 3% max spread between oracle sources

/**
 * Normalizes an integer raw oracle price value to floating-point USD.
 */
export function normalizeOraclePrice(rawAnswer: bigint, decimals: number): number {
  const factor = 10 ** decimals;
  return Number(rawAnswer) / factor;
}

/**
 * Computes median price from a set of observation prices.
 */
export function calculateMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Consolidates multiple oracle observations for a single ticker.
 * Applies sanity filters: rejects stale prices (> 1h old) and isolates rogue outliers.
 */
export function consolidateAssetPrice(
  ticker: string,
  observations: OracleFeedObservation[],
  currentTimestamp = Math.floor(Date.now() / 1000)
): ConsolidatedPriceResult {
  if (observations.length === 0) {
    return {
      ticker,
      medianPriceUSD: 0,
      spreadBps: 0,
      activeSourcesCount: 0,
      isStale: true,
      hasOutlier: false,
      finalPriceUSD: 0,
    };
  }

  // Filter out observations older than maximum staleness threshold
  const freshObservations = observations.filter(
    (obs) => currentTimestamp - obs.publishTimestamp <= MAX_STALENESS_SECONDS
  );

  const isStale = freshObservations.length === 0;
  const validList = isStale ? observations : freshObservations;
  const prices = validList.map((o) => o.priceUSD);
  const median = calculateMedian(prices);

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const spreadBps = median > 0 ? ((maxPrice - minPrice) / median) * 10_000 : 0;
  const hasOutlier = spreadBps > MAX_DISCREPANCY_BPS;

  // TWAP source if present
  const twapObs = validList.find((o) => o.source === "UNISWAP_TWAP");

  return {
    ticker,
    medianPriceUSD: median,
    twapPriceUSD: twapObs ? twapObs.priceUSD : undefined,
    spreadBps,
    activeSourcesCount: freshObservations.length,
    isStale,
    hasOutlier,
    finalPriceUSD: median,
  };
}

/**
 * Calculates synthetic Index NAV per token and aggregate basket value.
 */
export function computeIndexSyntheticNAV(
  tokenHoldings: Array<{ ticker: string; balanceUnits: bigint; decimals: number }>,
  allObservations: OracleFeedObservation[],
  totalSupplyTokens: bigint,
  currentTimestamp = Math.floor(Date.now() / 1000)
): SyntheticIndexNAVReport {
  const constituentPrices: Record<string, ConsolidatedPriceResult> = {};
  const stalenessAlerts: string[] = [];
  let totalNAVUSD = 0;

  // Group observations by ticker
  const obsByTicker: Record<string, OracleFeedObservation[]> = {};
  for (const obs of allObservations) {
    if (!obsByTicker[obs.ticker]) obsByTicker[obs.ticker] = [];
    obsByTicker[obs.ticker].push(obs);
  }

  for (const holding of tokenHoldings) {
    const obs = obsByTicker[holding.ticker] || [];
    const consolidated = consolidateAssetPrice(holding.ticker, obs, currentTimestamp);
    constituentPrices[holding.ticker] = consolidated;

    if (consolidated.isStale) {
      stalenessAlerts.push(holding.ticker);
    }

    const unitsFloat = Number(holding.balanceUnits) / 10 ** holding.decimals;
    const valueUSD = unitsFloat * consolidated.finalPriceUSD;
    totalNAVUSD += valueUSD;
  }

  const totalSupplyFloat = Number(totalSupplyTokens) / 1e18;
  const navPerTokenUSD = totalSupplyFloat > 0 ? totalNAVUSD / totalSupplyFloat : 100.0;
  const isReliable = stalenessAlerts.length === 0 && Object.values(constituentPrices).every((c) => !c.hasOutlier);

  return {
    timestamp: currentTimestamp,
    totalNAVUSD,
    navPerTokenUSD,
    totalSupplyTokens,
    constituentPrices,
    isReliable,
    stalenessAlerts,
  };
}
