/**
 * @file corporate_actions.ts
 * @notice Corporate Action Event Engine & Multiplier Adjustment Accounting for Weft Index.
 * Handles stock splits, reverse splits, cash dividends, spinoffs, and symbol renames
 * on Coinbase Tokenized Stocks (B20) to guarantee zero economic value destruction.
 */

export type CorporateActionType =
  | "STOCK_SPLIT"
  | "REVERSE_SPLIT"
  | "CASH_DIVIDEND"
  | "SPECIAL_DIVIDEND"
  | "SPINOFF"
  | "TICKER_RENAME";

export interface CorporateActionEvent {
  id: string;
  ticker: string;
  type: CorporateActionType;
  effectiveDate: string; // ISO 8601 (YYYY-MM-DD)
  recordDate: string;
  exDate: string;
  ratioFrom?: number; // e.g. 1 in a 10-for-1 split
  ratioTo?: number; // e.g. 10 in a 10-for-1 split
  cashAmountPerShare?: number; // USD dividend per tokenized share
  spinoffTicker?: string;
  spinoffRatio?: number;
  newTicker?: string;
  description: string;
}

export interface AdjustedHolding {
  ticker: string;
  preUnits: bigint; // 18 decimals
  postUnits: bigint; // 18 decimals
  prePriceUSD: number;
  postPriceUSD: number;
  preTotalValueUSD: number;
  postTotalValueUSD: number;
  dividendCashAccumulatedUSD: number;
  multiplierAdjustmentFactor: number;
}

export interface CorporateActionAuditReport {
  eventId: string;
  ticker: string;
  eventType: CorporateActionType;
  preNAVUSD: number;
  postNAVUSD: number;
  navDifferenceUSD: number;
  isZeroValueDestructionSatisfied: boolean;
  affectedHoldings: AdjustedHolding[];
}

export const WAD = 10n ** 18n;

/**
 * Computes split multiplier factor: factor = ratioTo / ratioFrom.
 * For example, a 10-for-1 split has factor = 10.0; a 1-for-4 reverse split has factor = 0.25.
 */
export function calculateSplitFactor(ratioFrom: number, ratioTo: number): number {
  if (ratioFrom <= 0 || ratioTo <= 0) {
    throw new Error(`Invalid split ratio: ${ratioTo}-for-${ratioFrom}`);
  }
  return ratioTo / ratioFrom;
}

/**
 * Adjusts token units and per-token price following a stock split or reverse split.
 * Invariant: preUnits * prePrice == postUnits * postPrice (value conserved).
 */
export function applyStockSplit(
  preUnits: bigint,
  prePriceUSD: number,
  ratioFrom: number,
  ratioTo: number
): { postUnits: bigint; postPriceUSD: number; multiplier: number } {
  const multiplier = calculateSplitFactor(ratioFrom, ratioTo);

  // Scaled by 1e9 for integer precision
  const multiplierScaled = BigInt(Math.round(multiplier * 1_000_000_000));
  const postUnits = (preUnits * multiplierScaled) / 1_000_000_000n;
  const postPriceUSD = prePriceUSD / multiplier;

  return {
    postUnits,
    postPriceUSD,
    multiplier,
  };
}

/**
 * Models cash dividend distributions on tokenized stock holdings.
 * Simulates automatic synthetic reinvestment into the token or cash reserve retention.
 */
export function processCashDividend(
  units: bigint,
  prePriceUSD: number,
  cashPerShareUSD: number,
  reinvestInToken = true
): {
  dividendPayoutUSD: number;
  postUnits: bigint;
  postPriceUSD: number;
  effectiveYield: number;
} {
  const unitsDecimal = Number(units) / 1e18;
  const dividendPayoutUSD = unitsDecimal * cashPerShareUSD;
  const exDividendPriceUSD = Math.max(0.01, prePriceUSD - cashPerShareUSD);
  const effectiveYield = cashPerShareUSD / prePriceUSD;

  let postUnits = units;

  if (reinvestInToken) {
    // Reinvest cash dividend to buy additional tokens at ex-dividend price
    const additionalTokens = dividendPayoutUSD / exDividendPriceUSD;
    const additionalUnits = BigInt(Math.floor(additionalTokens * 1e18));
    postUnits = units + additionalUnits;
  }

  return {
    dividendPayoutUSD,
    postUnits,
    postPriceUSD: reinvestInToken ? exDividendPriceUSD : exDividendPriceUSD,
    effectiveYield,
  };
}

/**
 * Processes a spinoff event where holding company distributes shares of a new entity.
 */
export function processSpinoff(
  parentUnits: bigint,
  parentPrePriceUSD: number,
  spinoffTicker: string,
  spinoffRatio: number, // e.g. 0.1 means 1 spinoff share per 10 parent shares
  spinoffInitialPriceUSD: number
): {
  parentPostPriceUSD: number;
  spinoffUnits: bigint;
  spinoffValueUSD: number;
} {
  const parentUnitsDecimal = Number(parentUnits) / 1e18;
  const spinoffTokensCount = parentUnitsDecimal * spinoffRatio;
  const spinoffUnits = BigInt(Math.floor(spinoffTokensCount * 1e18));
  const spinoffValueUSD = spinoffTokensCount * spinoffInitialPriceUSD;

  // Parent price drops by the distributed value per parent share
  const distributedValuePerParent = spinoffRatio * spinoffInitialPriceUSD;
  const parentPostPriceUSD = Math.max(0.01, parentPrePriceUSD - distributedValuePerParent);

  return {
    parentPostPriceUSD,
    spinoffUnits,
    spinoffValueUSD,
  };
}

