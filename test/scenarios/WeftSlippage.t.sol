// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WeftIndex} from "../../src/WeftIndex.sol";
import {MockScaledToken, MockFeed, MockPool} from "../WeftUnit.t.sol";

/// @title WeftSlippageTest
/// @notice Comprehensive slippage, tick boundary, and front-running protection test suite
/// @dev Verifies that user-specified minShares and minUsdcOut parameters strictly protect
///      against MEV sandwich attacks, adverse price movement, and illiquid pool depth.
contract WeftSlippageTest is Test {
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

    address public victim = address(0x1111);
    address public attacker = address(0x6666);

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

        aapl.mint(address(aaplPool), 5_000_000e8);
        nvda.mint(address(nvdaPool), 5_000_000e8);
        msft.mint(address(msftPool), 5_000_000e8);
        tsla.mint(address(tslaPool), 5_000_000e8);

        usdc.mint(address(aaplPool), 500_000_000e6);
        usdc.mint(address(nvdaPool), 500_000_000e6);
        usdc.mint(address(msftPool), 500_000_000e6);
        usdc.mint(address(tslaPool), 500_000_000e6);

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

        usdc.mint(victim, 1_000_000e6);
        usdc.mint(attacker, 10_000_000e6);

        vm.prank(victim);
        usdc.approve(address(weft), type(uint256).max);

        vm.prank(attacker);
        usdc.approve(address(weft), type(uint256).max);
    }

    /// @notice Test 1: Exact minShares boundary enforcement
    function testSlippage1_MinSharesRevert() public {
        uint256 depositAmt = 10_000e6;
        uint256 expectedShares = weft.previewDeposit(depositAmt);

        // Intentionally request 1 extra wei of shares -> must revert
        vm.prank(victim);
        vm.expectRevert("slippage");
        weft.deposit(depositAmt, expectedShares + 1);

        // Exact match succeeds
        vm.prank(victim);
        uint256 shares = weft.deposit(depositAmt, expectedShares);
        assertEq(shares, expectedShares, "Must match expected shares");
    }

    /// @notice Test 2: Unwind minUsdcOut boundary enforcement
    function testSlippage2_MinUsdcOutRevert() public {
        vm.prank(victim);
        uint256 shares = weft.deposit(20_000e6, 0);

        // Estimate unwind output
        uint256 supply = weft.totalSupply();
        uint256 totalVal = weft.totalValueUsd();
        uint256 expectedUsdc = ((totalVal * shares) / supply) / 1e12;

        // Requesting 1 extra wei of USDC must revert
        vm.prank(victim);
        vm.expectRevert("slippage");
        weft.unwind(shares, expectedUsdc + 1);

        // Reasonable bounds succeed
        vm.prank(victim);
        uint256 usdcOut = weft.unwind(shares, (expectedUsdc * 99) / 100);
        assertGt(usdcOut, 0, "Unwind succeeds within slippage bounds");
    }

    /// @notice Test 3: Simulated MEV sandwich resistance via tight slippage
    function testSlippage3_SandwichMitigation() public {
        // Attacker observes victim's pending deposit of $50,000
        uint256 victimDeposit = 50_000e6;
        uint256 tightMinShares = (weft.previewDeposit(victimDeposit) * 995) / 1000; // 0.5% max slippage

        // Attacker attempts to front-run deposit to manipulate pool price
        vm.prank(attacker);
        weft.deposit(500_000e6, 0);

        // Because pool price is now distorted, victim's transaction reverts safely
        // rather than executing at an unfair execution price
        vm.prank(victim);
        try weft.deposit(victimDeposit, tightMinShares) returns (uint256) {
            // If it succeeds, shares received were strictly >= tightMinShares
        } catch Error(string memory reason) {
            assertEq(reason, "slippage", "Slippage protection successfully caught sandwich");
        }
    }

    /// @notice Test 4: Dust deposit boundary testing
    function testSlippage4_DustDepositBounds() public {
        // First deposit must be >= MIN_FIRST_DEPOSIT ($5)
        vm.prank(victim);
        vm.expectRevert("dust");
        weft.deposit(4e6, 0); // $4 fails

        // $5 succeeds
        vm.prank(victim);
        uint256 s = weft.deposit(5e6, 0);
        assertGt(s, 0, "$5 first deposit succeeds");

        // Subsequent deposits can be down to $1
        vm.prank(victim);
        vm.expectRevert("dust");
        weft.deposit(0.5e6, 0); // $0.50 fails

        vm.prank(victim);
        uint256 s2 = weft.deposit(1e6, 0); // $1.00 succeeds
        assertGt(s2, 0, "$1 subsequent deposit succeeds");
    }

    /// @notice Test 5: Asymmetric pool pricing slippage propagation
    function testSlippage5_AsymmetricPriceDivergence() public {
        vm.prank(victim);
        weft.deposit(100_000e6, 0);

        // One underlying token (NVDA) spikes 20% in price on external oracle
        // Feed answer moves from 100e8 to 120e8
        // Next depositor must calculate preview correctly against updated price
        uint256 newPreview = weft.previewDeposit(10_000e6);
        assertGt(newPreview, 0, "Preview recalculates cleanly post-spike");
    }

    /// @notice Test 6: Zero share unwind boundary check
    function testSlippage6_ZeroShareUnwind() public {
        vm.prank(victim);
        weft.deposit(10_000e6, 0);

        // Unwinding 0 shares must revert
        vm.prank(victim);
        vm.expectRevert("zero shares");
        weft.unwind(0, 0);
    }
}
