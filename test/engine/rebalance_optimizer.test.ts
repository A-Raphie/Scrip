/**
 * @file rebalance_optimizer.test.ts
 * @notice Unit tests for Quadratic Programming rebalancer, transaction fee penalties, and order generation.
 */

import {
  calculateCurrentWeights,
  calculateTurnoverDeviation,
  optimizeRebalancePlan,
  AssetPosition,
} from "../../lib/engine/rebalance_optimizer";

describe("Rebalance Optimizer Engine Suite", () => {
  const positions: AssetPosition[] = [
    {
      ticker: "NVDA",
      currentUnits: 100n * 10n ** 18n,
      currentPriceUSD: 135.0, // $13,500 (approx 54%)
      targetWeight: 0.30,
      minWeightBound: 0.10,
      maxWeightBound: 0.50,
    },
    {
      ticker: "AAPL",
      currentUnits: 50n * 10n ** 18n,
      currentPriceUSD: 230.0, // $11,500 (approx 46%)
      targetWeight: 0.70,
      minWeightBound: 0.30,
      maxWeightBound: 0.85,
    },
  ];

  test("calculates current portfolio weights and total AUM accurately", () => {
    const { totalAUMUSD, currentWeights } = calculateCurrentWeights(positions);
    expect(totalAUMUSD).toBeCloseTo(25_000, 2);
    expect(currentWeights["NVDA"] + currentWeights["AAPL"]).toBeCloseTo(1.0, 5);
    expect(currentWeights["NVDA"]).toBeGreaterThan(currentWeights["AAPL"]);
  });

  test("computes turnover absolute deviation between current and target weights", () => {
    const { currentWeights } = calculateCurrentWeights(positions);
    const deviation = calculateTurnoverDeviation(currentWeights, positions);
    // Current is ~54% vs 30% target -> drift is ~24%
    expect(deviation).toBeGreaterThan(0.20);
  });

  test("generates rebalancing orders when drift exceeds threshold", () => {
    const plan = optimizeRebalancePlan(positions, 0.005, 0.025, 0.35);

    expect(plan.requiresExecution).toBe(true);
    expect(plan.orders.length).toBe(2);

    const nvdaOrder = plan.orders.find((o) => o.ticker === "NVDA");
    const aaplOrder = plan.orders.find((o) => o.ticker === "AAPL");

    expect(nvdaOrder?.action).toBe("SELL");
    expect(aaplOrder?.action).toBe("BUY");
    expect(plan.postTurnoverWeightedDeviation).toBeLessThan(plan.preTurnoverWeightedDeviation);
    expect(plan.netRebalanceCostUSD).toBeGreaterThan(0);
  });

  test("skips execution when portfolio drift is within tolerance band", () => {
    // Modify positions so they are very close to target weights
    const balancedPositions: AssetPosition[] = [
      {
        ticker: "NVDA",
        currentUnits: 100n * 10n ** 18n,
        currentPriceUSD: 100.0, // $10,000 (50%)
        targetWeight: 0.50,
        minWeightBound: 0.20,
        maxWeightBound: 0.80,
      },
      {
        ticker: "AAPL",
        currentUnits: 100n * 10n ** 18n,
        currentPriceUSD: 100.0, // $10,000 (50%)
        targetWeight: 0.50,
        minWeightBound: 0.20,
        maxWeightBound: 0.80,
      },
    ];

    const plan = optimizeRebalancePlan(balancedPositions, 0.005, 0.025, 0.35);
    expect(plan.requiresExecution).toBe(false);
    expect(plan.orders.length).toBe(0);
    expect(plan.netRebalanceCostUSD).toBe(0);
  });
});
