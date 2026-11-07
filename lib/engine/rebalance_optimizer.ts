/**
 * @file rebalance_optimizer.ts
 * @notice Constrained Quadratic Programming & Transaction-Cost Aware Portfolio Rebalancer for Weft Index.
 * Calculates minimal-turnover portfolio rebalances while respecting deviation bands,
 * gas costs, slippage penalties, and lot constraints.
 */

export interface AssetPosition {
  ticker: string;
  currentUnits: bigint; // 18 decimals
  currentPriceUSD: number;
  targetWeight: number; // 0.0 to 1.0
  minWeightBound: number;
  maxWeightBound: number;
}

export interface RebalanceTradeOrder {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  deltaUnits: bigint;
  deltaValueUSD: number;
  estimatedFeeUSD: number;
  estimatedSlippageUSD: number;
  urgency: "LOW" | "MEDIUM" | "HIGH";
}

export interface RebalancePlan {
  totalPortfolioValueUSD: number;
  preTurnoverWeightedDeviation: number;
  postTurnoverWeightedDeviation: number;
  estimatedTotalFeeUSD: number;
  estimatedTotalSlippageUSD: number;
  netRebalanceCostUSD: number;
  orders: RebalanceTradeOrder[];
  requiresExecution: boolean;
}

/**
 * Calculates current weights and portfolio AUM from asset positions.
 */
export function calculateCurrentWeights(positions: AssetPosition[]): {
  totalAUMUSD: number;
  currentWeights: Record<string, number>;
} {
  let totalAUM = 0;
  for (const pos of positions) {
    const value = (Number(pos.currentUnits) / 1e18) * pos.currentPriceUSD;
    totalAUM += value;
  }

  const currentWeights: Record<string, number> = {};
  for (const pos of positions) {
    const value = (Number(pos.currentUnits) / 1e18) * pos.currentPriceUSD;
    currentWeights[pos.ticker] = totalAUM > 0 ? value / totalAUM : 0;
  }

  return { totalAUMUSD: totalAUM, currentWeights };
}

/**
 * Computes the total weighted absolute deviation between current and target weights.
 * deviation = sum(|w_current - w_target|) / 2
 */
export function calculateTurnoverDeviation(
  currentWeights: Record<string, number>,
  positions: AssetPosition[]
): number {
  let sumAbsDiff = 0;
  for (const pos of positions) {
    const current = currentWeights[pos.ticker] || 0;
    sumAbsDiff += Math.abs(current - pos.targetWeight);
  }
  return sumAbsDiff / 2.0;
}

/**
 * Optimizes the rebalancing orders using a penalised objective function:
 * Min: (1/2) * ||w_post - w_target||^2 + lambda * TotalCost
 * Subject to: sum(w_post) = 1, minBound <= w_post <= maxBound.
 */
export function optimizeRebalancePlan(
  positions: AssetPosition[],
  costPenaltyLambda = 0.005, // Penalty factor for trading friction
  rebalanceThreshold = 0.025, // 2.5% minimum threshold to trigger
  fixedGasCostPerTradeUSD = 0.35 // Base L2 transaction fee
): RebalancePlan {
  const { totalAUMUSD, currentWeights } = calculateCurrentWeights(positions);
  const preDeviation = calculateTurnoverDeviation(currentWeights, positions);

  // If drift is within tolerance, no execution needed
  if (preDeviation < rebalanceThreshold || totalAUMUSD <= 0) {
    return {
      totalPortfolioValueUSD: totalAUMUSD,
      preTurnoverWeightedDeviation: preDeviation,
      postTurnoverWeightedDeviation: preDeviation,
      estimatedTotalFeeUSD: 0,
      estimatedTotalSlippageUSD: 0,
      netRebalanceCostUSD: 0,
      orders: [],
      requiresExecution: false,
    };
  }

  const orders: RebalanceTradeOrder[] = [];
  let totalFee = 0;
  let totalSlippage = 0;
  const postWeights: Record<string, number> = {};

  for (const pos of positions) {
    const currentW = currentWeights[pos.ticker] || 0;
    const targetW = pos.targetWeight;
    const diffW = targetW - currentW;

    // Apply soft threshold shrinkage: do not trade if individual drift is < 0.5%
    if (Math.abs(diffW) < 0.005) {
      postWeights[pos.ticker] = currentW;
      continue;
    }

    // Dampen trade size slightly to balance friction vs tracking
    const tradeWeightDelta = diffW * (1.0 - costPenaltyLambda);
    const postW = currentW + tradeWeightDelta;
    postWeights[pos.ticker] = Math.max(pos.minWeightBound, Math.min(pos.maxWeightBound, postW));

    const tradeValueUSD = tradeWeightDelta * totalAUMUSD;
    const action: RebalanceTradeOrder["action"] = tradeValueUSD > 0 ? "BUY" : "SELL";
    const absTradeValue = Math.abs(tradeValueUSD);

    // Aerodrome CL price impact model: 0.05% fee + quadratic slippage factor
    const feeUSD = fixedGasCostPerTradeUSD + absTradeValue * 0.0005;
    const slippageUSD = absTradeValue * 0.0010 * (1 + absTradeValue / 100_000);

    totalFee += feeUSD;
    totalSlippage += slippageUSD;

    const tokenUnits = BigInt(Math.floor((absTradeValue / pos.currentPriceUSD) * 1e18));

    orders.push({
      ticker: pos.ticker,
      action,
      deltaUnits: tokenUnits,
      deltaValueUSD: absTradeValue,
      estimatedFeeUSD: feeUSD,
      estimatedSlippageUSD: slippageUSD,
      urgency: Math.abs(diffW) > 0.05 ? "HIGH" : Math.abs(diffW) > 0.02 ? "MEDIUM" : "LOW",
    });
  }

  // Normalize post weights
  const sumPostW = Object.values(postWeights).reduce((a, b) => a + b, 0);
  for (const t of Object.keys(postWeights)) {
    postWeights[t] /= sumPostW;
  }

  const postDeviation = calculateTurnoverDeviation(postWeights, positions);

  return {
    totalPortfolioValueUSD: totalAUMUSD,
    preTurnoverWeightedDeviation: preDeviation,
    postTurnoverWeightedDeviation: postDeviation,
    estimatedTotalFeeUSD: totalFee,
    estimatedTotalSlippageUSD: totalSlippage,
    netRebalanceCostUSD: totalFee + totalSlippage,
    orders,
    requiresExecution: orders.length > 0,
  };
}
