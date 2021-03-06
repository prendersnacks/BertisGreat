import * as _ from "lodash";
import { BigNumber, Contract, Wallet, utils } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { DAI_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";
import { min } from "lodash";
import { ChainId, Token, Fetcher, Route } from '@uniswap/sdk'

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  ETHER.mul(500),
  ETHER.mul(5000),
  ETHER.mul(50000),
  ETHER.mul(80000),
  ETHER.mul(100000),
  ETHER.mul(170000),
  ETHER.mul(200000),
  ETHER.mul(290000),
  ETHER.mul(300000),
  ETHER.mul(350000),
  ETHER.mul(400000),
  ETHER.mul(500000),
  ETHER.mul(600000),
  ETHER.mul(750000),
  ETHER.mul(885000),
  ETHER.mul(990000),
  ]
const chainId = ChainId.MAINNET
const WETH = new Token(
  ChainId.MAINNET,
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  18 ) 
const DAI = new Token(
  ChainId.MAINNET,
  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  18 ) 

const flashloanFeePercentage = 9 // (0.09%) or 9/10000
export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0]
    const buyFromMarket = crossedMarket[1]
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(DAI_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, DAI_ADDRESS, tokensOutFromBuyingSize)
      const profit = proceedsFromSellingTokens.sub(size);
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(DAI_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, DAI_ADDRESS, tryTokensOutFromBuyingSize)
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
        bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens
    const sellTokens = crossedMarket.sellToMarket.tokens
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    )
  }


  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
    const bestCrossedMarkets = new Array<CrossedMarketDetails>()

    for (const tokenAddress in marketsByToken) {
      const markets = marketsByToken[tokenAddress]
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, DAI_ADDRESS, ETHER.div(100)),
          sellTokenPrice: ethMarket.getTokensOut(DAI_ADDRESS, tokenAddress, ETHER.div(100)),
        }
      });

      const crossedMarkets = new Array<Array<EthMarket>>()
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, pm => {
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
          }
        })
      }

      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(ETHER.mul(10))) {
        bestCrossedMarkets.push(bestCrossedMarket)
      }
    }
    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
    return bestCrossedMarkets
  }

  // TODO: take more than 1
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
    for (const bestCrossedMarket of bestCrossedMarkets) {

      console.log("Send this much DAI", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(DAI_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(DAI_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);
      
      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
      const payloads: Array<string> = [...buyCalls.data, sellCallData]
      console.log({targets, payloads})
      const flashloanFee = bestCrossedMarket.volume.mul(flashloanFeePercentage).div(10000);
      const profitMinusFee = bestCrossedMarket.profit.sub(flashloanFee)
      
      try {
          const pair = await Fetcher.fetchPairData(
  	DAI,
  	WETH)
	
      const route = new Route([pair], DAI, WETH)
      const profitMinusFee2WETH = (profitMinusFee.mul(route.midPrice.toSignificant(6)).mul(1000000000000000000));
      console.log(profitMinusFee2WETH)
        const minerReward = profitMinusFee2WETH.mul(minerRewardPercentage).div(100);
        const profitMinusFeeMinusMinerReward = profitMinusFee2WETH.sub(minerReward)
        console.log("FL fee:", flashloanFee.toString())
        console.log("Miner reward:", minerReward.toString())
        console.log("Take home:", profitMinusFeeMinusMinerReward.toString())
        const ethersAbiCoder = new utils.AbiCoder()
        const typeParams = ['uint256', 'address[]', 'bytes[]']
        const inputParams = [minerReward.toString(), targets, payloads]
        const params = ethersAbiCoder.encode(typeParams, inputParams)
        // console.log(params)
      
        if (profitMinusFeeMinusMinerReward.gt(0)){

          const transaction = await this.bundleExecutorContract.populateTransaction.flashloan(DAI_ADDRESS, bestCrossedMarket.volume, params, {
            gasPrice: BigNumber.from(0),
            gasLimit: BigNumber.from(2000000),
          });
    
          try {
            const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
              {
                ...transaction,
                from: this.executorWallet.address
              })
            if (estimateGas.gt(2000000)) {
              console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
              continue
            }
            transaction.gasLimit = estimateGas.mul(2)
          } catch (e) {
            console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`)
            continue
          }
          const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      console.log(bundledTransactions)
      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
      //
      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )
      if ("error" in simulation || simulation.firstRevert !== undefined) {
        console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
        continue
      }
      console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      await Promise.all(bundlePromises)

        } else {
          console.log("Profit too low.")
          continue
        }
      
      } catch (e) {
        console.warn("Error setting miner and flashloan payment:", e);
      }

      return
    }
    throw new Error("No arbitrage submitted to relay")
  }

}
