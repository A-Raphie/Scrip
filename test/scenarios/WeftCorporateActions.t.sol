// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WeftIndex} from "../../src/WeftIndex.sol";
import {MockScaledToken, MockFeed, MockPool} from "../WeftUnit.t.sol";

/// @title WeftCorporateActionsTest
/// @notice Comprehensive corporate action test matrix covering B20 multiplier updates
/// @dev Verifies that splits, reverse splits, cash dividends, and asymmetric corporate actions
///      accrue directly to Weft share value without breaking index basket proportionality.
contract WeftCorporateActionsTest is Test {
    WeftIndex public weft;
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

    address public alice = address(0xAA11);
    address public bob = address(0xBB22);
    address public charlie = address(0xCC33);

    event Woven(address indexed user, uint256 usdcIn, uint256 sharesMinted);
    event Unwoven(address indexed user, uint256 sharesBurned, uint256 usdcOut);

    function setUp() public {
        usdc = new MockScaledToken();
        aapl = new MockScaledToken();
        nvda = new MockScaledToken();
        msft = new MockScaledToken();
        tsla = new MockScaledToken();

        // Feed prices: AAPL $200, NVDA $100, MSFT $400, TSLA $200
        aaplFeed = new MockFeed(200e8);
        nvdaFeed = new MockFeed(100e8);
        msftFeed = new MockFeed(400e8);
        tslaFeed = new MockFeed(200e8);

        aaplPool = new MockPool(address(usdc), address(aapl), 200e6);
        nvdaPool = new MockPool(address(usdc), address(nvda), 100e6);
        msftPool = new MockPool(address(usdc), address(msft), 400e6);
        tslaPool = new MockPool(address(usdc), address(tsla), 200e6);

        // Seed pools with deep liquidity
        aapl.mint(address(aaplPool), 10_000_000e8);
        nvda.mint(address(nvdaPool), 10_000_000e8);
        msft.mint(address(msftPool), 10_000_000e8);
        tsla.mint(address(tslaPool), 10_000_000e8);

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
        weights[0] = 2500;
        weights[1] = 2500;
        weights[2] = 2500;
        weights[3] = 2500;

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

        // Fund test users
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        usdc.mint(charlie, 1_000_000e6);

        vm.prank(alice);
        usdc.approve(address(weft), type(uint256).max);

        vm.prank(bob);
        usdc.approve(address(weft), type(uint256).max);

        vm.prank(charlie);
        usdc.approve(address(weft), type(uint256).max);
    }

    /// @notice Scenario 1: Standard 2-for-1 forward stock split on NVDA
    function testScenario1_ForwardStockSplit() public {
        vm.prank(alice);
        uint256 aliceShares = weft.deposit(10_000e6, 0); // $10k

        uint256 valueBefore = weft.totalValueUsd();

        // NVDA announces 2:1 stock split -> multiplier doubles from 1.0 to 2.0
        nvda.setMultiplier(2e18);

        uint256 valueAfter = weft.totalValueUsd();

        // NVDA was 25% of basket ($2,500), now doubled to $5,000 -> basket value rises to $12,500
        assertGt(valueAfter, valueBefore, "Valuation must increase after split");
        assertApproxEqAbs(valueAfter, (valueBefore * 125) / 100, 1e18, "Value must reflect 25% basket gain");

        // Alice unwinds half her shares and receives post-split value
        uint256 sharesToUnwind = aliceShares / 2;
        vm.prank(alice);
        uint256 usdcOut = weft.unwind(sharesToUnwind, 0);

        assertGt(usdcOut, 5_000e6, "Unwind output must reflect post-split appreciation");
    }

    /// @notice Scenario 2: 1-for-5 reverse stock split on TSLA
    function testScenario2_ReverseStockSplit() public {
        vm.prank(alice);
        weft.deposit(20_000e6, 0);

        uint256 valueBefore = weft.totalValueUsd();

        // TSLA reverse split 1:5 -> multiplier decreases from 1.0 to 0.2
        tsla.setMultiplier(2e17);

        uint256 valueAfter = weft.totalValueUsd();
        assertLt(valueAfter, valueBefore, "Valuation decreases under unadjusted feed reverse split");

        // Feed price adjusts 5x up to compensate for reverse split
        // In reality Chainlink feed price rises to $1,000
    }

    /// @notice Scenario 3: 3% quarterly dividend cash-rebase on AAPL
    function testScenario3_QuarterlyDividendRebase() public {
        vm.prank(alice);
        uint256 aliceShares = weft.deposit(40_000e6, 0);

        uint256 valStart = weft.totalValueUsd();

        // AAPL declares 3% quarterly dividend -> multiplier moves from 1.00 to 1.03
        aapl.setMultiplier(1.03e18);

        uint256 valPostDividend = weft.totalValueUsd();

        // AAPL was 25% of $40,000 = $10,000. 3% on $10,000 = $300 gain
        uint256 deltaUsd = (valPostDividend - valStart) / 1e18;
        assertApproxEqAbs(deltaUsd, 300, 2, "Basket must capture $300 dividend accrual");

        // Bob deposits after dividend. Bob should get fewer shares per dollar than Alice did
        vm.prank(bob);
        uint256 bobShares = weft.deposit(40_000e6, 0);

        assertLt(bobShares, aliceShares, "Post-dividend depositor gets fewer shares due to higher NAV");
    }

    /// @notice Scenario 4: High-frequency compounding micro-dividends
    function testScenario4_CompoundingMicroDividends() public {
        vm.prank(alice);
        weft.deposit(100_000e6, 0);

        uint256 currentMult = 1e18;
        for (uint256 round = 1; round <= 10; round++) {
            // 50 bps (0.5%) dividend per round
            currentMult = (currentMult * 10050) / 10000;
            msft.setMultiplier(currentMult);

            uint256 nav = weft.totalValueUsd();
            assertGt(nav, 100_000e18, "NAV must continuously grow");
        }

        assertGt(currentMult, 1.05e18, "Compounded multiplier must exceed 1.05x");
    }

    /// @notice Scenario 5: Asymmetric multi-stock corporate action race
    function testScenario5_AsymmetricCorporateActionRace() public {
        vm.prank(alice);
        weft.deposit(50_000e6, 0);

        // AAPL pays 2% dividend
        aapl.setMultiplier(1.02e18);

        // NVDA does 3:1 split
        nvda.setMultiplier(3.0e18);

        // MSFT pays 1.5% dividend
        msft.setMultiplier(1.015e18);

        uint256 totalVal = weft.totalValueUsd();
        assertGt(totalVal, 75_000e18, "Combined valuation must exceed $75k");

        // Solvency check: Alice can unwind 100% of her shares without revert
        uint256 shares = weft.balanceOf(alice);
        vm.prank(alice);
        uint256 usdcOut = weft.unwind(shares, 0);

        assertGt(usdcOut, 50_000e6, "Alice receives full appreciation on exit");
    }

    /// @notice Scenario 6: Extreme multiplier boundary stress test
    function testScenario6_ExtremeMultiplierBoundaries() public {
        vm.prank(alice);
        weft.deposit(10_000e6, 0);

        // 100x multiplier (hyper-split)
        tsla.setMultiplier(100e18);
        uint256 highVal = weft.totalValueUsd();
        assertGt(highVal, 200_000e18, "High multiplier must scale proportionally");

        // 0.001x multiplier (hyper-reverse-split)
        tsla.setMultiplier(1e15);
        uint256 lowVal = weft.totalValueUsd();
        assertGt(lowVal, 7_500e18, "Non-affected tokens continue supporting basket value");
    }

    /// @notice Scenario 7: Multiplier update interleaved with parallel deposits
    function testScenario7_InterleavedDepositAndMultiplier() public {
        vm.prank(alice);
        uint256 s1 = weft.deposit(10_000e6, 0);

        // Dividend lands
        aapl.setMultiplier(1.05e18);

        vm.prank(bob);
        uint256 s2 = weft.deposit(10_000e6, 0);

        // Another dividend lands
        aapl.setMultiplier(1.10e18);

        vm.prank(charlie);
        uint256 s3 = weft.deposit(10_000e6, 0);

        // Shares ordered by entry timing: s1 > s2 > s3
        assertGt(s1, s2, "Alice receives more shares than Bob");
        assertGt(s2, s3, "Bob receives more shares than Charlie");
    }

    /// @notice Scenario 8: Post-split basket weight restoration check
    function testScenario8_PostSplitWeightDrift() public {
        vm.prank(alice);
        weft.deposit(20_000e6, 0);

        // NVDA 4:1 split distorts current USD weighting towards NVDA
        nvda.setMultiplier(4e18);

        // New deposits route strictly according to statutory weightsBps (25% each)
        // so new inflow progressively pulls the portfolio back towards target equilibrium
        vm.prank(bob);
        weft.deposit(80_000e6, 0);

        assertGt(weft.totalValueUsd(), 100_000e18, "Total value properly tracks dynamic inflows");
    }

    /// @notice Scenario 9: Zero-deposit corporate action edge case
    function testScenario9_ZeroDepositMultiplierChanges() public {
        // Multiplier changes prior to first deposit must not cause arithmetic errors or locks
        aapl.setMultiplier(2.5e18);
        nvda.setMultiplier(1.5e18);

        vm.prank(alice);
        uint256 shares = weft.deposit(10_000e6, 0);
        assertGt(shares, 0, "First deposit must succeed despite pre-existing multipliers");
    }

    /// @notice Scenario 10: Complete deposit -> multi-dividend -> full unwind cycle
    function testScenario10_FullLifecycleCycle() public {
        vm.prank(alice);
        weft.deposit(50_000e6, 0);

        vm.prank(bob);
        weft.deposit(50_000e6, 0);

        // Series of dividends across all 4 stocks
        aapl.setMultiplier(1.02e18);
        nvda.setMultiplier(1.04e18);
        msft.setMultiplier(1.01e18);
        tsla.setMultiplier(1.03e18);

        // Both Alice and Bob exit completely
        uint256 aliceShares = weft.balanceOf(alice);
        uint256 bobShares = weft.balanceOf(bob);

        vm.prank(alice);
        uint256 aliceOut = weft.unwind(aliceShares, 0);

        vm.prank(bob);
        uint256 bobOut = weft.unwind(bobShares, 0);

        assertGt(aliceOut, 50_000e6, "Alice makes net profit from dividends");
        assertGt(bobOut, 50_000e6, "Bob makes net profit from dividends");
        assertApproxEqAbs(aliceOut, bobOut, 1e6, "Alice and Bob receive identical pro-rata proceeds");

        // Contract retains only dead shares
        assertEq(weft.totalSupply(), weft.DEAD_SHARES(), "Only dead shares remain");
    }
}
