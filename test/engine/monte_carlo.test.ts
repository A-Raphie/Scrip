/**
 * @file monte_carlo.test.ts
 * @notice Unit tests for Cholesky decomposition, normal vector correlation, and Monte Carlo engine.
 */

import {
  choleskyDecomposition,
  generateStandardNormals,
  generateNormalVector,
  correlateNormals,
  samplePoisson,
  runPortfolioMonteCarlo,
  executeHistoricalStressTests,
  SimulationParams,
} from "../../lib/engine/monte_carlo";

describe("Monte Carlo Simulation Engine Suite", () => {
  test("computes Cholesky factor L such that L * L^T approximates original covariance matrix", () => {
    // 2x2 positive definite matrix
    const A = [
      [4.0, 1.2],
      [1.2, 9.0],
    ];

    const L = choleskyDecomposition(A);

    // Reconstruct A_hat = L * L^T
    const A_hat = [
      [L[0][0] * L[0][0] + L[0][1] * L[0][1], L[0][0] * L[1][0] + L[0][1] * L[1][1]],
      [L[1][0] * L[0][0] + L[1][1] * L[0][1], L[1][0] * L[1][0] + L[1][1] * L[1][1]],
    ];

    expect(A_hat[0][0]).toBeCloseTo(A[0][0], 4);
    expect(A_hat[0][1]).toBeCloseTo(A[0][1], 4);
    expect(A_hat[1][0]).toBeCloseTo(A[1][0], 4);
    expect(A_hat[1][1]).toBeCloseTo(A[1][1], 4);
  });

  test("generates standard normal random numbers with finite real bounds", () => {
    const [z1, z2] = generateStandardNormals();
    expect(Number.isFinite(z1)).toBe(true);
    expect(Number.isFinite(z2)).toBe(true);
  });

  test("generates normal vectors of requested dimension", () => {
    const vec = generateNormalVector(10);
    expect(vec.length).toBe(10);
    for (const val of vec) {
      expect(Number.isFinite(val)).toBe(true);
    }
  });

  test("correlates normal vectors using Cholesky factor preserving dimension", () => {
    const L = [
      [2.0, 0.0],
      [0.6, 2.94],
    ];
    const Z = [1.0, 1.0];
    const X = correlateNormals(L, Z);

    expect(X.length).toBe(2);
    expect(X[0]).toBeCloseTo(2.0, 5);
    expect(X[1]).toBeCloseTo(3.54, 5);
  });

  test("samples Poisson random variables with non-negative counts", () => {
    for (let i = 0; i < 20; i++) {
      const k = samplePoisson(2.5);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(k)).toBe(true);
    }
  });

  test("executes Monte Carlo multi-path simulation returning valid quantile envelope", () => {
    const params: SimulationParams = {
      numSimulations: 50,
      horizonDays: 30,
      timeStepDays: 1.0,
      driftAnnualized: [0.12, 0.10],
      volatilityAnnualized: [0.25, 0.20],
      covarianceMatrix: [
        [0.0625, 0.025],
        [0.025, 0.04],
      ],
      initialPrices: [100.0, 50.0],
      weights: [0.6, 0.4],
      enableJumpDiffusion: true,
    };

    const summary = runPortfolioMonteCarlo(params);

    expect(summary.initialNAV).toBeCloseTo(80.0, 4); // 0.6*100 + 0.4*50 = 80
    expect(summary.percentile5th).toBeLessThanOrEqual(summary.medianTerminalNAV);
    expect(summary.medianTerminalNAV).toBeLessThanOrEqual(summary.percentile95th);
    expect(summary.samplePaths.length).toBeGreaterThan(0);
    expect(summary.samplePaths[0].length).toBe(31); // 0 to 30 days
  });

  test("executes historical stress scenarios across market crises", () => {
    const currentPrices = { NVDA: 135.0, AAPL: 228.0, MSFT: 425.0 };
    const weights = { NVDA: 0.4, AAPL: 0.3, MSFT: 0.3 };

    const stressReports = executeHistoricalStressTests(currentPrices, weights, 1_000_000);

    expect(stressReports.length).toBe(4);
    for (const report of stressReports) {
      expect(report.simulatedDrawdown).toBeGreaterThan(0.10); // All crises caused > 10% drawdown
      expect(report.postShockRecoveryDays).toBeGreaterThan(0);
    }
  });
});
