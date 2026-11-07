/**
 * @file portfolio_math.ts
 * @notice Advanced Modern Portfolio Theory (MPT) & Quantitative Risk Analytics Engine for Weft Index.
 * Computes portfolio weights, risk-adjusted returns, covariance matrices with shrinkage,
 * Value at Risk (VaR), Conditional VaR (CVaR), and efficient frontier allocations.
 */

export interface AssetReturnSeries {
  ticker: string;
  returns: number[]; // Daily log returns
  timestamps: number[];
}

export interface PortfolioRiskMetrics {
  annualizedReturn: number;
  annualizedVolatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  treynorRatio?: number;
  var95: number;
  cvar95: number;
  var99: number;
  cvar99: number;
  maxDrawdown: number;
  downsideDeviation: number;
  trackingError?: number;
  informationRatio?: number;
}

export interface EfficientFrontierPoint {
  expectedReturn: number;
  volatility: number;
  sharpeRatio: number;
  weights: Record<string, number>;
}

export interface CovarianceResult {
  tickers: string[];
  sampleCovariance: number[][];
  shrunkCovariance: number[][];
  correlationMatrix: number[][];
  shrinkageIntensity: number;
}

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Calculates mean (expected) return for an asset return series.
 */
export function calculateMeanReturn(returns: number[]): number {
  if (returns.length === 0) return 0;
  const sum = returns.reduce((acc, val) => acc + val, 0);
  return sum / returns.length;
}

/**
 * Calculates sample variance and standard deviation (volatility).
 */
export function calculateVarianceAndVol(returns: number[]): { variance: number; volatility: number } {
  if (returns.length < 2) return { variance: 0, volatility: 0 };
  const mean = calculateMeanReturn(returns);
  const sumSquaredDiffs = returns.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
  const variance = sumSquaredDiffs / (returns.length - 1);
  return {
    variance,
    volatility: Math.sqrt(variance),
  };
}

/**
 * Calculates downside deviation (semi-variance) below a target return (typically 0 or risk-free rate).
 */
export function calculateDownsideDeviation(returns: number[], targetReturn = 0): number {
  if (returns.length === 0) return 0;
  const underperformances = returns.map((r) => Math.min(0, r - targetReturn));
  const sumSquares = underperformances.reduce((acc, val) => acc + Math.pow(val, 2), 0);
  return Math.sqrt(sumSquares / returns.length);
}

/**
 * Computes maximum drawdown and peak-to-trough series from asset or portfolio returns.
 */
export function calculateDrawdownMetrics(returns: number[]): {
  maxDrawdown: number;
  peakIndex: number;
  troughIndex: number;
  drawdownSeries: number[];
} {
  if (returns.length === 0) {
    return { maxDrawdown: 0, peakIndex: 0, troughIndex: 0, drawdownSeries: [] };
  }

  const drawdownSeries: number[] = [];
  let cumulative = 1.0;
  let peak = 1.0;
  let peakIdx = 0;
  let troughIdx = 0;
  let currentPeakIdx = 0;
  let maxDd = 0.0;

  for (let i = 0; i < returns.length; i++) {
    cumulative *= 1 + returns[i];
    if (cumulative > peak) {
      peak = cumulative;
      currentPeakIdx = i;
    }
    const currentDrawdown = (peak - cumulative) / peak;
    drawdownSeries.push(currentDrawdown);

    if (currentDrawdown > maxDd) {
      maxDd = currentDrawdown;
      peakIdx = currentPeakIdx;
      troughIdx = i;
    }
  }

  return {
    maxDrawdown: maxDd,
    peakIndex: peakIdx,
    troughIndex: troughIdx,
    drawdownSeries,
  };
}

/**
 * Computes historical Value at Risk (VaR) and Conditional VaR (Expected Shortfall).
 * @param returns Array of historical daily portfolio returns
 * @param confidenceLevel E.g., 0.95 for 95% confidence or 0.99 for 99%
 */
