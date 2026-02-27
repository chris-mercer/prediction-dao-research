// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CTF1155.sol";

/**
 * @title LMSRMarketMaker
 * @notice Logarithmic Market Scoring Rule automated market maker for prediction markets
 * @dev Provides always-available liquidity for binary outcome markets using LMSR cost function.
 *
 * Cost function: C(q) = b * ln(e^(q_pass/b) + e^(q_fail/b))
 * Price of PASS: p_pass = e^(q_pass/b) / (e^(q_pass/b) + e^(q_fail/b))
 *
 * The LMSR guarantees:
 *   - Prices always between 0 and 1 (sum to 1 for binary markets)
 *   - Always-available liquidity (no counterparty needed)
 *   - Maximum loss bounded by b * ln(2) for binary markets
 *   - Prices move smoothly based on demand
 *
 * Supplements the EIP-712 orderbook (PredictionMarketExchange.sol) for large traders.
 * The AMM provides baseline liquidity and price discovery; the orderbook allows
 * limit orders for sophisticated participants.
 */
contract LMSRMarketMaker is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Market {
        uint256 marketId;           // ConditionalMarketFactory market ID
        address collateralToken;    // ERC20 collateral
        int256 qPass;              // Cumulative PASS quantity (can be negative from sells)
        int256 qFail;              // Cumulative FAIL quantity
        uint256 b;                  // Liquidity parameter (higher = more liquid, more subsidy)
        uint256 funding;            // Total collateral deposited as subsidy
        bool active;
        CTF1155 ctf;               // Conditional token contract
        bytes32 conditionId;       // CTF condition for this market
        uint256 passPositionId;    // CTF position ID for PASS
        uint256 failPositionId;    // CTF position ID for FAIL
    }

    mapping(uint256 => Market) public markets; // marketId => Market
    uint256 public marketCount;

    // Fixed-point math: we use 1e18 precision throughout
    uint256 private constant PRECISION = 1e18;
    // Maximum exponent to prevent overflow (e^88 ≈ 1.65e38, fits in uint256)
    int256 private constant MAX_EXP_INPUT = 88 * int256(PRECISION);

    event MarketFunded(uint256 indexed marketId, uint256 amount, uint256 b);
    event TokensBought(uint256 indexed marketId, address indexed buyer, bool buyPass, uint256 cost, uint256 amount);
    event TokensSold(uint256 indexed marketId, address indexed seller, bool sellPass, uint256 proceeds, uint256 amount);
    event MarketClosed(uint256 indexed marketId);

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Fund a new LMSR market
     * @param marketId ConditionalMarketFactory market ID
     * @param collateralToken ERC20 collateral address
     * @param b Liquidity parameter (in collateral token decimals)
     * @param fundingAmount Initial collateral subsidy
     * @param ctf CTF1155 contract address
     * @param conditionId CTF condition ID for this market
     * @param passPositionId CTF position ID for PASS outcome
     * @param failPositionId CTF position ID for FAIL outcome
     */
    function fundMarket(
        uint256 marketId,
        address collateralToken,
        uint256 b,
        uint256 fundingAmount,
        address ctf,
        bytes32 conditionId,
        uint256 passPositionId,
        uint256 failPositionId
    ) external onlyOwner {
        require(!markets[marketId].active, "Market already funded");
        require(b > 0, "b must be positive");
        require(fundingAmount > 0, "Funding must be positive");
        require(collateralToken != address(0), "Invalid collateral");
        require(ctf != address(0), "Invalid CTF");

        // Transfer funding collateral from owner
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), fundingAmount);

        markets[marketId] = Market({
            marketId: marketId,
            collateralToken: collateralToken,
            qPass: 0,
            qFail: 0,
            b: b,
            funding: fundingAmount,
            active: true,
            ctf: CTF1155(ctf),
            conditionId: conditionId,
            passPositionId: passPositionId,
            failPositionId: failPositionId
        });

        marketCount++;
        emit MarketFunded(marketId, fundingAmount, b);
    }

    /**
     * @notice Buy outcome tokens from the LMSR
     * @param marketId Market ID
     * @param buyPass True for PASS tokens, false for FAIL
     * @param amount Number of outcome tokens to buy
     * @return cost Collateral cost for the purchase
     */
    function buy(
        uint256 marketId,
        bool buyPass,
        uint256 amount
    ) external nonReentrant returns (uint256 cost) {
        Market storage m = markets[marketId];
        require(m.active, "Market not active");
        require(amount > 0, "Amount must be positive");

        // Calculate cost using LMSR: cost = C(q_new) - C(q_old)
        int256 iAmount = int256(amount);
        int256 newQPass = buyPass ? m.qPass + iAmount : m.qPass;
        int256 newQFail = buyPass ? m.qFail : m.qFail + iAmount;

        uint256 costNew = _costFunction(newQPass, newQFail, m.b);
        uint256 costOld = _costFunction(m.qPass, m.qFail, m.b);

        require(costNew >= costOld, "Cost calculation error");
        cost = costNew - costOld;
        require(cost <= m.funding, "Insufficient market funding");

        // Collect collateral from buyer
        IERC20(m.collateralToken).safeTransferFrom(msg.sender, address(this), cost);

        // Update quantities
        if (buyPass) {
            m.qPass += iAmount;
        } else {
            m.qFail += iAmount;
        }

        // Mint conditional tokens to buyer via CTF split
        // (In production, this would interact with CTF1155 to mint position tokens)
        // For now, transfer from market's CTF balance
        m.ctf.safeTransferFrom(
            address(this),
            msg.sender,
            buyPass ? m.passPositionId : m.failPositionId,
            amount,
            ""
        );

        emit TokensBought(marketId, msg.sender, buyPass, cost, amount);
    }

    /**
     * @notice Sell outcome tokens back to the LMSR
     * @param marketId Market ID
     * @param sellPass True for PASS tokens, false for FAIL
     * @param amount Number of outcome tokens to sell
     * @return proceeds Collateral returned
     */
    function sell(
        uint256 marketId,
        bool sellPass,
        uint256 amount
    ) external nonReentrant returns (uint256 proceeds) {
        Market storage m = markets[marketId];
        require(m.active, "Market not active");
        require(amount > 0, "Amount must be positive");

        // Calculate proceeds: proceeds = C(q_old) - C(q_new)
        int256 iAmount = int256(amount);
        int256 newQPass = sellPass ? m.qPass - iAmount : m.qPass;
        int256 newQFail = sellPass ? m.qFail : m.qFail - iAmount;

        uint256 costOld = _costFunction(m.qPass, m.qFail, m.b);
        uint256 costNew = _costFunction(newQPass, newQFail, m.b);

        require(costOld >= costNew, "Cost calculation error");
        proceeds = costOld - costNew;

        // Collect outcome tokens from seller
        m.ctf.safeTransferFrom(
            msg.sender,
            address(this),
            sellPass ? m.passPositionId : m.failPositionId,
            amount,
            ""
        );

        // Update quantities
        if (sellPass) {
            m.qPass -= iAmount;
        } else {
            m.qFail -= iAmount;
        }

        // Return collateral to seller
        IERC20(m.collateralToken).safeTransfer(msg.sender, proceeds);

        emit TokensSold(marketId, msg.sender, sellPass, proceeds, amount);
    }

    /**
     * @notice Close a market (after resolution)
     * @param marketId Market ID
     */
    function closeMarket(uint256 marketId) external onlyOwner {
        markets[marketId].active = false;
        emit MarketClosed(marketId);
    }

    // =========================================================================
    // LMSR cost function
    // =========================================================================

    /**
     * @notice LMSR cost function: C(q) = b * ln(e^(q_pass/b) + e^(q_fail/b))
     * @dev Uses fixed-point arithmetic with 1e18 precision.
     *   For numerical stability, we factor out the max exponent:
     *   C(q) = b * (max(q_pass, q_fail)/b + ln(1 + e^(-|q_pass - q_fail|/b)))
     * @param qPass Cumulative PASS quantity
     * @param qFail Cumulative FAIL quantity
     * @param b Liquidity parameter
     * @return cost Cost value
     */
    function _costFunction(int256 qPass, int256 qFail, uint256 b) internal pure returns (uint256 cost) {
        // Use log-sum-exp trick for numerical stability:
        // ln(e^a + e^b) = max(a,b) + ln(1 + e^(-|a-b|))
        int256 ib = int256(b);
        require(ib > 0, "b must be positive");

        // a = qPass / b, b_val = qFail / b (both in PRECISION scale)
        int256 a = (qPass * int256(PRECISION)) / ib;
        int256 bVal = (qFail * int256(PRECISION)) / ib;

        int256 maxVal = a > bVal ? a : bVal;
        int256 diff = a > bVal ? a - bVal : bVal - a;

        // Clamp diff to prevent overflow in exp
        if (diff > MAX_EXP_INPUT) {
            // When diff is very large, ln(1 + e^(-diff)) ≈ 0
            // So cost ≈ b * maxVal / PRECISION
            if (maxVal >= 0) {
                cost = (b * uint256(maxVal)) / PRECISION;
            } else {
                cost = 0;
            }
            return cost;
        }

        // ln(1 + e^(-diff)) using Taylor approximation for small values
        // or lookup for larger values
        uint256 expNegDiff = _expFixed(-diff);
        uint256 lnTerm = _lnOnePlus(expNegDiff);

        // cost = b * (maxVal + lnTerm) / PRECISION
        int256 totalScaled = maxVal + int256(lnTerm);
        if (totalScaled <= 0) return 0;
        cost = (b * uint256(totalScaled)) / PRECISION;
    }

    /**
     * @notice Get current LMSR prices for a market
     * @param marketId Market ID
     * @return passPrice PASS price in 18-decimal (0.5e18 = 50%)
     * @return failPrice FAIL price in 18-decimal
     */
    function getPrices(uint256 marketId) external view returns (uint256 passPrice, uint256 failPrice) {
        Market storage m = markets[marketId];
        if (!m.active) return (0.5e18, 0.5e18);

        int256 ib = int256(m.b);
        int256 diff = ((m.qPass - m.qFail) * int256(PRECISION)) / ib;

        if (diff > MAX_EXP_INPUT) return (PRECISION, 0);
        if (diff < -MAX_EXP_INPUT) return (0, PRECISION);

        // p_pass = e^(qPass/b) / (e^(qPass/b) + e^(qFail/b))
        //        = 1 / (1 + e^((qFail - qPass)/b))
        //        = 1 / (1 + e^(-diff))
        uint256 expNegDiff = _expFixed(-diff);
        passPrice = (PRECISION * PRECISION) / (PRECISION + expNegDiff);
        failPrice = PRECISION - passPrice;
    }

    /**
     * @notice Calculate cost to buy a given amount of tokens
     * @param marketId Market ID
     * @param buyPass True for PASS, false for FAIL
     * @param amount Number of tokens
     * @return cost Collateral cost
     */
    function calcBuyCost(uint256 marketId, bool buyPass, uint256 amount) external view returns (uint256 cost) {
        Market storage m = markets[marketId];
        int256 iAmount = int256(amount);
        int256 newQPass = buyPass ? m.qPass + iAmount : m.qPass;
        int256 newQFail = buyPass ? m.qFail : m.qFail + iAmount;

        uint256 costNew = _costFunction(newQPass, newQFail, m.b);
        uint256 costOld = _costFunction(m.qPass, m.qFail, m.b);
        cost = costNew >= costOld ? costNew - costOld : 0;
    }

    // =========================================================================
    // Fixed-point math helpers
    // =========================================================================

    /**
     * @notice Fixed-point exponential: e^x where x is in 1e18 precision
     * @dev Uses a 6th-order Taylor series for |x| < 2. For larger values,
     *   uses repeated squaring: e^x = (e^(x/2))^2
     */
    function _expFixed(int256 x) internal pure returns (uint256) {
        if (x == 0) return PRECISION;

        bool negative = x < 0;
        uint256 ax = negative ? uint256(-x) : uint256(x);

        // For very large values, cap
        if (ax > uint256(MAX_EXP_INPUT)) {
            return negative ? 0 : type(uint256).max / PRECISION;
        }

        // Reduce x into range [0, 1) by factoring out integer part
        // e^x = e^(floor(x)) * e^(frac(x))
        uint256 intPart = ax / PRECISION;
        uint256 fracPart = ax % PRECISION;

        // e^(integer part) via repeated squaring of e
        // e ≈ 2.718281828e18
        uint256 E = 2718281828459045235;
        uint256 intExp = PRECISION;
        uint256 base = E;
        uint256 n = intPart;
        while (n > 0) {
            if (n % 2 == 1) {
                intExp = (intExp * base) / PRECISION;
            }
            base = (base * base) / PRECISION;
            n /= 2;
        }

        // e^(fractional part) via Taylor series: 1 + x + x^2/2! + x^3/3! + ...
        uint256 fracExp = PRECISION;
        uint256 term = fracPart;
        fracExp += term;                                    // x
        term = (term * fracPart) / (PRECISION * 2);
        fracExp += term;                                    // x^2/2
        term = (term * fracPart) / (PRECISION * 3);
        fracExp += term;                                    // x^3/6
        term = (term * fracPart) / (PRECISION * 4);
        fracExp += term;                                    // x^4/24
        term = (term * fracPart) / (PRECISION * 5);
        fracExp += term;                                    // x^5/120
        term = (term * fracPart) / (PRECISION * 6);
        fracExp += term;                                    // x^6/720

        uint256 result = (intExp * fracExp) / PRECISION;

        if (negative) {
            // e^(-x) = 1/e^x
            return (PRECISION * PRECISION) / result;
        }
        return result;
    }

    /**
     * @notice Fixed-point ln(1 + x) where x is in 1e18 precision, x >= 0
     * @dev Uses Taylor series: ln(1+x) = x - x^2/2 + x^3/3 - x^4/4 + ...
     *   Converges for 0 <= x <= 1. For x > 1, use ln(1+x) = ln(2) + ln((1+x)/2)
     */
    function _lnOnePlus(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;

        // For x > 1e18, reduce
        uint256 shifts = 0;
        uint256 val = x;
        // ln(1 + x) = shifts * ln(2) + ln(1 + reduced)
        while (val > PRECISION) {
            val = (val + PRECISION) / 2 - PRECISION; // reduced = (1+x)/2 - 1 = (x-1)/2
            // Actually: (1+x)/2 = (PRECISION + val_orig)/2, so new (1+x') = (PRECISION + val_orig)/2
            // val' = new_x = (PRECISION + val_orig)/2 - PRECISION = (val_orig - PRECISION)/2
            // This only works if val_orig > PRECISION
            shifts++;
            if (shifts > 128) break; // Safety
        }

        // Taylor series for ln(1+x), 0 <= x <= 1
        // ln(1+x) ≈ x - x^2/2 + x^3/3 - x^4/4 + x^5/5 - x^6/6
        uint256 result = val;                                          // x
        uint256 term = (val * val) / PRECISION;
        result -= term / 2;                                            // -x^2/2
        term = (term * val) / PRECISION;
        result += term / 3;                                            // +x^3/3
        term = (term * val) / PRECISION;
        result -= term / 4;                                            // -x^4/4
        term = (term * val) / PRECISION;
        result += term / 5;                                            // +x^5/5
        term = (term * val) / PRECISION;
        result -= term / 6;                                            // -x^6/6

        // Add back: shifts * ln(2)
        // ln(2) ≈ 0.693147180559945e18
        uint256 LN2 = 693147180559945309;
        result += shifts * LN2;

        return result;
    }

    // ERC1155 receiver (required for CTF1155 interactions)
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0; // IERC1155Receiver
    }
}
