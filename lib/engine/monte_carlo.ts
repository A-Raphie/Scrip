/**
 * @file monte_carlo.ts
 * @notice Correlated Multi-Asset Monte Carlo Simulation Engine for Weft Index.
 * Implements Cholesky matrix factorisation, Geometric Brownian Motion (GBM) with jump-diffusion,
 * antithetic variate variance reduction, and historical financial stress testing.
 */

import { computeShrinkageCovariance, AssetReturnSeries } from "./portfolio_math";

export interface SimulationParams {
  numSimulations: number; // e.g. 5,000 to 20,000 paths
  horizonDays: number; // e.g. 30, 90, 365
  timeStepDays: number; // typically 1.0 day
  driftAnnualized: number[]; // Annual drift per asset
  volatilityAnnualized: number[]; // Annual vol per asset
  covarianceMatrix: number[][]; // Asset covariance matrix
  initialPrices: number[]; // Current asset prices
  weights: number[]; // Portfolio weights
  enableJumpDiffusion?: boolean;
  jumpIntensity?: number; // Poisson jump arrivals per year (e.g. 2.0)
  jumpMean?: number; // Mean jump size (e.g. -0.05 for negative tail shocks)
  jumpStd?: number; // Standard deviation of jump size (e.g. 0.10)
}

export interface SimulationSummary {
  horizonDays: number;
  initialNAV: number;
  expectedTerminalNAV: number;
  medianTerminalNAV: number;
  percentile5th: number;
  percentile25th: number;
  percentile75th: number;
  percentile95th: number;
  probabilityOfLoss: number;
  probabilityOfOutperformance: number; // NAV gain > 15%
  maxDrawdownDistribution: {
    mean: number;
    p95: number;
    worst: number;
  };
  samplePaths: number[][]; // 10 representative paths for visualization
}

export interface StressScenarioResult {
  scenarioName: string;
  description: string;
  shockDurationDays: number;
  simulatedDrawdown: number;
  rebalanceRequired: boolean;
  estimatedRebalanceCostUSD: number;
  postShockRecoveryDays: number;
}

/**
 * Performs Cholesky Decomposition L of positive semi-definite matrix A such that A = L * L^T.
 * Used to correlate independent standard normal random variables across basket assets.
 */
export function choleskyDecomposition(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }

      if (i === j) {
        const val = matrix[i][i] - sum;
        // Floor at 1e-12 to prevent numeric NaN on slight singular values
        L[i][j] = Math.sqrt(Math.max(1e-12, val));
      } else {
        if (L[j][j] === 0) {
          L[i][j] = 0;
        } else {
          L[i][j] = (matrix[i][j] - sum) / L[j][j];
        }
      }
    }
  }

  return L;
}

/**
 * Standard Box-Muller transform generating two independent standard normal random numbers N(0,1).
 */
export function generateStandardNormals(): [number, number] {
  let u1 = 0;
  let u2 = 0;
  while (u1 <= 1e-15) u1 = Math.random();
  while (u2 <= 1e-15) u2 = Math.random();

  const radius = Math.sqrt(-2.0 * Math.log(u1));
  const theta = 2.0 * Math.PI * u2;

  return [radius * Math.cos(theta), radius * Math.sin(theta)];
}

/**
 * Generates an array of n independent standard normal variables.
 */
export function generateNormalVector(dimension: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < dimension; i += 2) {
    const [z1, z2] = generateStandardNormals();
    result.push(z1);
    if (result.length < dimension) {
      result.push(z2);
    }
  }
  return result;
}

/**
 * Correlates an independent normal vector Z using the Cholesky factor L: X = L * Z.
 */
export function correlateNormals(L: number[][], Z: number[]): number[] {
  const n = L.length;
  const X: number[] = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j <= i; j++) {
      sum += L[i][j] * Z[j];
    }
    X[i] = sum;
  }
  return X;
}

/**
 * Poisson random number generator with rate lambda using Knuth algorithm.
 */
