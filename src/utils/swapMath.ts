import JSBI from 'jsbi'
import { FeeAmount } from '../constants'
import { NEGATIVE_ONE, ZERO } from '../internalConstants'
import { FullMath } from './fullMath'
import { SqrtPriceMath } from './sqrtPriceMath'

const MAX_FEE = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(6))

export abstract class SwapMath {
  /**
   * Cannot be constructed.
   */
  private constructor() {}
  public static computeSwapStep(
    sqrtRatioCurrentX96: JSBI,
    sqrtRatioTargetX96: JSBI,
    liquidity: JSBI,
    amountRemaining: JSBI,
    feePips: FeeAmount
  ): [JSBI, JSBI, JSBI, JSBI] {
    const returnValues: Partial<{
      sqrtRatioNextX96: JSBI
      amountIn: JSBI
      amountOut: JSBI
      feeAmount: JSBI
    }> = {}
    //sqrtRatioCurrentX96 > sqrtRatioTargetX96 means direction = Pb -> Pa <=> add zero, remove one <=> zeroForOne true
    const zeroForOne = JSBI.greaterThanOrEqual(sqrtRatioCurrentX96, sqrtRatioTargetX96)
    const exactIn = JSBI.greaterThanOrEqual(amountRemaining, ZERO)

    if (exactIn) {
      //reduce fee
      const amountRemainingLessFee = JSBI.divide(
        JSBI.multiply(amountRemaining, JSBI.subtract(MAX_FEE, JSBI.BigInt(feePips))),
        MAX_FEE
      )
      // calculate amount in between 2 ticks
      // if zeroForOne -> calc the input amount of token0 -> getAmount0Delta,
      //               -> sqrtRatioCurrentX96 > sqrtRatioTargetX96 -> Pa = sqrtRatioTargetX96
      //                                                              Pb = sqrtRatioCurrentX96
      // if !zeroForOne -> calc the input amount of token1 -> getAmount1Delta
      //                -> sqrtRatioCurrentX96 < sqrtRatioTargetX96 -> Pa = sqrtRatioCurrentX96
      //                                                               Pb = sqrtRatioTargetX96
      returnValues.amountIn = zeroForOne
        ? SqrtPriceMath.getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
        : SqrtPriceMath.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true)
      console.log(
        '====computeSwapStep',
        amountRemainingLessFee,
        returnValues.amountIn.toString(),
        JSBI.greaterThanOrEqual(amountRemainingLessFee, returnValues.amountIn!)
      )
      if (JSBI.greaterThanOrEqual(amountRemainingLessFee, returnValues.amountIn!)) {
        returnValues.sqrtRatioNextX96 = sqrtRatioTargetX96
      } else {
        // case amountIn calculated by next tick price > amountRemainingLessFee
        // so must to recalculate the sqrtRatioNextX96 by the amountRemainingLessFee
        // and update the amountin accordingly later, base on the recalculated sqrtRatioNextX96
        returnValues.sqrtRatioNextX96 = SqrtPriceMath.getNextSqrtPriceFromInput(
          sqrtRatioCurrentX96,
          liquidity,
          amountRemainingLessFee,
          zeroForOne
        )
        console.log('====computeSwapStep sqrtRatioNextX96', returnValues.sqrtRatioNextX96.toString())
      }
    } else {
      // exactOut
      // calculate amount out between 2 ticks
      // if zeroForOne -> calc the ouput amount of token1 -> getAmount1Delta
      //               -> sqrtRatioCurrentX96 > sqrtRatioTargetX96 -> Pa = sqrtRatioTargetX96
      //                                                              Pb = sqrtRatioCurrentX96
      // if !zeroForOne -> calc the ouput amount of token0 -> getAmount0Delta
      //                -> sqrtRatioCurrentX96 < sqrtRatioTargetX96 -> Pa = sqrtRatioCurrentX96
      //                                                               Pb = sqrtRatioTargetX96
      returnValues.amountOut = zeroForOne
        ? SqrtPriceMath.getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
        : SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false)
      if (JSBI.greaterThanOrEqual(JSBI.multiply(amountRemaining, NEGATIVE_ONE), returnValues.amountOut)) {
        returnValues.sqrtRatioNextX96 = sqrtRatioTargetX96
      } else {
        returnValues.sqrtRatioNextX96 = SqrtPriceMath.getNextSqrtPriceFromOutput(
          sqrtRatioCurrentX96,
          liquidity,
          JSBI.multiply(amountRemaining, NEGATIVE_ONE),
          zeroForOne
        )
      }
    }

    const max = JSBI.equal(sqrtRatioTargetX96, returnValues.sqrtRatioNextX96)

    //recalculate amountIn/Out base on sqrtRatioNextX96 recalculated if needed
    if (zeroForOne) {
      returnValues.amountIn =
        max && exactIn
          ? returnValues.amountIn
          : SqrtPriceMath.getAmount0Delta(returnValues.sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true)
      returnValues.amountOut =
        max && !exactIn
          ? returnValues.amountOut
          : SqrtPriceMath.getAmount1Delta(returnValues.sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false)
    } else {
      returnValues.amountIn =
        max && exactIn
          ? returnValues.amountIn
          : SqrtPriceMath.getAmount1Delta(sqrtRatioCurrentX96, returnValues.sqrtRatioNextX96, liquidity, true)
      returnValues.amountOut =
        max && !exactIn
          ? returnValues.amountOut
          : SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, returnValues.sqrtRatioNextX96, liquidity, false)
      console.log(
        '====computeSwapStep amountIn/amountOut recalculated',
        returnValues.amountOut?.toString(),
        SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, returnValues.sqrtRatioNextX96, liquidity, false).toString()
      )
    }

    if (!exactIn && JSBI.greaterThan(returnValues.amountOut!, JSBI.multiply(amountRemaining, NEGATIVE_ONE))) {
      returnValues.amountOut = JSBI.multiply(amountRemaining, NEGATIVE_ONE)
    }

    if (exactIn && JSBI.notEqual(returnValues.sqrtRatioNextX96, sqrtRatioTargetX96)) {
      // we didn't reach the target, so take the remainder of the maximum input as fee
      returnValues.feeAmount = JSBI.subtract(amountRemaining, returnValues.amountIn!)
    } else {
      returnValues.feeAmount = FullMath.mulDivRoundingUp(
        returnValues.amountIn!,
        JSBI.BigInt(feePips),
        JSBI.subtract(MAX_FEE, JSBI.BigInt(feePips))
      )
    }

    return [returnValues.sqrtRatioNextX96!, returnValues.amountIn!, returnValues.amountOut!, returnValues.feeAmount!]
  }
}
