// Early-momentum scalper for the pump.fun replay sprint (agent-fun/replay/v2).
//
// Idea, from measuring the dev window (Nov 2-3 2026, 1222 coins):
//   - Most coins die within a few dozen trades; only ~55 of 1123 end >20% above
//     their create price, but 526 coins cross +30% with >= 4 distinct buyers,
//     and those early risers keep running a median +27% more from the crossing.
//   - So: buy a coin ONCE, small, soon after it proves early momentum with real
//     buyers behind it, and exit fast on a take-profit, a stop, a trailing stop
//     or a hold limit. Never chase a coin that already ran far, never re-enter
//     a coin after an exit, never pyramid. Small size keeps the heavy fees
//     (125 bps a leg + 105k lamports a tx) survivable and keeps drawdown low.
//   - The 1%-of-real-reserve buy cap is not binding at this size: at the +30%
//     crossing the median real SOL reserve is ~7.3 SOL, so a 0.05 SOL buy fits
//     in a single reply for most coins.
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
/** Youngest age, in slots since the CreateEvent, at which a coin may be bought. */
const MIN_AGE_SLOTS = 2;
/** Oldest age at which a first buy may still be decided. */
const MAX_AGE_SLOTS = 1500;
/** Entry needs the price at least this far above the create price (bps). */
const MIN_UP_BPS = 3000;
/** ...and not further than this: never chase a coin that already ran far (bps). */
const MAX_UP_BPS = 15000;
/** Distinct non-creator buyers that must have bought before entry. */
const MIN_BUYERS = 4;
/** Net SOL bought by non-creator wallets before entry (lamports). */
const MIN_NET_FLOW_LAMPORTS = 1_000_000_000n;
/** Real SOL reserve the curve must hold at decision time (lamports). */
const MIN_REAL_SOL_LAMPORTS = 2_000_000_000n;
/** Take profit: position value at least this far above its cost (bps). */
const TP_BPS = 1500;
/** Stop loss: position value at most this far below its cost (bps). */
const SL_BPS = 1000;
/** Trailing stop: sell when value falls this far below its peak (bps). */
const TRAIL_BPS = 1200;
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
  buyers: Set<string>;
  /** Signed SOL lamports bought minus sold by non-creator wallets. */
  netFlow: bigint;
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

/** True when price num/den is at most `bps` above the reference price. */
function upAtMostBps(
  num: bigint,
  den: bigint,
  refNum: bigint,
  refDen: bigint,
  bps: number,
): boolean {
  return num * refDen * 10_000n <= refNum * den * BigInt(10_000 + bps);
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
            buyers: new Set(),
            netFlow: 0n,
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
        if (e.user !== c.creator) {
          if (e.is_buy) c.buyers.add(e.user);
          c.netFlow += e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount);
        }
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

    // --- entries: one small buy per young coin with proven momentum --------
    if (state.committedPositionCount() < MAX_OPEN) {
      for (const c of coins.values()) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() >= MAX_OPEN) break;
        if (c.entered || c.done) continue;
        const age = state.slot - c.createdSlot;
        if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
        if (c.trades < 4 || c.buyers.size < MIN_BUYERS) continue;
        if (c.netFlow < MIN_NET_FLOW_LAMPORTS) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
        const qNum = curve.virtual_quote_reserves;
        const qDen = curve.virtual_token_reserves;
        if (qDen === 0n) continue;
        if (!upAtLeastBps(qNum, qDen, c.createNum, c.createDen, MIN_UP_BPS)) continue;
        if (!upAtMostBps(qNum, qDen, c.createNum, c.createDen, MAX_UP_BPS)) continue;
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
