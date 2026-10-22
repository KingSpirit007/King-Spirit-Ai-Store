/**
 * Matching an on-chain transfer to the order that is waiting for it.
 *
 * This is the hardest correctness problem in direct-to-wallet crypto payments,
 * and it is where money is most easily lost. A TRC-20 transfer carries no memo,
 * so nothing on chain names the order it pays for. Two orders for the same
 * amount are therefore indistinguishable by amount alone, and a customer paying
 * slightly the wrong amount would otherwise never match.
 *
 * The approach used here is a unique amount tag. Each payment session is quoted
 * an amount whose low-order digits are derived from the session id, so the exact
 * figure seen on chain identifies one order. The tag is a fraction of a cent, so
 * it is not a meaningful surcharge.
 *
 * Everything in this file is pure so it can be tested without a chain.
 */

/** How many distinct low-order tags are available. */
const TAG_SPACE = 10_000n

/**
 * Derive a stable tag in [0, 10000) from a session id.
 *
 * A simple deterministic hash is sufficient: the goal is only to spread
 * concurrent sessions across the tag space so two live orders rarely collide.
 * It is not a security primitive.
 */
export function deriveAmountTag(sessionId: string): bigint {
  let hash = 2166136261n // FNV-1a offset basis
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= BigInt(sessionId.charCodeAt(i))
    hash = (hash * 16777619n) & 0xffffffffn
  }
  return hash % TAG_SPACE
}

/**
 * Produce the exact amount to quote, in the token's smallest unit.
 *
 * The base amount is expressed in the token's smallest unit, so no floating
 * point arithmetic is involved at any stage.
 *
 * `tagDigits` controls how many of the smallest digits the tag occupies, and
 * must match between quoting and matching. For a 6-decimal stablecoin,
 * `tagDigits: 4` reserves the last four digits — a maximum surcharge of
 * 0.0099 USDT, under one cent.
 */
export function quoteAmountWithTag(
  baseAmountRaw: bigint,
  sessionId: string,
  tagDigits = 4
): bigint {
  if (tagDigits < 1 || tagDigits > 6) {
    throw new Error("tagDigits must be between 1 and 6")
  }

  const modulus = 10n ** BigInt(tagDigits)
  const tag = deriveAmountTag(sessionId) % modulus
  const truncated = baseAmountRaw - (baseAmountRaw % modulus)

  return truncated + tag
}

export type MatchCandidate = {
  txHash: string
  amountRaw: bigint
  timestampMs: number
}

export type MatchResult =
  | { status: "matched"; transfer: MatchCandidate }
  | { status: "none" }
  | { status: "ambiguous"; transfers: MatchCandidate[] }

/**
 * Find the transfer that settles a quote.
 *
 * Returns `ambiguous` rather than guessing when more than one candidate carries
 * the exact quoted amount. Paying out against the wrong one of two identical
 * deposits is worse than asking a human to look, so the caller is expected to
 * stop and surface it.
 *
 * Transfers older than the quote's window are ignored: without that, an old
 * payment of the same amount would settle a brand-new order.
 */
export function matchTransferToQuote(
  transfers: MatchCandidate[],
  options: {
    /** The exact amount quoted, including the tag. */
    expectedAmountRaw: bigint
    /** Quote creation time; transfers at or after this are candidates. */
    quotedAtMs: number
    /** How long the quote stays valid. */
    windowMs: number
    /** Transfers already used to settle other orders, by tx hash. */
    alreadyUsedTxHashes?: Iterable<string>
  }
): MatchResult {
  const used = new Set(options.alreadyUsedTxHashes ?? [])
  const expiresAt = options.quotedAtMs + options.windowMs

  const candidates = transfers.filter(
    (t) =>
      t.amountRaw === options.expectedAmountRaw &&
      t.timestampMs >= options.quotedAtMs &&
      t.timestampMs <= expiresAt &&
      !used.has(t.txHash)
  )

  if (candidates.length === 0) {
    return { status: "none" }
  }

  if (candidates.length > 1) {
    return { status: "ambiguous", transfers: candidates }
  }

  return { status: "matched", transfer: candidates[0] }
}

/**
 * Convert a fiat price into a token amount in the smallest unit.
 *
 * `pricePerToken` is the fiat value of one whole token. Rounding is half-up on
 * the smallest unit so the store never asks for less than the fiat total, which
 * would leave every order marginally underpaid.
 */
export function fiatToTokenAmount(
  fiatAmount: number,
  pricePerToken: number,
  decimals: number
): bigint {
  if (!(pricePerToken > 0)) {
    throw new Error("pricePerToken must be positive")
  }
  if (!(fiatAmount > 0)) {
    throw new Error("fiatAmount must be positive")
  }

  const scale = 10n ** BigInt(decimals)
  // Work in integer micro-units of fiat to avoid binary float drift.
  const fiatMicro = BigInt(Math.round(fiatAmount * 1_000_000))
  const priceMicro = BigInt(Math.round(pricePerToken * 1_000_000))

  return (fiatMicro * scale + priceMicro - 1n) / priceMicro
}