export function calculateHistoricalVaR(
  returns: number[],
  confidenceLevel = 0.95
): { var: number; cvar: number } {
  if (returns.length === 0) return { var: 0, cvar: 0 };
  const sorted = [...returns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidenceLevel) * sorted.length);
  const cutoffIndex = Math.max(0, Math.min(index, sorted.length - 1));

  // VaR is expressed as a positive loss percentage
  const varValue = -sorted[cutoffIndex];

  // CVaR is the average loss of all returns below the VaR cutoff
  const tailLosses = sorted.slice(0, cutoffIndex + 1);
  const avgTailLoss = tailLosses.length > 0
    ? tailLosses.reduce((acc, val) => acc + val, 0) / tailLosses.length
    : sorted[0];

  return {
    var: Math.max(0, varValue),
    cvar: Math.max(0, -avgTailLoss),
  };
}

/**
 * Computes parametric (Gaussian) Value at Risk and CVaR.
 */
export function calculateParametricVaR(
  meanDailyReturn: number,
  dailyVol: number,
  confidenceLevel = 0.95
): { var: number; cvar: number } {
  // Z-scores for standard confidence intervals
  let zScore = 1.64485; // 95%
  let pdfAtZ = 0.1031;  // standard normal PDF at 1.645
  if (confidenceLevel >= 0.99) {
    zScore = 2.32635; // 99%
    pdfAtZ = 0.0266;
  } else if (confidenceLevel <= 0.90) {
    zScore = 1.28155; // 90%
    pdfAtZ = 0.1755;
  }

  const alpha = 1 - confidenceLevel;
  const varParametric = -(meanDailyReturn - zScore * dailyVol);
  const cvarParametric = -(meanDailyReturn - dailyVol * (pdfAtZ / alpha));

  return {
    var: Math.max(0, varParametric),
    cvar: Math.max(0, cvarParametric),
  };
}

/**
 * Computes the sample covariance matrix and Pearson correlation matrix for multiple assets.
 */
export function computeCovarianceMatrix(seriesList: AssetReturnSeries[]): {
  tickers: string[];
  covarianceMatrix: number[][];
  correlationMatrix: number[][];
  meanReturns: number[];
} {
  const n = seriesList.length;
  if (n === 0) return { tickers: [], covarianceMatrix: [], correlationMatrix: [], meanReturns: [] };

  const tickers = seriesList.map((s) => s.ticker);
  const minLength = Math.min(...seriesList.map((s) => s.returns.length));
  const means: number[] = [];

  for (let i = 0; i < n; i++) {
    const trimmed = seriesList[i].returns.slice(0, minLength);
    means.push(calculateMeanReturn(trimmed));
  }

  const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const corr: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sumProduct = 0;
      for (let t = 0; t < minLength; t++) {
        sumProduct += (seriesList[i].returns[t] - means[i]) * (seriesList[j].returns[t] - means[j]);
      }
      const covValue = sumProduct / (minLength - 1);
      cov[i][j] = covValue;
      cov[j][i] = covValue;
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const volI = Math.sqrt(cov[i][i]);
      const volJ = Math.sqrt(cov[j][j]);
      corr[i][j] = volI > 0 && volJ > 0 ? cov[i][j] / (volI * volJ) : (i === j ? 1 : 0);
    }
  }

  return {
    tickers,
    covarianceMatrix: cov,
    correlationMatrix: corr,
    meanReturns: means,
  };
}

/**
 * Computes Ledoit-Wolf Shrinkage covariance matrix towards constant correlation target.
 * Reduces estimation error for high-dimensional baskets like B20.
 */
