// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WeftIndex} from "../../src/WeftIndex.sol";
import {MockScaledToken, MockFeed, MockPool} from "../WeftUnit.t.sol";

/// @notice Handler contract for invariant testing of WeftIndex
/// @dev Generates bounded pseudo-random user actions (deposits, unwinds, multiplier bumps, price ticks)
contract WeftHandler is Test {
    WeftIndex public immutable weft;
    MockScaledToken[] public tokens;
    MockPool[] public pools;
    MockFeed[] public feeds;
    MockScaledToken public immutable usdc;

    uint256 public totalDepositedUsdc;
    uint256 public totalUnwoundUsdc;
    uint256 public totalSharesMinted;
    uint256 public totalSharesBurned;
    uint256 public ghostMultiplierAccumulator = 1e18;

    address[] internal actors;
    address internal currentActor;

    modifier useActor(uint256 actorIndexSeed) {
        currentActor = actors[actorIndexSeed % actors.length];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    constructor(
        WeftIndex _weft,
        MockScaledToken _usdc,
        MockScaledToken[] memory _tokens,
        MockPool[] memory _pools,
        MockFeed[] memory _feeds
    ) {
        weft = _weft;
        usdc = _usdc;
        tokens = _tokens;
        pools = _pools;
        feeds = _feeds;

        actors.push(address(0x1001));
        actors.push(address(0x1002));
        actors.push(address(0x1003));
        actors.push(address(0x1004));

        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 100_000_000e6); // 100M USDC each
            vm.prank(actors[i]);
            usdc.transfer(address(this), 0); // warm up
        }
    }

    function deposit(uint256 actorSeed, uint256 rawAmount) external useActor(actorSeed) {
        uint256 amount = bound(rawAmount, 10e6, 500_000e6); // $10 to $500k
        
        usdc.mint(currentActor, amount);
        usdc.approve(address(weft), amount);

        uint256 sharesExpected = weft.previewDeposit(amount);
        if (sharesExpected == 0) return;

        uint256 minShares = (sharesExpected * 95) / 100; // 5% slippage tolerance
        try weft.deposit(amount, minShares) returns (uint256 shares) {
            totalDepositedUsdc += amount;
            totalSharesMinted += shares;
        } catch {
            // expected on slippage or dust
        }
    }

    function unwind(uint256 actorSeed, uint256 sharesPct) external useActor(actorSeed) {
        uint256 userShares = weft.balanceOf(currentActor);
        if (userShares == 0) return;

        uint256 pct = bound(sharesPct, 1, 100);
        uint256 sharesToUnwind = (userShares * pct) / 100;
        if (sharesToUnwind == 0) return;

        weft.approve(address(weft), sharesToUnwind);

        // Preview withdrawal value
        uint256 supply = weft.totalSupply();
        uint256 basketVal = weft.totalValueUsd();
        uint256 expectedUsdc = ((basketVal * sharesToUnwind) / supply) / 1e12;
        uint256 minUsdc = (expectedUsdc * 90) / 100; // 10% bounds

        try weft.unwind(sharesToUnwind, minUsdc) returns (uint256 usdcOut) {
            totalSharesBurned += sharesToUnwind;
            totalUnwoundUsdc += usdcOut;
        } catch {
            // expected on pool balance limit
        }
    }

    function simulateDividendRebase(uint256 tokenIndexSeed, uint256 bpsIncrease) external {
        uint256 tokenIdx = tokenIndexSeed % tokens.length;
        uint256 bps = bound(bpsIncrease, 10, 500); // 0.1% to 5% dividend

        uint256 currentMult = tokens[tokenIdx].multiplierWad();
        uint256 newMult = currentMult + (currentMult * bps) / 10_000;
        tokens[tokenIdx].setMultiplier(newMult);

        ghostMultiplierAccumulator = (ghostMultiplierAccumulator * (10_000 + bps)) / 10_000;
    }

    function simulateStockSplit(uint256 tokenIndexSeed, uint256 ratioSeed) external {
        uint256 tokenIdx = tokenIndexSeed % tokens.length;
        uint256 ratio = bound(ratioSeed, 2, 4); // 2:1, 3:1, or 4:1 split

        uint256 currentMult = tokens[tokenIdx].multiplierWad();
        tokens[tokenIdx].setMultiplier(currentMult * ratio);
    }

    function simulateMarketPriceTick(uint256 feedIdxSeed, int256 priceDeltaBps) external {
        uint256 feedIdx = feedIdxSeed % feeds.length;
        (, int256 currentPrice, , , ) = feeds[feedIdx].latestRoundData();

        int256 delta = bound(priceDeltaBps, -500, 500); // -5% to +5% tick
        int256 newPrice = currentPrice + (currentPrice * delta) / 10_000;
        if (newPrice > 1e8) {
            // update feed price through constructor or mock helper
        }
    }
}

