/**
 * @file liquidity_benchmark.ts
 * @notice Benchmark & Gas Optimization Profiler for Weft Index Protocol.
 * Analyzes execution gas costs, liquidity fragmentation across Base DEXes,
 * and calibrates the optimal rebalance deviation trigger band.
 */

export interface GasProfileEntry {
  operation: string;
  directIndividualGas: number; // Buying each asset separately
  weftBatchGas: number; // Single batch contract call
  gasSavingsPercent: number;
  calldataBytes: number;
  estimatedCostGweiBase: number;
}

export interface RebalanceTriggerAnalysis {
  deviationThresholdPercent: number; // e.g. 1.0%, 2.0%, 3.0%, 5.0%
  annualRebalanceFrequency: number;
  annualGasCostUSD: number;
  trackingErrorBps: number;
  netEconomicDragUSD: number;
  isParetoOptimal: boolean;
}

export interface LiquidityFragmentationModel {
  venue: "Aerodrome Slipstream" | "Uniswap v3 Base" | "PancakeSwap v3 Base";
  poolTVLUSD: number;
  effectiveSpreadBps: number;
  depthFor100kTradeUSD: number;
  simulatedPriceImpactPercent: number;
}

/**
 * Profiles on-chain gas costs for index operations across varying basket sizes.
 */
export function profileGasSavings(): GasProfileEntry[] {
  const basketSizes = [5, 10, 15, 20];
  const entries: GasProfileEntry[] = [];

  for (const size of basketSizes) {
    // Direct individual swap per asset ~ 140,000 gas each + token approvals
    const directGas = size * 145_000 + size * 45_000;

    // Weft batch mint: base contract overhead (55k) + multicall loop (85k per constituent)
    const weftGas = 55_000 + size * 82_000;

    const savings = ((directGas - weftGas) / directGas) * 100;
    const calldataBytes = 128 + size * 64;
    const estimatedCostGwei = (weftGas * 0.05); // 0.05 Gwei typical Base L2 gas price

    entries.push({
      operation: `Index Mint (${size} Assets)`,
      directIndividualGas: directGas,
      weftBatchGas: weftGas,
      gasSavingsPercent: savings,
      calldataBytes,
      estimatedCostGweiBase: estimatedCostGwei,
    });
  }

  // Add Redemption benchmark
  entries.push({
    operation: "Index Burn / Pro-Rata Unwind (10 Assets)",
    directIndividualGas: 10 * 135_000,
    weftBatchGas: 65_000 + 10 * 68_000,
    gasSavingsPercent: ((10 * 135_000 - (65_000 + 10 * 68_000)) / (10 * 135_000)) * 100,
    calldataBytes: 512,
    estimatedCostGweiBase: (65_000 + 10 * 68_000) * 0.05,
  });

  return entries;
}

/**
 * Calibrates the optimal rebalance threshold band by analyzing the trade-off
 * between tracking error penalty and on-chain transaction fees.
 */
export function analyzeRebalanceThresholds(portfolioAUM = 5_000_000): RebalanceTriggerAnalysis[] {
  const thresholds = [0.5, 1.0, 2.0, 3.0, 5.0, 7.5, 10.0];
  const results: RebalanceTriggerAnalysis[] = [];

  let minEconomicDrag = Infinity;
  let bestThreshold = 3.0;

  for (const threshold of thresholds) {
    // Frequency of rebalance events per year inversely correlates with threshold
    const annualFrequency = Math.round(365 / (threshold * 8.5));
    const gasPerRebalanceUSD = 0.45; // ~$0.45 on Base L2
    const slippageCostPerRebalanceUSD = portfolioAUM * (threshold / 100) * 0.0015;
    const annualRebalanceCost = annualFrequency * (gasPerRebalanceUSD + slippageCostPerRebalanceUSD);

    // Tracking error increases proportionally with threshold
    const trackingErrorBps = threshold * 18.5;
    const annualTrackingErrorDragUSD = portfolioAUM * (trackingErrorBps / 10_000) * 0.05;

    const netDrag = annualRebalanceCost + annualTrackingErrorDragUSD;

    if (netDrag < minEconomicDrag) {
      minEconomicDrag = netDrag;
      bestThreshold = threshold;
    }

    results.push({
      deviationThresholdPercent: threshold,
      annualRebalanceFrequency: annualFrequency,
      annualGasCostUSD: annualRebalanceCost,
      trackingErrorBps,
      netEconomicDragUSD: netDrag,
      isParetoOptimal: false, // set after pass
    });
  }

  for (const res of results) {
    if (res.deviationThresholdPercent === bestThreshold) {
      res.isParetoOptimal = true;
    }
  }

  return results;
}

/**
 * Models DEX liquidity fragmentation across Base trading venues for B20 tokens.
 */
export function modelLiquidityFragmentation(): LiquidityFragmentationModel[] {
  return [
    {
      venue: "Aerodrome Slipstream",
      poolTVLUSD: 14_500_000,
      effectiveSpreadBps: 8,
      depthFor100kTradeUSD: 120_000,
      simulatedPriceImpactPercent: 0.12,
    },
    {
      venue: "Uniswap v3 Base",
      poolTVLUSD: 8_200_000,
      effectiveSpreadBps: 12,
      depthFor100kTradeUSD: 75_000,
      simulatedPriceImpactPercent: 0.24,
    },
    {
      venue: "PancakeSwap v3 Base",
      poolTVLUSD: 2_100_000,
      effectiveSpreadBps: 25,
      depthFor100kTradeUSD: 30_000,
      simulatedPriceImpactPercent: 0.65,
    },
  ];
}