export function computeShrinkageCovariance(seriesList: AssetReturnSeries[]): CovarianceResult {
  const { tickers, covarianceMatrix, correlationMatrix } = computeCovarianceMatrix(seriesList);
  const n = tickers.length;
  const t = Math.min(...seriesList.map((s) => s.returns.length));

  if (n <= 1 || t <= 2) {
    return {
      tickers,
      sampleCovariance: covarianceMatrix,
      shrunkCovariance: covarianceMatrix,
      correlationMatrix,
      shrinkageIntensity: 0,
    };
  }

  // Calculate average correlation across off-diagonal elements
  let sumCorr = 0;
  let countCorr = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sumCorr += correlationMatrix[i][j];
      countCorr++;
    }
  }
  const avgCorr = countCorr > 0 ? sumCorr / countCorr : 0;

  // Target shrinkage matrix F = avgCorr * sqrt(cov_ii * cov_jj)
  const targetF: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        targetF[i][j] = covarianceMatrix[i][j];
      } else {
        targetF[i][j] = avgCorr * Math.sqrt(covarianceMatrix[i][i] * covarianceMatrix[j][j]);
      }
    }
  }

  // Estimate shrinkage intensity constant delta
  let sumSampleVarianceDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumSampleVarianceDiff += Math.pow(covarianceMatrix[i][j] - targetF[i][j], 2);
    }
  }

  // Default optimal shrinkage heuristic delta ~ 0.20 for daily equity returns
  const delta = Math.min(1.0, Math.max(0.05, (n / t) * 0.4));

  const shrunkCovariance: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      shrunkCovariance[i][j] = (1 - delta) * covarianceMatrix[i][j] + delta * targetF[i][j];
    }
  }

  return {
    tickers,
    sampleCovariance: covarianceMatrix,
    shrunkCovariance,
    correlationMatrix,
    shrinkageIntensity: delta,
  };
}

/**
 * Calculates portfolio return and volatility given an array of weights and covariance matrix.
 */
export function calculatePortfolioRiskReturn(
  weights: number[],
  meanReturns: number[],
  covMatrix: number[][]
): { expectedReturn: number; volatility: number; annualizedReturn: number; annualizedVolatility: number } {
  const n = weights.length;
  let dailyExpectedReturn = 0;
  for (let i = 0; i < n; i++) {
    dailyExpectedReturn += weights[i] * meanReturns[i];
  }

  let dailyVariance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      dailyVariance += weights[i] * weights[j] * covMatrix[i][j];
    }
  }

  const dailyVol = Math.sqrt(Math.max(0, dailyVariance));
  const annualizedReturn = dailyExpectedReturn * TRADING_DAYS_PER_YEAR;
  const annualizedVolatility = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);

  return {
    expectedReturn: dailyExpectedReturn,
    volatility: dailyVol,
    annualizedReturn,
    annualizedVolatility,
  };
}

/**
 * Computes full risk metrics suite for a portfolio.
 */
export function evaluatePortfolioMetrics(
  weights: Record<string, number>,
  seriesList: AssetReturnSeries[],
  riskFreeRate = 0.045, // 4.5% annual risk-free rate
  benchmarkSeries?: AssetReturnSeries
): PortfolioRiskMetrics {
  const tickers = seriesList.map((s) => s.ticker);
  const minLength = Math.min(...seriesList.map((s) => s.returns.length));
  const weightArray = tickers.map((t) => weights[t] || 0);

  // Normalize weights to sum to 1
  const sumW = weightArray.reduce((acc, v) => acc + v, 0);
  const normalizedWeights = sumW > 0 ? weightArray.map((w) => w / sumW) : weightArray;

  // Construct synthetic historical portfolio daily return series
  const portfolioReturns: number[] = [];
  for (let t = 0; t < minLength; t++) {
    let dayReturn = 0;
    for (let i = 0; i < seriesList.length; i++) {
      dayReturn += normalizedWeights[i] * seriesList[i].returns[t];
    }
    portfolioReturns.push(dayReturn);
  }

  const meanDailyReturn = calculateMeanReturn(portfolioReturns);
  const { volatility: dailyVol } = calculateVarianceAndVol(portfolioReturns);
  const annualizedReturn = meanDailyReturn * TRADING_DAYS_PER_YEAR;
  const annualizedVol = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);

  const dailyRf = riskFreeRate / TRADING_DAYS_PER_YEAR;
  const excessReturn = annualizedReturn - riskFreeRate;
  const sharpeRatio = annualizedVol > 0 ? excessReturn / annualizedVol : 0;

  const downsideDevDaily = calculateDownsideDeviation(portfolioReturns, dailyRf);
  const annualizedDownsideDev = downsideDevDaily * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const sortinoRatio = annualizedDownsideDev > 0 ? excessReturn / annualizedDownsideDev : 0;

  const { maxDrawdown } = calculateDrawdownMetrics(portfolioReturns);
  const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  const { var: var95, cvar: cvar95 } = calculateHistoricalVaR(portfolioReturns, 0.95);
  const { var: var99, cvar: cvar99 } = calculateHistoricalVaR(portfolioReturns, 0.99);

  // Benchmark comparisons if available
  let trackingError: number | undefined;
  let informationRatio: number | undefined;
  let treynorRatio: number | undefined;

  if (benchmarkSeries && benchmarkSeries.returns.length >= minLength) {
    const diffs: number[] = [];
    let benchmarkMean = 0;
    for (let t = 0; t < minLength; t++) {
      diffs.push(portfolioReturns[t] - benchmarkSeries.returns[t]);
      benchmarkMean += benchmarkSeries.returns[t];
    }
    benchmarkMean /= minLength;

    const { volatility: diffVol } = calculateVarianceAndVol(diffs);
    trackingError = diffVol * Math.sqrt(TRADING_DAYS_PER_YEAR);

    const activeReturn = annualizedReturn - (benchmarkMean * TRADING_DAYS_PER_YEAR);
    informationRatio = trackingError > 0 ? activeReturn / trackingError : 0;

    // Beta calculation
    let covWithBenchmark = 0;
    let benchVar = 0;
    for (let t = 0; t < minLength; t++) {
      covWithBenchmark += (portfolioReturns[t] - meanDailyReturn) * (benchmarkSeries.returns[t] - benchmarkMean);
      benchVar += Math.pow(benchmarkSeries.returns[t] - benchmarkMean, 2);
    }
    const beta = benchVar > 0 ? covWithBenchmark / benchVar : 1.0;
    treynorRatio = beta > 0 ? excessReturn / beta : 0;
  }

  return {
    annualizedReturn,
    annualizedVolatility: annualizedVol,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    treynorRatio,
    var95,
    cvar95,
    var99,
    cvar99,
    maxDrawdown,
    downsideDeviation: annualizedDownsideDev,
    trackingError,
    informationRatio,
  };
}