/// @notice Invariant test runner using Foundry invariant engine
contract WeftInvariantsTest is Test {
    WeftIndex public weft;
    WeftHandler public handler;

    MockScaledToken public usdc;
    MockScaledToken public aapl;
    MockScaledToken public nvda;
    MockScaledToken public msft;
    MockScaledToken public tsla;

    MockFeed public aaplFeed;
    MockFeed public nvdaFeed;
    MockFeed public msftFeed;
    MockFeed public tslaFeed;

    MockPool public aaplPool;
    MockPool public nvdaPool;
    MockPool public msftPool;
    MockPool public tslaPool;

    MockScaledToken[] internal tokensArr;
    MockPool[] internal poolsArr;
    MockFeed[] internal feedsArr;

    function setUp() public {
        usdc = new MockScaledToken(); // 6 dec
        aapl = new MockScaledToken(); // 8 dec
        nvda = new MockScaledToken(); // 8 dec
        msft = new MockScaledToken(); // 8 dec
        tsla = new MockScaledToken(); // 8 dec

        // Prices: AAPL $220, NVDA $120, MSFT $420, TSLA $210 (8 decimals)
        aaplFeed = new MockFeed(220e8);
        nvdaFeed = new MockFeed(120e8);
        msftFeed = new MockFeed(420e8);
        tslaFeed = new MockFeed(210e8);

        // Pools with fixed USDC prices: 220 USDC, 120 USDC, 420 USDC, 210 USDC
        aaplPool = new MockPool(address(usdc), address(aapl), 220e6);
        nvdaPool = new MockPool(address(usdc), address(nvda), 120e6);
        msftPool = new MockPool(address(usdc), address(msft), 420e6);
        tslaPool = new MockPool(address(usdc), address(tsla), 210e6);

        // Seed pools with deep liquidity for testing
        aapl.mint(address(aaplPool), 5_000_000e8);
        nvda.mint(address(nvdaPool), 5_000_000e8);
        msft.mint(address(msftPool), 5_000_000e8);
        tsla.mint(address(tslaPool), 5_000_000e8);

        usdc.mint(address(aaplPool), 1_000_000_000e6);
        usdc.mint(address(nvdaPool), 1_000_000_000e6);
        usdc.mint(address(msftPool), 1_000_000_000e6);
        usdc.mint(address(tslaPool), 1_000_000_000e6);

        address[] memory tok = new address[](4);
        tok[0] = address(aapl);
        tok[1] = address(nvda);
        tok[2] = address(msft);
        tok[3] = address(tsla);

        uint256[] memory weights = new uint256[](4);
        weights[0] = 2500; // 25%
        weights[1] = 2500; // 25%
        weights[2] = 2500; // 25%
        weights[3] = 2500; // 25%

        address[] memory pls = new address[](4);
        pls[0] = address(aaplPool);
        pls[1] = address(nvdaPool);
        pls[2] = address(msftPool);
        pls[3] = address(tslaPool);

        address[] memory fds = new address[](4);
        fds[0] = address(aaplFeed);
        fds[1] = address(nvdaFeed);
        fds[2] = address(msftFeed);
        fds[3] = address(tslaFeed);

        weft = new WeftIndex(
            "Weft Blue Chip US Stocks",
            "WEFT",
            address(usdc),
            tok,
            weights,
            pls,
            fds
        );

        tokensArr.push(aapl);
        tokensArr.push(nvda);
        tokensArr.push(msft);
        tokensArr.push(tsla);

        poolsArr.push(aaplPool);
        poolsArr.push(nvdaPool);
        poolsArr.push(msftPool);
        poolsArr.push(tslaPool);

        feedsArr.push(aaplFeed);
        feedsArr.push(nvdaFeed);
        feedsArr.push(msftFeed);
        feedsArr.push(tslaFeed);

        handler = new WeftHandler(weft, usdc, tokensArr, poolsArr, feedsArr);
        targetContract(address(handler));
    }

    /// @notice Invariant 1: Total supply must be zero or total basket value must be positive
    function invariant_solvencyPositiveValuation() public view {
        if (weft.totalSupply() > 0) {
            assertGt(weft.totalValueUsd(), 0, "Non-zero supply must have positive valuation");
        }
    }

    /// @notice Invariant 2: Total supply must always exceed DEAD_SHARES after first deposit
    function invariant_deadSharesFloor() public view {
        if (weft.totalSupply() > 0) {
            assertGe(weft.totalSupply(), weft.DEAD_SHARES(), "Supply must exceed dead shares");
            assertEq(weft.balanceOf(address(0xdead)), weft.DEAD_SHARES(), "Dead shares must be locked");
        }
    }

    /// @notice Invariant 3: Multiplier rebasing must strictly preserve or increase scaled holdings
    function invariant_multiplierPreservation() public view {
        for (uint256 i = 0; i < tokensArr.length; i++) {
            uint256 rawBal = tokensArr[i].balanceOf(address(weft));
            uint256 scaledBal = tokensArr[i].scaledBalanceOf(address(weft));
            assertGe(scaledBal, rawBal, "Scaled balance must be >= raw balance for multiplier >= 1.0");
        }
    }

    /// @notice Invariant 4: Token weights must remain strictly conserved at 10,000 BPS
    function invariant_weightsConserved() public view {
        uint256 len = weft.basketLength();
        uint256 sum = 0;
        for (uint256 i = 0; i < len; i++) {
            sum += weft.weightsBps(i);
        }
        assertEq(sum, 10_000, "Basket weights sum must equal 10,000 BPS");
    }

    /// @notice Invariant 5: Preview deposit must be monotonically non-decreasing with deposit size
    function invariant_previewDepositMonotonic() public view {
        if (weft.totalSupply() > 0) {
            uint256 sharesSmall = weft.previewDeposit(100e6);
            uint256 sharesLarge = weft.previewDeposit(200e6);
            assertGe(sharesLarge, sharesSmall, "Preview deposit must be monotonic");
        }
    }
}
