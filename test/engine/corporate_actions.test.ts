/**
 * @file corporate_actions.test.ts
 * @notice Unit tests for Corporate Action event processing and NAV preservation invariants.
 */

import {
  calculateSplitFactor,
  applyStockSplit,
  processCashDividend,
  processSpinoff,
  auditCorporateAction,
  buildAdjustedPriceSeries,
  CorporateActionEvent,
  WAD,
} from "../../lib/engine/corporate_actions";

describe("Corporate Actions Accounting Engine Suite", () => {
  test("calculates split multipliers correctly for forward and reverse splits", () => {
    // 10-for-1 forward split
    expect(calculateSplitFactor(1, 10)).toBe(10.0);
    // 1-for-4 reverse split
    expect(calculateSplitFactor(4, 1)).toBe(0.25);
    // 3-for-2 split
    expect(calculateSplitFactor(2, 3)).toBe(1.5);
  });

  test("preserves total economic value during forward stock split", () => {
    const preUnits = 100n * WAD;
    const prePrice = 1200.0; // $1,200/share
    const preTotalValue = (Number(preUnits) / 1e18) * prePrice;

    const { postUnits, postPriceUSD } = applyStockSplit(preUnits, prePrice, 1, 10);
    const postTotalValue = (Number(postUnits) / 1e18) * postPriceUSD;

    expect(postUnits).toBe(1000n * WAD);
    expect(postPriceUSD).toBe(120.0);
    expect(postTotalValue).toBeCloseTo(preTotalValue, 6);
  });

  test("preserves total economic value during reverse stock split", () => {
    const preUnits = 400n * WAD;
    const prePrice = 25.0; // $25/share
    const preTotalValue = (Number(preUnits) / 1e18) * prePrice;

    const { postUnits, postPriceUSD } = applyStockSplit(preUnits, prePrice, 4, 1);
    const postTotalValue = (Number(postUnits) / 1e18) * postPriceUSD;

    expect(postUnits).toBe(100n * WAD);
    expect(postPriceUSD).toBe(100.0);
    expect(postTotalValue).toBeCloseTo(preTotalValue, 6);
  });

  test("processes cash dividend with synthetic reinvestment maintaining total wealth", () => {
    const units = 50n * WAD;
    const prePrice = 200.0;
    const cashPerShare = 5.0;

    const result = processCashDividend(units, prePrice, cashPerShare, true);
    expect(result.dividendPayoutUSD).toBe(250.0); // 50 * $5
    expect(result.postPriceUSD).toBe(195.0); // Ex-dividend price $200 - $5
    expect(result.postUnits).toBeGreaterThan(units);

    const postWealth = (Number(result.postUnits) / 1e18) * result.postPriceUSD;
    const preWealth = (Number(units) / 1e18) * prePrice;
    expect(postWealth).toBeCloseTo(preWealth, 1);
  });

  test("processes spinoff distributions adjusting parent asset price proportionally", () => {
    const parentUnits = 100n * WAD;
    const parentPrePrice = 300.0;
    const spinoffRatio = 0.2; // 1 spinoff share per 5 parent shares
    const spinoffInitialPrice = 50.0;

    const result = processSpinoff(
      parentUnits,
      parentPrePrice,
      "NEWCO",
      spinoffRatio,
      spinoffInitialPrice
    );

    expect(result.spinoffUnits).toBe(20n * WAD);
    expect(result.spinoffValueUSD).toBe(1000.0); // 20 shares * $50
    // Parent price drops by 0.2 * 50 = $10 -> $290
    expect(result.parentPostPriceUSD).toBe(290.0);
  });

  test("audits complete corporate action verifying zero value destruction invariant", () => {
    const holdings = [
      { ticker: "NVDA", units: 10n * WAD, priceUSD: 1000.0 },
      { ticker: "AAPL", units: 50n * WAD, priceUSD: 200.0 },
    ];

    const action: CorporateActionEvent = {
      id: "evt-001",
      ticker: "NVDA",
      type: "STOCK_SPLIT",
      effectiveDate: "2026-06-10",
      recordDate: "2026-06-08",
      exDate: "2026-06-10",
      ratioFrom: 1,
      ratioTo: 10,
      description: "NVDA 10-for-1 Forward Stock Split",
    };

    const audit = auditCorporateAction(action, holdings);
    expect(audit.isZeroValueDestructionSatisfied).toBe(true);
    expect(audit.navDifferenceUSD).toBeLessThan(0.01);
  });

  test("builds backward-adjusted price series across multiple split and dividend events", () => {
    const rawBars = [
      { date: "2026-01-01", close: 1000.0 },
      { date: "2026-02-01", close: 1100.0 },
      { date: "2026-03-01", close: 120.0 }, // Split occurred between Feb and Mar
    ];

    const actions: CorporateActionEvent[] = [
      {
        id: "evt-split",
        ticker: "NVDA",
        type: "STOCK_SPLIT",
        effectiveDate: "2026-02-15",
        recordDate: "2026-02-14",
        exDate: "2026-02-15",
        ratioFrom: 1,
        ratioTo: 10,
        description: "10-for-1 split",
      },
    ];

    const adjusted = buildAdjustedPriceSeries(rawBars, actions);
    expect(adjusted.length).toBe(3);
    // Prior bars are scaled down by factor of 10
    expect(adjusted[0].adjustedClose).toBeCloseTo(100.0, 1);
    expect(adjusted[1].adjustedClose).toBeCloseTo(110.0, 1);
    expect(adjusted[2].adjustedClose).toBeCloseTo(120.0, 1);
  });
});
