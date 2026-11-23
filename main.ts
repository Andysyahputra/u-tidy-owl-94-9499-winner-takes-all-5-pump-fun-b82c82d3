// Dip scalper for the pump.fun replay sprint (agent-fun/replay/v2).
//
// What the dev window (Nov 2-3 2026, 1222 coins) actually showed, measured
// offline on the raw tape before this was written:
//   - Buying breakouts loses: every momentum/launch variant tested came out
//     around -0.002 SOL per 0.05 SOL trade. Peaks are one-trade wicks, so no
//     trailing stop can bank them, and the 125 bps-a-leg curve fee plus the
//     105k-lamport tx fee (~2.9% a round trip) eats the rest.
//   - Buying the dip of a proven runner loses least: a coin that already ran
//     >= 50% over its create price, then pulled back 20-45% from its own
//     high while buyers step back in, bounces often enough that tight exits
//     (TP +20%, SL -6%, trail -10%) come out near breakeven, about
//     -0.0004 to -0.0009 SOL per trade over 130-200 trades, versus -0.002
//     for breakout entries. The recent-buying requirement matters: without
//     it the same dip loses 3x as much (falling knives).
//   - So this bot buys ONLY that dip, once per coin, small (0.05 SOL), and
//     exits fast. It never chases a breakout, never buys a launch, never
//     re-enters a coin after an exit, never pyramids.
//
// Deterministic by construction: no clock, no randomness, no I/O, iteration
// only over insertion-ordered maps fed by the batch stream (hello, batch,
// orders, slot all come from the harness).

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

/** SOL to put into one coin (0.05 SOL). */
const STAKE_LAMPORTS = 50_000_000n;
/** Smallest single buy worth paying the 105k-lamport tx fee for (0.02 SOL). */
const MIN_BUY_LAMPORTS = 20_000_000n;
/** Most open positions at once (harness cap is 5). */
const MAX_OPEN = 5;
/** Oldest age, in slots since the CreateEvent, at which a first buy may still be decided. */
const MAX_AGE_SLOTS = 4000;
/** The coin's high must be at least this far above its create price (bps). */
const MIN_RUN_BPS = 5000;
/** Entry needs the price this far below the coin's own high (bps): lower bound. */
const PULLBACK_MIN_BPS = 2000;
/** ...and not further than this: a collapse, not a dip (bps). */
const PULLBACK_MAX_BPS = 4500;
/** Real SOL reserve the curve must hold at decision time (lamports). */
const MIN_REAL_SOL_LAMPORTS = 2_000_000_000n;
/** Take profit: position value at least this far above its cost (bps). */
const TP_BPS = 2000;
/** Stop loss: position value at most this far below its cost (bps). */
const SL_BPS = 600;
/** Trailing stop: sell when value falls this far below its peak (bps). */
const TRAIL_BPS = 1000;
/** Exit after holding this many slots regardless. */
const MAX_HOLD_SLOTS = 2000;
/** Slippage allowed on buys / sells (bps). */
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1500;

interface Coin {
  mint: Pubkey;
  createdSlot: number;
  creator: string;
  /** Create price as virtual_quote / virtual_token. */
  createNum: bigint;
  createDen: bigint;
  trades: number;
  /** Highest price seen since the create, as virtual_quote / virtual_token. */
  highNum: bigint;
  highDen: bigint;
  /** Signed SOL lamports of the last 5 non-creator trades (recent flow). */
  recent: bigint[];
  /** The most recent trade on this coin was a buy. */
  lastIsBuy: boolean;
  /** Bought once already (a pending or filled buy). */
  entered: boolean;
  /** Exited already: never re-enter. */
  done: boolean;
  /** Slot the buy was decided on. */
  buySlot: number;
  /** Best position value seen since the buy (lamports). */
  peakValue: bigint;
}

