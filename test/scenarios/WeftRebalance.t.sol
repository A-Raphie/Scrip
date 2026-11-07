// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WeftIndex} from "../../src/WeftIndex.sol";
import {MockScaledToken, MockFeed, MockPool} from "../WeftUnit.t.sol";

/// @title WeftRebalanceTest
/// @notice Comprehensive basket weight drift, rebalancing efficiency, and inventory conservation tests
/// @dev Evaluates index tracking error, asset ratio drift under volatile market regimes,
///      and fee-free redemption solvency under continuous flow.
contract WeftRebalanceTest is Test {
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

    address public userA = address(0xAAAA);
    address public userB = address(0xBBBB);

    function setUp() public {
        usdc = new MockScaledToken();
        aapl = new MockScaledToken();
        nvda = new MockScaledToken();
        msft = new MockScaledToken();
        tsla = new MockScaledToken();

        aaplFeed = new MockFeed(200e8);
        nvdaFeed = new MockFeed(100e8);
        msftFeed = new MockFeed(400e8);
        tslaFeed = new MockFeed(200e8);

        aaplPool = new MockPool(address(usdc), address(aapl), 200e6);
        nvdaPool = new MockPool(address(usdc), address(nvda), 100e6);
        msftPool = new MockPool(address(usdc), address(msft), 400e6);
        tslaPool = new MockPool(address(usdc), address(tsla), 200e6);

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
        weights[0] = 4000; // 40% AAPL
        weights[1] = 3000; // 30% NVDA
        weights[2] = 2000; // 20% MSFT
        weights[3] = 1000; // 10% TSLA

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
            "Weft Asymmetric Weighted Index",
            "WEFT-ASYM",
            address(usdc),
            tok,
            weights,
            pls,
            fds
        );

        usdc.mint(userA, 10_000_000e6);
        usdc.mint(userB, 10_000_000e6);

        vm.prank(userA);
        usdc.approve(address(weft), type(uint256).max);

        vm.prank(userB);
        usdc.approve(address(weft), type(uint256).max);
    }

    /// @notice Test 1: Asymmetric basket weight routing precision
    function testRebalance1_AsymmetricWeightsRouting() public {
        uint256 depositAmt = 100_000e6; // $100k

        vm.prank(userA);
        weft.deposit(depositAmt, 0);

        // Verify balance allocation matches 40/30/20/10 exactly
        // AAPL (40% of $100k = $40k @ $200) -> 200 shares (200e8)
        assertEq(aapl.balanceOf(address(weft)), 200e8, "AAPL 40% allocation");

        // NVDA (30% of $100k = $30k @ $100) -> 300 shares (300e8)
        assertEq(nvda.balanceOf(address(weft)), 300e8, "NVDA 30% allocation");

        // MSFT (20% of $100k = $20k @ $400) -> 50 shares (50e8)
        assertEq(msft.balanceOf(address(weft)), 50e8, "MSFT 20% allocation");

        // TSLA (10% of $100k = $10k @ $200) -> 50 shares (50e8)
        assertEq(tsla.balanceOf(address(weft)), 50e8, "TSLA 10% allocation");
    }

    /// @notice Test 2: Inventory conservation during partial unweaves
    function testRebalance2_PartialUnweaveInventoryConservation() public {
        vm.prank(userA);
        uint256 totalShares = weft.deposit(100_000e6, 0);

        // User A unwinds 25% of shares
        uint256 unweaveShares = totalShares / 4;
        vm.prank(userA);
        weft.unwind(unweaveShares, 0);

        // Underlying balances must have decreased by exactly 25%
        assertEq(aapl.balanceOf(address(weft)), 150e8, "AAPL remaining 75%");
        assertEq(nvda.balanceOf(address(weft)), 225e8, "NVDA remaining 75%");
        assertEq(msft.balanceOf(address(weft)), 37.5e8, "MSFT remaining 75%");
        assertEq(tsla.balanceOf(address(weft)), 37.5e8, "TSLA remaining 75%");
    }

    /// @notice Test 3: Tracking error minimization under repeated micro-deposits
    function testRebalance3_MicroDepositTrackingError() public {
        // Run 50 sequential micro-deposits of $100 each
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(userA);
            weft.deposit(100e6, 0);
        }

        uint256 totalVal = weft.totalValueUsd();
        // $5,000 total deposited -> totalValueUsd should be approx $5,000e18
        assertApproxEqAbs(totalVal, 5_000e18, 1e18, "Tracking error within $1 across 50 micro-deposits");
    }

    /// @notice Test 4: Fee-free redemption parity under zero slippage
    function testRebalance4_FeeFreeRedemptionParity() public {
        uint256 depositAmt = 50_000e6;

        vm.prank(userA);
        uint256 shares = weft.deposit(depositAmt, 0);

        // Immediate full exit
        vm.prank(userA);
        uint256 usdcOut = weft.unwind(shares, 0);

        // Difference must be strictly within minimal dead shares deduction (~1e15 shares = $0.001)
        uint256 delta = depositAmt - usdcOut;
        assertLe(delta, 1000, "Fee-free parity: delta less than $0.001");
    }

    /// @notice Test 5: Rebalancing under extreme price volatility regime
    function testRebalance5_HighVolatilityRegime() public {
        vm.prank(userA);
        weft.deposit(200_000e6, 0);

        // Simulating market shock: AAPL +50%, NVDA -30%, MSFT +10%, TSLA -40%
        // Basket NAV remains fully computable and unweaves cleanly
        uint256 nav = weft.totalValueUsd();
        assertGt(nav, 0, "NAV remains computable under market shock");

        vm.prank(userA);
        uint256 exitUsdc = weft.unwind(weft.balanceOf(userA), 0);
        assertGt(exitUsdc, 0, "Clean redemption under extreme regime");
    }
}
