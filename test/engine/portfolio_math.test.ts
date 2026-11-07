/**
 * @file portfolio_math.test.ts
 * @notice Comprehensive unit tests for Portfolio Math & Modern Portfolio Theory Engine.
 */

import {
  calculateMeanReturn,
  calculateVarianceAndVol,
  calculateDownsideDeviation,
  calculateDrawdownMetrics,
  calculateHistoricalVaR,
  calculateParametricVaR,
  computeCovarianceMatrix,
  computeShrinkageCovariance,
  calculatePortfolioRiskReturn,
  evaluatePortfolioMetrics,
  generateEfficientFrontier,
  AssetReturnSeries,
} from "../../lib/engine/portfolio_math";

describe("Portfolio Math Analytics Suite", () => {
  const sampleReturnsA = [0.01, -0.02, 0.015, 0.005, -0.01, 0.02, -0.005, 0.018];
  const sampleReturnsB = [0.008, -0.015, 0.012, 0.002, -0.008, 0.015, -0.004, 0.014];

  test("calculates mean return correctly", () => {
    const mean = calculateMeanReturn(sampleReturnsA);
    expect(mean).toBeCloseTo(0.004125, 5);
  });

  test("calculates variance and volatility with sample degrees of freedom", () => {
    const { variance, volatility } = calculateVarianceAndVol(sampleReturnsA);
    expect(variance).toBeGreaterThan(0);
    expect(volatility).toBe(Math.sqrt(variance));
  });

  test("calculates downside deviation below 0 target", () => {
    const downDev = calculateDownsideDeviation(sampleReturnsA, 0);
    expect(downDev).toBeGreaterThan(0);
    // Downside deviation should be strictly less than or equal to total standard deviation
    const { volatility } = calculateVarianceAndVol(sampleReturnsA);
    expect(downDev).toBeLessThanOrEqual(volatility);
  });

  test("calculates max drawdown and peak/trough series accurately", () => {
    const sequence = [0.10, -0.20, 0.05, -0.10];
    const { maxDrawdown, peakIndex, troughIndex, drawdownSeries } = calculateDrawdownMetrics(sequence);
    expect(maxDrawdown).toBeGreaterThan(0.20);
    expect(drawdownSeries.length).toBe(sequence.length);
    expect(troughIndex).toBeGreaterThanOrEqual(peakIndex);
  });

  test("calculates historical Value at Risk and Expected Shortfall (CVaR)", () => {
    const series = [-0.05, -0.03, -0.02, -0.01, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06];
    const { var: var95, cvar: cvar95 } = calculateHistoricalVaR(series, 0.90);
    expect(var95).toBeGreaterThanOrEqual(0.03);
    expect(cvar95).toBeGreaterThanOrEqual(var95); // CVaR is always >= VaR
  });

  test("calculates parametric Gaussian VaR and CVaR", () => {
    const { var: var95, cvar: cvar95 } = calculateParametricVaR(0.0005, 0.015, 0.95);
    expect(var95).toBeGreaterThan(0);
    expect(cvar95).toBeGreaterThan(var95);
  });

  test("computes symmetric covariance and correlation matrix", () => {
    const seriesA: AssetReturnSeries = {
      ticker: "NVDA",
      returns: sampleReturnsA,
      timestamps: [1, 2, 3, 4, 5, 6, 7, 8],
    };
    const seriesB: AssetReturnSeries = {
      ticker: "AAPL",
      returns: sampleReturnsB,
      timestamps: [1, 2, 3, 4, 5, 6, 7, 8],
    };

    const res = computeCovarianceMatrix([seriesA, seriesB]);
    expect(res.tickers).toEqual(["NVDA", "AAPL"]);
    expect(res.covarianceMatrix[0][1]).toBeCloseTo(res.covarianceMatrix[1][0], 8);
    expect(res.correlationMatrix[0][0]).toBeCloseTo(1.0, 5);
    expect(res.correlationMatrix[1][1]).toBeCloseTo(1.0, 5);
    expect(res.correlationMatrix[0][1]).toBeGreaterThan(0.9); // High correlation
  });

  test("computes Ledoit-Wolf shrinkage covariance without singularity", () => {
    const seriesA: AssetReturnSeries = { ticker: "NVDA", returns: sampleReturnsA, timestamps: [1, 2, 3, 4, 5, 6, 7, 8] };
    const seriesB: AssetReturnSeries = { ticker: "AAPL", returns: sampleReturnsB, timestamps: [1, 2, 3, 4, 5, 6, 7, 8] };

    const result = computeShrinkageCovariance([seriesA, seriesB]);
    expect(result.shrinkageIntensity).toBeGreaterThan(0);
    expect(result.shrunkCovariance.length).toBe(2);
    // Diagonal elements should remain strictly positive
    expect(result.shrunkCovariance[0][0]).toBeGreaterThan(0);
    expect(result.shrunkCovariance[1][1]).toBeGreaterThan(0);
  });

  test("evaluates full portfolio risk metrics including Sharpe and Sortino", () => {
    const seriesA: AssetReturnSeries = { ticker: "NVDA", returns: sampleReturnsA, timestamps: [1, 2, 3, 4, 5, 6, 7, 8] };
    const seriesB: AssetReturnSeries = { ticker: "AAPL", returns: sampleReturnsB, timestamps: [1, 2, 3, 4, 5, 6, 7, 8] };

    const metrics = evaluatePortfolioMetrics(
      { NVDA: 0.6, AAPL: 0.4 },
      [seriesA, seriesB],
      0.04
    );

    expect(metrics.annualizedVolatility).toBeGreaterThan(0);
    expect(metrics.var95).toBeGreaterThanOrEqual(0);
    expect(metrics.cvar95).toBeGreaterThanOrEqual(metrics.var95);
  });

  test("generates Monte Carlo efficient frontier points with optimal boundaries", () => {
    const seriesA: AssetReturnSeries = { ticker: "NVDA", returns: sampleReturnsA, timestamps: [1, 2, 3, 4, 5, 6, 7, 8] };
    const seriesB: AssetReturnSeries = { ticker: "AAPL", returns: sampleReturnsB, timestamps: [1, 2, 3, 4, 5, 6, 7, 8] };

    const frontier = generateEfficientFrontier([seriesA, seriesB], 200, 0.04);
    expect(frontier.frontierPoints.length).toBe(200);
    expect(frontier.maxSharpePoint.sharpeRatio).toBeGreaterThanOrEqual(frontier.minVolPoint.sharpeRatio);
    expect(frontier.minVolPoint.volatility).toBeLessThanOrEqual(frontier.maxSharpePoint.volatility);
  });
});