/** Compare two prices a/b and c/d: returns -1, 0 or 1 for a/b vs c/d. */
function cmpRatio(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): number {
  const left = aNum * bDen;
  const right = bNum * aDen;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when price num/den is at least `bps` above the reference price. */
function upAtLeastBps(
  num: bigint,
  den: bigint,
  refNum: bigint,
  refDen: bigint,
  bps: number,
): boolean {
  // num/den >= refNum/refDen * (10000 + bps) / 10000
  return num * refDen * 10_000n >= refNum * den * BigInt(10_000 + bps);
}

/** True when price num/den is at most `bps` below the reference price. */
function downAtMostBps(
  num: bigint,
  den: bigint,
  refNum: bigint,
  refDen: bigint,
  bps: number,
): boolean {
  // num/den >= refNum/refDen * (10000 - bps) / 10000
  return num * refDen * 10_000n >= refNum * den * BigInt(10_000 - bps);
}

/** Position value in lamports at the curve's current reserves. */
function positionValue(tokens: bigint, curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): bigint {
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

const coins = new Map<Pubkey, Coin>();

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // --- fold this batch's events into the per-coin tape -----------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            createNum: BigInt(e.virtual_quote_reserves),
            createDen: BigInt(e.virtual_token_reserves),
            trades: 0,
            highNum: BigInt(e.virtual_quote_reserves),
            highDen: BigInt(e.virtual_token_reserves),
            recent: [],
            lastIsBuy: false,
            entered: false,
            done: false,
            buySlot: -1,
            peakValue: 0n,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        c.trades += 1;
        // Track the coin's own high: the dip is measured against it.
        if (cmpRatio(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves), c.highNum, c.highDen) > 0) {
          c.highNum = BigInt(e.virtual_quote_reserves);
          c.highDen = BigInt(e.virtual_token_reserves);
        }
        if (e.user !== c.creator) {
          const signed = e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount);
          c.recent.push(signed);
          if (c.recent.length > 5) c.recent.shift();
        }
        c.lastIsBuy = e.is_buy;
      } else {
        // CompleteEvent: the curve is over; never enter it again.
        const c = coins.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // --- exits first: protect what is held --------------------------------
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const c = coins.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = positionValue(holding.token_amount, curve);
      if (c !== undefined && value > c.peakValue) c.peakValue = value;
      const cost = holding.cost_lamports;
      const heldSlots = c !== undefined && c.buySlot >= 0 ? state.slot - c.buySlot : 0;
      const takeProfit = value * 10_000n >= cost * BigInt(10_000 + TP_BPS);
      const stopLoss = value * 10_000n <= cost * BigInt(10_000 - SL_BPS);
      const trailing =
        c !== undefined &&
        c.peakValue > 0n &&
        value * 10_000n <= c.peakValue * BigInt(10_000 - TRAIL_BPS);
      const stale = heldSlots >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        if (c !== undefined) c.done = true;
      }
    }

    // --- entries: one small dip-buy per proven runner ----------------------
    if (state.committedPositionCount() < MAX_OPEN) {
      for (const c of coins.values()) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() >= MAX_OPEN) break;
        if (c.entered || c.done) continue;
        const age = state.slot - c.createdSlot;
        if (age < 2 || age > MAX_AGE_SLOTS) continue;
        if (c.trades < 5) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
        const qNum = curve.virtual_quote_reserves;
        const qDen = curve.virtual_token_reserves;
        if (qDen === 0n) continue;
        // The coin must have run at least 50% over its create price...
        if (!upAtLeastBps(c.highNum, c.highDen, c.createNum, c.createDen, MIN_RUN_BPS)) continue;
        // ...and now sit 20-45% below that high (a dip, not a collapse)...
        if (!downAtMostBps(qNum, qDen, c.highNum, c.highDen, PULLBACK_MAX_BPS)) continue;
        if (upAtLeastBps(qNum, qDen, c.highNum, c.highDen, -PULLBACK_MIN_BPS)) continue;
        // ...with buyers stepping back in: the last 5 non-creator trades net
        // buy, and the most recent trade is a buy.
        let recentFlow = 0n;
        for (const f of c.recent) recentFlow += f;
        if (recentFlow <= 0n) continue;
        if (!c.lastIsBuy) continue;
        const cap = state.maxBuyLamports(c.mint);
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (amount < MIN_BUY_LAMPORTS) continue;
        if (state.freeCashLamports() < amount + txFee) continue;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        c.entered = true;
        c.buySlot = state.slot;
        c.peakValue = 0n;
      }
    }

    return orders;
  },
});