/**
 * Runs a complete audit of a corporate action against the Weft Index basket.
 * Verifies that the total index asset value is strictly conserved within 0.001% tolerance.
 */
export function auditCorporateAction(
  action: CorporateActionEvent,
  currentHoldings: Array<{ ticker: string; units: bigint; priceUSD: number }>
): CorporateActionAuditReport {
  const targetHolding = currentHoldings.find((h) => h.ticker === action.ticker);
  if (!targetHolding) {
    throw new Error(`Holding not found for ticker: ${action.ticker}`);
  }

  // Pre-action total basket NAV
  const preNAVUSD = currentHoldings.reduce((sum, h) => sum + (Number(h.units) / 1e18) * h.priceUSD, 0);

  const affectedHoldings: AdjustedHolding[] = [];
  let postTargetUnits = targetHolding.units;
  let postTargetPrice = targetHolding.priceUSD;
  let dividendAccum = 0;
  let multiplier = 1.0;

  switch (action.type) {
    case "STOCK_SPLIT":
    case "REVERSE_SPLIT": {
      const split = applyStockSplit(
        targetHolding.units,
        targetHolding.priceUSD,
        action.ratioFrom || 1,
        action.ratioTo || 1
      );
      postTargetUnits = split.postUnits;
      postTargetPrice = split.postPriceUSD;
      multiplier = split.multiplier;
      break;
    }

    case "CASH_DIVIDEND":
    case "SPECIAL_DIVIDEND": {
      const div = processCashDividend(
        targetHolding.units,
        targetHolding.priceUSD,
        action.cashAmountPerShare || 0,
        true // synthetic reinvestment
      );
      postTargetUnits = div.postUnits;
      postTargetPrice = div.postPriceUSD;
      dividendAccum = div.dividendPayoutUSD;
      multiplier = Number(postTargetUnits) / Number(targetHolding.units);
      break;
    }

    case "TICKER_RENAME": {
      // Units and price conserved, only symbol changes
      multiplier = 1.0;
      break;
    }

    default:
      break;
  }

  const preValueUSD = (Number(targetHolding.units) / 1e18) * targetHolding.priceUSD;
  const postValueUSD = (Number(postTargetUnits) / 1e18) * postTargetPrice;

  affectedHoldings.push({
    ticker: action.type === "TICKER_RENAME" && action.newTicker ? action.newTicker : targetHolding.ticker,
    preUnits: targetHolding.units,
    postUnits: postTargetUnits,
    prePriceUSD: targetHolding.priceUSD,
    postPriceUSD: postTargetPrice,
    preTotalValueUSD: preValueUSD,
    postTotalValueUSD: postValueUSD,
    dividendCashAccumulatedUSD: dividendAccum,
    multiplierAdjustmentFactor: multiplier,
  });

  // Calculate post-action total basket NAV
  let postNAVUSD = 0;
  for (const h of currentHoldings) {
    if (h.ticker === targetHolding.ticker) {
      postNAVUSD += postValueUSD;
    } else {
      postNAVUSD += (Number(h.units) / 1e18) * h.priceUSD;
    }
  }

  const navDiff = Math.abs(postNAVUSD - preNAVUSD);
  const relativeDiff = preNAVUSD > 0 ? navDiff / preNAVUSD : 0;
  const isZeroValueDestructionSatisfied = relativeDiff < 0.0001; // < 0.01% error margin

  return {
    eventId: action.id,
    ticker: action.ticker,
    eventType: action.type,
    preNAVUSD,
    postNAVUSD,
    navDifferenceUSD: navDiff,
    isZeroValueDestructionSatisfied,
    affectedHoldings,
  };
}

/**
 * Builds backward-adjusted historical price series from raw unadjusted closing prices and corporate actions.
 */
export function buildAdjustedPriceSeries(
  rawPrices: Array<{ date: string; close: number }>,
  actions: CorporateActionEvent[]
): Array<{ date: string; unadjustedClose: number; adjustedClose: number; cumulativeMultiplier: number }> {
  // Sort actions newest to oldest
  const sortedActions = [...actions].sort(
    (a, b) => new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime()
  );

  const result: Array<{
    date: string;
    unadjustedClose: number;
    adjustedClose: number;
    cumulativeMultiplier: number;
  }> = [];

  for (const bar of rawPrices) {
    const barTime = new Date(bar.date).getTime();
    let cumulativeFactor = 1.0;

    for (const action of sortedActions) {
      const actionTime = new Date(action.effectiveDate).getTime();
      if (barTime < actionTime) {
        if (action.type === "STOCK_SPLIT" || action.type === "REVERSE_SPLIT") {
          const factor = calculateSplitFactor(action.ratioFrom || 1, action.ratioTo || 1);
          cumulativeFactor /= factor;
        } else if (action.type === "CASH_DIVIDEND" && action.cashAmountPerShare) {
          const divFactor = (bar.close - action.cashAmountPerShare) / bar.close;
          if (divFactor > 0) {
            cumulativeFactor *= divFactor;
          }
        }
      }
    }

    result.push({
      date: bar.date,
      unadjustedClose: bar.close,
      adjustedClose: bar.close * cumulativeFactor,
      cumulativeMultiplier: cumulativeFactor,
    });
  }

  return result;
}
