/**
 * @file stress_test.ts
 * @notice High-Concurrency Multi-Agent Transaction Stress Test Simulator for Weft Index.
 * Simulates hundreds of parallel users executing mint, burn, rebalance, and arbitrage actions
 * under extreme price volatility and gas spikes on Base mainnet.
 */

import { evaluatePortfolioMetrics, AssetReturnSeries } from "../../lib/engine/portfolio_math";
import { runPortfolioMonteCarlo } from "../../lib/engine/monte_carlo";
import { quoteBasketSwap, ConcentratedPoolState } from "../../lib/engine/aerodrome_router";

export interface SimulatedUserAgent {
  id: string;
  userType: "RETAIL_DCA" | "WHALE_ARBITRAGEUR" | "LIQUIDITY_PROVIDER" | "DELEVERAGING_FUND";
  balanceUSDC: bigint;
  balanceIndexTokens: bigint;
  riskTolerance: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  actionFrequencyMinutes: number;
}

export interface StressSimulationResult {
  totalSimulatedMinutes: number;
  totalTransactionsExecuted: number;
  totalMints: number;
  totalBurns: number;
  totalRebalances: number;
  arbitrageVolumeUSD: number;
  averageGasUsedPerTx: number;
  peakGasUsed: number;
  failedTransactionsCount: number;
  maxSlippageObservedPercent: number;
  averageSlippageObservedPercent: number;
  finalIndexNAVUSD: number;
  navTrackingErrorBps: number;
}

// B20 Top 10 constituents
const B20_TICKERS = [
  "NVDA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AVGO",
  "BRK.B",
  "JPM",
];

const INITIAL_WEIGHTS: Record<string, number> = {
  NVDA: 0.18,
  AAPL: 0.16,
  MSFT: 0.15,
  AMZN: 0.12,
  GOOGL: 0.11,
  META: 0.09,
  TSLA: 0.07,
  AVGO: 0.05,
  "BRK.B": 0.04,
  JPM: 0.03,
};

const INITIAL_PRICES: Record<string, number> = {
  NVDA: 135.5,
  AAPL: 228.2,
  MSFT: 425.0,
  AMZN: 198.8,
  GOOGL: 182.4,
  META: 585.0,
  TSLA: 260.0,
  AVGO: 180.0,
  "BRK.B": 460.0,
  JPM: 225.0,
};

/**
 * Initializes a population of simulated user agents with heterogeneous behaviors.
 */
export function generateUserPopulation(size: number): SimulatedUserAgent[] {
  const population: SimulatedUserAgent[] = [];
  const types: SimulatedUserAgent["userType"][] = [
    "RETAIL_DCA",
    "WHALE_ARBITRAGEUR",
    "LIQUIDITY_PROVIDER",
    "DELEVERAGING_FUND",
  ];

  for (let i = 0; i < size; i++) {
    const type = types[i % types.length];
    let balanceUSDC = 5_000n * 10n ** 6n; // $5k default retail
    let balanceTokens = 0n;

    if (type === "WHALE_ARBITRAGEUR") {
      balanceUSDC = 500_000n * 10n ** 6n; // $500k
    } else if (type === "LIQUIDITY_PROVIDER") {
      balanceUSDC = 250_000n * 10n ** 6n; // $250k
    } else if (type === "DELEVERAGING_FUND") {
      balanceUSDC = 1_000_000n * 10n ** 6n; // $1M
      balanceTokens = 2_000n * 10n ** 18n; // Holds index tokens
    }

    population.push({
      id: `agent-${i + 1}-${type}`,
      userType: type,
      balanceUSDC,
      balanceIndexTokens: balanceTokens,
      riskTolerance: i % 3 === 0 ? "CONSERVATIVE" : i % 3 === 1 ? "BALANCED" : "AGGRESSIVE",
      actionFrequencyMinutes: type === "WHALE_ARBITRAGEUR" ? 1 : 15,
    });
  }

  return population;
}

/**
 * Simulates mock Aerodrome Slipstream concentrated pools for each constituent.
 */
export function generateMockPoolStates(): Record<string, ConcentratedPoolState> {
  const pools: Record<string, ConcentratedPoolState> = {};
  for (const ticker of B20_TICKERS) {
    pools[ticker] = {
      address: `0x${ticker.replace(".", "").padStart(40, "a")}`,
      token0: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC
      token1: `0x${ticker.replace(".", "").padStart(40, "b")}`,
      feeTier: 500, // 0.05%
      tickSpacing: 10,
      sqrtPriceX96: 79228162514264337593543950336n, // roughly 1:1 base
      currentTick: 0,
      liquidity: 5_000_000_000_000_000n, // Deep liquidity
    };
  }
  return pools;
}

/**
 * Executes a full discrete-event stress simulation over multiple market epochs.
 */
