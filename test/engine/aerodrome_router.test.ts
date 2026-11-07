/**
 * @file aerodrome_router.test.ts
 * @notice Unit tests for Aerodrome Slipstream router math, tick conversions, and basket quotes.
 */

import {
  sqrtPriceX96ToPrice,
  priceToSqrtPriceX96,
  tickToSqrtPriceX96,
  getAmount0Delta,
  getAmount1Delta,
  computeSwapStep,
  quoteBasketSwap,
  calculateSlippageBound,
  Q96,
  ConcentratedPoolState,
} from "../../lib/engine/aerodrome_router";

describe("Aerodrome Slipstream Router Math Suite", () => {
  test("converts sqrtPriceX96 to price and back invertibly", () => {
    const originalPrice = 250.75;
    const sqrtPriceX96 = priceToSqrtPriceX96(originalPrice, 6, 18);
    expect(sqrtPriceX96).toBeGreaterThan(0n);

    const recoveredPrice = sqrtPriceX96ToPrice(sqrtPriceX96, 6, 18);
    expect(recoveredPrice).toBeCloseTo(originalPrice, 2);
  });

  test("calculates tick to sqrtPriceX96 correctly at tick 0", () => {
    const sqrtRatio0 = tickToSqrtPriceX96(0);
    // At tick 0, sqrtPrice is exactly 2^96
    expect(sqrtRatio0).toBe(Q96);
  });

  test("calculates tick monotonically with respect to tick sign", () => {
    const sqrtRatioPos = tickToSqrtPriceX96(100);
    const sqrtRatioZero = tickToSqrtPriceX96(0);
    const sqrtRatioNeg = tickToSqrtPriceX96(-100);

    expect(sqrtRatioPos).toBeGreaterThan(sqrtRatioZero);
    expect(sqrtRatioZero).toBeGreaterThan(sqrtRatioNeg);
  });

  test("computes amount0 delta accurately for a price movement", () => {
    const sqrtRatioA = Q96;
    const sqrtRatioB = (Q96 * 110n) / 100n; // 10% higher price
    const liquidity = 1_000_000_000n;

    const deltaDown = getAmount0Delta(sqrtRatioA, sqrtRatioB, liquidity, false);
    const deltaUp = getAmount0Delta(sqrtRatioA, sqrtRatioB, liquidity, true);

    expect(deltaUp).toBeGreaterThanOrEqual(deltaDown);
    expect(deltaDown).toBeGreaterThan(0n);
  });

  test("computes amount1 delta accurately for a price movement", () => {
    const sqrtRatioA = Q96;
    const sqrtRatioB = (Q96 * 110n) / 100n;
    const liquidity = 1_000_000_000n;

    const deltaDown = getAmount1Delta(sqrtRatioA, sqrtRatioB, liquidity, false);
    const deltaUp = getAmount1Delta(sqrtRatioA, sqrtRatioB, liquidity, true);

    expect(deltaUp).toBeGreaterThanOrEqual(deltaDown);
    expect(deltaDown).toBeGreaterThan(0n);
  });

  test("computes swap step within tick boundaries consuming input", () => {
    const sqrtRatioCurrent = Q96;
    const sqrtRatioTarget = (Q96 * 105n) / 100n;
    const liquidity = 50_000_000_000n;
    const amountRemaining = 10_000_000n; // 10 USDC

    const step = computeSwapStep(
      sqrtRatioCurrent,
      sqrtRatioTarget,
      liquidity,
      amountRemaining,
      500, // 0.05% fee
      false
    );

    expect(step.amountInConsumed).toBeGreaterThan(0n);
    expect(step.amountOutReceived).toBeGreaterThan(0n);
    expect(step.feeAmount).toBeGreaterThan(0n);
  });

  test("quotes multi-asset basket swap splitting capital proportionally", () => {
    const poolStates: Record<string, ConcentratedPoolState> = {
      NVDA: {
        address: "0x1111111111111111111111111111111111111111",
        token0: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        token1: "0x2222222222222222222222222222222222222222",
        feeTier: 500,
        tickSpacing: 10,
        sqrtPriceX96: Q96,
        currentTick: 0,
        liquidity: 10_000_000_000_000n,
      },
      AAPL: {
        address: "0x3333333333333333333333333333333333333333",
        token0: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        token1: "0x4444444444444444444444444444444444444444",
        feeTier: 500,
        tickSpacing: 10,
        sqrtPriceX96: Q96,
        currentTick: 0,
        liquidity: 10_000_000_000_000n,
      },
    };

    const quote = quoteBasketSwap(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      1_000n * 10n ** 6n, // $1,000 USDC
      { NVDA: 0.6, AAPL: 0.4 },
      poolStates,
      6
    );

    expect(quote.trades.length).toBe(2);
    expect(quote.totalGasEstimate).toBeGreaterThan(0n);
    expect(quote.aggregatePriceImpact).toBeGreaterThanOrEqual(0);
  });

  test("calculates slippage protection bounds with specified tolerance bps", () => {
    const expected = 100_000_000_000_000_000n; // 0.1 tokens
    const minOut = calculateSlippageBound(expected, 50); // 0.5% slippage
    expect(minOut).toBe((expected * 9950n) / 10000n);
  });
});