export function samplePoisson(lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1.0;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

/**
 * Runs a multi-asset Monte Carlo simulation with Antithetic Variates for variance reduction.
 */
export function runPortfolioMonteCarlo(params: SimulationParams): SimulationSummary {
  const {
    numSimulations,
    horizonDays,
    timeStepDays,
    driftAnnualized,
    volatilityAnnualized,
    covarianceMatrix,
    initialPrices,
    weights,
    enableJumpDiffusion = false,
    jumpIntensity = 1.5,
    jumpMean = -0.04,
    jumpStd = 0.08,
  } = params;

  const numAssets = initialPrices.length;
  const dt = timeStepDays / 252.0;
  const sqrtDt = Math.sqrt(dt);
  const steps = Math.ceil(horizonDays / timeStepDays);

  // Compute Cholesky factor of daily covariance matrix
  // Scale covariance to time step
  const scaledCov: number[][] = covarianceMatrix.map((row) =>
    row.map((val) => val * (timeStepDays / 252.0))
  );
  const L = choleskyDecomposition(scaledCov);

  // Initial portfolio NAV
  let initialNAV = 0;
  for (let i = 0; i < numAssets; i++) {
    initialNAV += weights[i] * initialPrices[i];
  }

  const terminalNAVs: number[] = [];
  const maxDrawdowns: number[] = [];
  const representativePaths: number[][] = [];

  // Half the runs using antithetic pairs (Z and -Z)
  const halfRuns = Math.ceil(numSimulations / 2);

  for (let sim = 0; sim < halfRuns; sim++) {
    // Two parallel paths for antithetic pair
    const pricesA = [...initialPrices];
    const pricesB = [...initialPrices];
    const pathA: number[] = [initialNAV];
    const pathB: number[] = [initialNAV];

    let peakA = initialNAV;
    let peakB = initialNAV;
    let maxDdA = 0;
    let maxDdB = 0;

    for (let step = 0; step < steps; step++) {
      const zIndependent = generateNormalVector(numAssets);
      // Antithetic vector
      const zAntithetic = zIndependent.map((v) => -v);

      const correlatedA = correlateNormals(L, zIndependent);
      const correlatedB = correlateNormals(L, zAntithetic);

      let currentNavA = 0;
      let currentNavB = 0;

      for (let i = 0; i < numAssets; i++) {
        const drift = (driftAnnualized[i] - 0.5 * Math.pow(volatilityAnnualized[i], 2)) * dt;

        // Jump component
        let jumpA = 0;
        let jumpB = 0;
        if (enableJumpDiffusion) {
          const jumpsCountA = samplePoisson(jumpIntensity * dt);
          for (let j = 0; j < jumpsCountA; j++) {
            const [jZ] = generateStandardNormals();
            jumpA += jumpMean + jumpStd * jZ;
          }
          const jumpsCountB = samplePoisson(jumpIntensity * dt);
          for (let j = 0; j < jumpsCountB; j++) {
            const [jZ] = generateStandardNormals();
            jumpB += jumpMean + jumpStd * jZ;
          }
        }

        // Price updates
        pricesA[i] *= Math.exp(drift + correlatedA[i] + jumpA);
        pricesB[i] *= Math.exp(drift + correlatedB[i] + jumpB);

        currentNavA += weights[i] * pricesA[i];
        currentNavB += weights[i] * pricesB[i];
      }

      pathA.push(currentNavA);
      pathB.push(currentNavB);

      // Track peak and drawdown
      if (currentNavA > peakA) peakA = currentNavA;
      const ddA = (peakA - currentNavA) / peakA;
      if (ddA > maxDdA) maxDdA = ddA;

      if (currentNavB > peakB) peakB = currentNavB;
      const ddB = (peakB - currentNavB) / peakB;
      if (ddB > maxDdB) maxDdB = ddB;
    }

    terminalNAVs.push(pathA[pathA.length - 1]);
    terminalNAVs.push(pathB[pathB.length - 1]);
    maxDrawdowns.push(maxDdA);
    maxDrawdowns.push(maxDdB);

    // Collect 10 representative paths
    if (representativePaths.length < 10) {
      representativePaths.push(pathA);
      if (representativePaths.length < 10) {
        representativePaths.push(pathB);
      }
    }
  }

  // Statistics calculation
  terminalNAVs.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const nTotal = terminalNAVs.length;
  const sumNAV = terminalNAVs.reduce((acc, v) => acc + v, 0);
  const expectedTerminalNAV = sumNAV / nTotal;

  const p5Idx = Math.floor(0.05 * nTotal);
  const p25Idx = Math.floor(0.25 * nTotal);
  const p50Idx = Math.floor(0.50 * nTotal);
  const p75Idx = Math.floor(0.75 * nTotal);
  const p95Idx = Math.floor(0.95 * nTotal);

  const lossCount = terminalNAVs.filter((nav) => nav < initialNAV).length;
  const outperformCount = terminalNAVs.filter((nav) => nav >= initialNAV * 1.15).length;

  const meanDD = maxDrawdowns.reduce((acc, v) => acc + v, 0) / nTotal;
  const p95DD = maxDrawdowns[Math.floor(0.95 * nTotal)];
  const worstDD = maxDrawdowns[nTotal - 1];

  return {
    horizonDays,
    initialNAV,
    expectedTerminalNAV,
    medianTerminalNAV: terminalNAVs[p50Idx],
    percentile5th: terminalNAVs[p5Idx],
    percentile25th: terminalNAVs[p25Idx],
    percentile75th: terminalNAVs[p75Idx],
    percentile95th: terminalNAVs[p95Idx],
    probabilityOfLoss: lossCount / nTotal,
    probabilityOfOutperformance: outperformCount / nTotal,
    maxDrawdownDistribution: {
      mean: meanDD,
      p95: p95DD,
      worst: worstDD,
    },
    samplePaths: representativePaths,
  };
}

/**
 * Historical stress test models simulating historical market crises on Weft portfolio.
 */
export function executeHistoricalStressTests(
  currentPrices: Record<string, number>,
  weights: Record<string, number>,
  portfolioAUMUSD = 1_000_000
): StressScenarioResult[] {
  const scenarios: Array<{
    name: string;
    description: string;
    durationDays: number;
    shocks: Record<string, number>; // Percentage shock per ticker
    generalMarketShock: number;
  }> = [
    {
      name: "2008 Global Financial Crisis (Lehman Shock)",
      description: "Severe credit contraction, banking contagion, and systemic liquidity collapse.",
      durationDays: 60,
      generalMarketShock: -0.42,
      shocks: {
        MSFT: -0.38,
        AAPL: -0.44,
        GOOGL: -0.40,
        AMZN: -0.32,
        NVDA: -0.55,
        META: -0.45,
        TSLA: -0.50,
      },
    },
    {
      name: "2020 COVID Liquidity Flash Shock",
      description: "Violent 4-week compressed selloff with historic VIX spike to 82.",
      durationDays: 22,
      generalMarketShock: -0.34,
      shocks: {
        MSFT: -0.28,
        AAPL: -0.31,
        GOOGL: -0.33,
        AMZN: -0.15,
        NVDA: -0.37,
        META: -0.35,
        TSLA: -0.48,
      },
    },
    {
      name: "2022 Tech Valuation Multiple Compression",
      description: "Aggressive Fed 500bps rate tightening cycle with long-duration tech selloff.",
      durationDays: 180,
      generalMarketShock: -0.31,
      shocks: {
        MSFT: -0.28,
        AAPL: -0.26,
        GOOGL: -0.39,
        AMZN: -0.49,
        NVDA: -0.50,
        META: -0.64,
        TSLA: -0.65,
      },
    },
    {
      name: "2024 Tech Concentration & Chip Cycle Correction",
      description: "Sudden AI capex pause causing semiconductor and cloud supplier pullback.",
      durationDays: 14,
      generalMarketShock: -0.16,
      shocks: {
        NVDA: -0.28,
        MSFT: -0.14,
        GOOGL: -0.15,
        AMZN: -0.12,
        AAPL: -0.09,
        META: -0.15,
        TSLA: -0.18,
      },
    },
  ];

  return scenarios.map((scenario) => {
    let postShockAUM = 0;
    let preShockAUM = portfolioAUMUSD;
    let maxWeightDeviation = 0;

    for (const [ticker, weight] of Object.entries(weights)) {
      const assetAUM = preShockAUM * weight;
      const shock = scenario.shocks[ticker] ?? scenario.generalMarketShock;
      const postAssetAUM = assetAUM * (1 + shock);
      postShockAUM += postAssetAUM;
    }

    const portfolioDrawdown = (preShockAUM - postShockAUM) / preShockAUM;

    // Check post-shock weight deviations to determine if rebalance is triggered (> 5% deviation)
    for (const [ticker, weight] of Object.entries(weights)) {
      const assetAUM = preShockAUM * weight;
      const shock = scenario.shocks[ticker] ?? scenario.generalMarketShock;
      const postAssetAUM = assetAUM * (1 + shock);
      const newWeight = postAssetAUM / postShockAUM;
      const deviation = Math.abs(newWeight - weight);
      if (deviation > maxWeightDeviation) {
        maxWeightDeviation = deviation;
      }
    }

    const rebalanceRequired = maxWeightDeviation >= 0.05;
    // Estimated swap cost on Aerodrome/Uniswap Base: 0.15% fee + 0.10% price impact
    const rebalanceVolume = rebalanceRequired ? postShockAUM * maxWeightDeviation : 0;
    const estimatedRebalanceCostUSD = rebalanceVolume * 0.0025;

    return {
      scenarioName: scenario.name,
      description: scenario.description,
      shockDurationDays: scenario.durationDays,
      simulatedDrawdown: portfolioDrawdown,
      rebalanceRequired,
      estimatedRebalanceCostUSD,
      postShockRecoveryDays: Math.round(scenario.durationDays * 2.5),
    };
  });
}