export function runStressSimulation(
  agentCount = 100,
  durationMinutes = 1440, // 24 hours of trading
  marketShockMinute = 360 // Shock occurs 6 hours in
): StressSimulationResult {
  const agents = generateUserPopulation(agentCount);
  const poolStates = generateMockPoolStates();
  const currentPrices = { ...INITIAL_PRICES };
  const currentWeights = { ...INITIAL_WEIGHTS };

  let totalMints = 0;
  let totalBurns = 0;
  let totalRebalances = 0;
  let failedTxs = 0;
  let totalGasAccum = 0n;
  let peakGas = 0n;
  let arbitrageVolumeUSD = 0;
  let maxSlippageObserved = 0;
  let totalSlippageAccum = 0;
  let slippageMeasurements = 0;

  // Compute initial benchmark NAV
  let currentNAV = Object.keys(currentPrices).reduce(
    (acc, t) => acc + currentPrices[t] * currentWeights[t],
    0
  );

  for (let minute = 0; minute < durationMinutes; minute++) {
    // 1. Simulate Price Action & Market Shock
    const isShockMinute = minute >= marketShockMinute && minute <= marketShockMinute + 45;
    for (const ticker of B20_TICKERS) {
      let minuteDrift = (Math.random() - 0.495) * 0.002; // Small natural random walk
      if (isShockMinute) {
        // High volatility downward shock
        minuteDrift -= 0.008;
      }
      currentPrices[ticker] = Math.max(1.0, currentPrices[ticker] * (1 + minuteDrift));
    }

    // 2. Re-evaluate Index NAV
    const updatedNAV = Object.keys(currentPrices).reduce(
      (acc, t) => acc + currentPrices[t] * currentWeights[t],
      0
    );

    // 3. Check Index Rebalance Threshold (if weight drifted > 4%)
    let maxWeightDeviation = 0;
    const totalMarketCap = Object.keys(currentPrices).reduce(
      (acc, t) => acc + currentPrices[t],
      0
    );
    for (const ticker of B20_TICKERS) {
      const liveWeight = currentPrices[ticker] / totalMarketCap;
      const dev = Math.abs(liveWeight - currentWeights[ticker]);
      if (dev > maxWeightDeviation) {
        maxWeightDeviation = dev;
      }
    }

    if (maxWeightDeviation > 0.04) {
      totalRebalances++;
      const rebalanceGas = 385_000n;
      totalGasAccum += rebalanceGas;
      if (rebalanceGas > peakGas) peakGas = rebalanceGas;
    }

    // 4. Multi-agent action cycle
    for (const agent of agents) {
      if (minute % agent.actionFrequencyMinutes !== 0) continue;

      try {
        if (agent.userType === "RETAIL_DCA" && agent.balanceUSDC >= 500n * 10n ** 6n) {
          // Mint $500 worth of Weft tokens
          const mintAmountUSDC = 500n * 10n ** 6n;
          const quote = quoteBasketSwap(
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            mintAmountUSDC,
            currentWeights,
            poolStates
          );

          agent.balanceUSDC -= mintAmountUSDC;
          const tokensMinted = (mintAmountUSDC * 10n ** 18n) / BigInt(Math.floor(updatedNAV * 1e6));
          agent.balanceIndexTokens += tokensMinted;

          totalMints++;
          totalGasAccum += quote.totalGasEstimate;
          if (quote.totalGasEstimate > peakGas) peakGas = quote.totalGasEstimate;

          if (quote.aggregatePriceImpact > maxSlippageObserved) {
            maxSlippageObserved = quote.aggregatePriceImpact;
          }
          totalSlippageAccum += quote.aggregatePriceImpact;
          slippageMeasurements++;
        } else if (agent.userType === "WHALE_ARBITRAGEUR") {
          // Check for NAV discount or premium
          const syntheticPrice = updatedNAV;
          const secondaryMarketPrice = updatedNAV * (1 + (Math.random() - 0.5) * 0.015);
          const spreadBps = Math.abs(secondaryMarketPrice - syntheticPrice) / syntheticPrice * 10000;

          if (spreadBps > 50) {
            // Profitable arbitrage opportunity
            const arbVolume = 50_000; // $50,000 arbitrage trade
            arbitrageVolumeUSD += arbVolume;
            const arbGas = 280_000n;
            totalGasAccum += arbGas;
            if (arbGas > peakGas) peakGas = arbGas;
          }
        } else if (agent.userType === "DELEVERAGING_FUND" && isShockMinute) {
          // Panic sell / redeem index tokens
          if (agent.balanceIndexTokens > 50n * 10n ** 18n) {
            const burnTokens = 50n * 10n ** 18n;
            agent.balanceIndexTokens -= burnTokens;
            const proceedsUSDC = (burnTokens * BigInt(Math.floor(updatedNAV * 1e6))) / 10n ** 18n;
            agent.balanceUSDC += proceedsUSDC;

            totalBurns++;
            const burnGas = 310_000n;
            totalGasAccum += burnGas;
            if (burnGas > peakGas) peakGas = burnGas;
          }
        }
      } catch (err) {
        failedTxs++;
      }
    }
  }

  const totalTx = totalMints + totalBurns + totalRebalances;
  const avgGas = totalTx > 0 ? Number(totalGasAccum / BigInt(totalTx)) : 0;
  const avgSlippage = slippageMeasurements > 0 ? totalSlippageAccum / slippageMeasurements : 0;

  // Final NAV tracking calculation
  const finalNAV = Object.keys(currentPrices).reduce(
    (acc, t) => acc + currentPrices[t] * currentWeights[t],
    0
  );
  const navTrackingError = Math.abs(finalNAV - currentNAV) / currentNAV * 10000;

  return {
    totalSimulatedMinutes: durationMinutes,
    totalTransactionsExecuted: totalTx,
    totalMints,
    totalBurns,
    totalRebalances,
    arbitrageVolumeUSD,
    averageGasUsedPerTx: avgGas,
    peakGasUsed: Number(peakGas),
    failedTransactionsCount: failedTxs,
    maxSlippageObservedPercent: maxSlippageObserved,
    averageSlippageObservedPercent: avgSlippage,
    finalIndexNAVUSD: finalNAV,
    navTrackingErrorBps: navTrackingError,
  };
}