/**
 * Generates an efficient frontier curve for the portfolio assets using Monte Carlo random dirichlet allocation.
 */
export function generateEfficientFrontier(
  seriesList: AssetReturnSeries[],
  samplePoints = 1000,
  riskFreeRate = 0.045
): {
  frontierPoints: EfficientFrontierPoint[];
  maxSharpePoint: EfficientFrontierPoint;
  minVolPoint: EfficientFrontierPoint;
} {
  const { tickers, shrunkCovariance, meanReturns } = computeShrinkageCovariance(seriesList);
  const n = tickers.length;
  const points: EfficientFrontierPoint[] = [];

  let bestSharpePoint: EfficientFrontierPoint = {
    expectedReturn: -Infinity,
    volatility: Infinity,
    sharpeRatio: -Infinity,
    weights: {},
  };

  let minVolPoint: EfficientFrontierPoint = {
    expectedReturn: 0,
    volatility: Infinity,
    sharpeRatio: 0,
    weights: {},
  };

  // Generate Dirichlet distributed weights
  for (let p = 0; p < samplePoints; p++) {
    const rawWeights: number[] = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      // Exponential distribution generates Dirichlet simplex uniform sampling
      const u = -Math.log(Math.max(1e-10, Math.random()));
      rawWeights.push(u);
      sum += u;
    }
    const normalized = rawWeights.map((w) => w / sum);

    const { annualizedReturn, annualizedVolatility } = calculatePortfolioRiskReturn(
      normalized,
      meanReturns,
      shrunkCovariance
    );

    const excess = annualizedReturn - riskFreeRate;
    const sharpe = annualizedVolatility > 0 ? excess / annualizedVolatility : 0;

    const weightsMap: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      weightsMap[tickers[i]] = normalized[i];
    }

    const pt: EfficientFrontierPoint = {
      expectedReturn: annualizedReturn,
      volatility: annualizedVolatility,
      sharpeRatio: sharpe,
      weights: weightsMap,
    };

    points.push(pt);

    if (sharpe > bestSharpePoint.sharpeRatio) {
      bestSharpePoint = pt;
    }
    if (annualizedVolatility < minVolPoint.volatility) {
      minVolPoint = pt;
    }
  }

  // Sort by volatility ascending
  points.sort((a, b) => a.volatility - b.volatility);

  return {
    frontierPoints: points,
    maxSharpePoint: bestSharpePoint,
    minVolPoint,
  };
}
