/**
 * TRON / TRC-20 deposit scanning via Tronscan.
 *
 * Tronscan is used rather than TronGrid because it is the provider whose key we
 * actually hold and verified working. Endpoint:
 *
 *   GET https://apilist.tronscanapi.com/api/token_trc20/transfers
 *       ?relatedAddress=<address>&limit=...&start=0&sort=-timestamp
 *   Header: TRON-PRO-API-KEY: <key>
 *
 * The parsing and settlement logic is pure so it can be tested against fixtures
 * without touching the network; only the two fetch helpers below talk to HTTP.
 *
 * Verified response shape (live, 2026-10-15):
 * {
 *   "total": 9, "rangeTotal": 9,
 *   "token_transfers": [{
 *     "transaction_id": "18b9...",
 *     "status": 0,
 *     "block_ts": 1782515850000,
 *     "from_address": "TMmV...",
 *     "to_address": "TBnM...",
 *     "block": 83948743,
 *     "contract_address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
 *     "quant": "67000000",
 *     "confirmed": true,
 *     "contractRet": "SUCCESS"
 *   }]
 * }
 */

/** Canonical USDT contract on TRON mainnet. */
export const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"

/** USDT uses 6 decimals: `quant: "67000000"` is 67.000000 USDT. */
export const TRON_USDT_DECIMALS = 6

const TRONSCAN_BASE = "https://apilist.tronscanapi.com/api"

export type NormalizedTransfer = {
  /** Transaction hash. Used as the idempotency key so one transfer settles once. */
  txHash: string
  from: string
  to: string
  /** Token contract moved by this transfer. */
  contract: string
  /** Amount in the token's smallest unit. Never a float. */
  amountRaw: bigint
  decimals: number
  /** Block time, milliseconds since epoch. */
  timestampMs: number
  /** Block height, when reported. */
  blockNumber?: number
  /** Tronscan's own confirmation flag. */
  confirmed: boolean
  /** `contractRet` — must be SUCCESS for the transfer to have succeeded. */
  result: string
}

export type TronscanTransfersResponse = {
  total?: number
  rangeTotal?: number
  token_transfers?: Array<{
    transaction_id?: string
    status?: number
    block_ts?: number
    from_address?: string
    to_address?: string
    block?: number
    contract_address?: string
    quant?: string
    confirmed?: boolean
    contractRet?: string
  }>
}

/**
 * Decode a Tronscan transfer list into normalised inbound transfers.
 *
 * Rows are dropped unless they are a successful inbound transfer of the wanted
 * contract. Defaulting any of those fields instead would let a failed transfer
 * or an outgoing one be mistaken for a payment received.
 */
export function parseTronscanTransfers(
  response: TronscanTransfersResponse,
  options: { receivingAddress: string; contract?: string }
): NormalizedTransfer[] {
  const recipient = options.receivingAddress.trim()
  const wanted = (options.contract ?? TRON_USDT_CONTRACT).trim()
  const out: NormalizedTransfer[] = []

  for (const row of response.token_transfers ?? []) {
    const txHash = row.transaction_id?.trim()
    const contract = row.contract_address?.trim()
    const quant = row.quant?.trim()

    if (!txHash || !contract || !quant) continue

    // Only inbound transfers to the configured wallet count as payment.
    if (row.to_address?.trim() !== recipient) continue

    // Only the configured token contract.
    if (contract !== wanted) continue

    // A reverted or failed contract call moved no funds.
    if (row.contractRet && row.contractRet !== "SUCCESS") continue

    // The sender must not be the receiving wallet itself (e.g. a self-transfer
    // or an internal sweep), which would otherwise settle an order for free.
    if (row.from_address?.trim() === recipient) continue

    let amountRaw: bigint
    try {
      amountRaw = BigInt(quant)
    } catch {
      continue
    }

    if (amountRaw <= 0n) continue

    out.push({
      txHash,
      from: row.from_address?.trim() ?? "",
      to: recipient,
      contract,
      amountRaw,
      decimals: TRON_USDT_DECIMALS,
      timestampMs: Number(row.block_ts ?? 0),
      blockNumber:
        typeof row.block === "number" && row.block > 0 ? row.block : undefined,
      confirmed: row.confirmed === true,
      result: row.contractRet ?? "",
    })
  }

  return out
}

/**
 * Decide whether a transfer is safe to treat as settled.
 *
 * Three independent conditions must all hold. Tronscan must have flagged it
 * confirmed, a block height must be known so depth can actually be computed,
 * and the computed depth must reach the requirement. An unknown height is
 * treated as unconfirmed, never as confirmed.
 */
export function isTransferSettled(
  transfer: NormalizedTransfer,
  options: { currentBlock: number; requiredConfirmations: number }
): boolean {
  if (!transfer.confirmed) return false
  if (transfer.blockNumber === undefined) return false
  if (options.currentBlock < transfer.blockNumber) return false

  const confirmations = options.currentBlock - transfer.blockNumber + 1
  return confirmations >= options.requiredConfirmations
}

/** Convert a smallest-unit amount to a human decimal string for display. */
export function formatAmount(amountRaw: bigint, decimals: number): string {
  const negative = amountRaw < 0n
  const value = negative ? -amountRaw : amountRaw
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const frac = (value % base).toString().padStart(decimals, "0")
  return `${negative ? "-" : ""}${whole}.${frac}`
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function authHeaders(apiKey: string): Record<string, string> {
  return { "TRON-PRO-API-KEY": apiKey, Accept: "application/json" }
}

/**
 * Fetch recent TRC-20 transfers touching an address.
 *
 * `relatedAddress` returns both directions, so the caller must still filter to
 * inbound via `parseTronscanTransfers`.
 */
export async function fetchTrc20Transfers(
  address: string,
  options: { apiKey: string; limit?: number; signal?: AbortSignal }
): Promise<TronscanTransfersResponse> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const url =
    `${TRONSCAN_BASE}/token_trc20/transfers` +
    `?limit=${limit}&start=0&sort=-timestamp&count=true` +
    `&relatedAddress=${encodeURIComponent(address)}`

  const res = await fetch(url, {
    headers: authHeaders(options.apiKey),
    signal: options.signal,
  })

  if (!res.ok) {
    throw new Error(`Tronscan transfers request failed status=${res.status}`)
  }

  return (await res.json()) as TronscanTransfersResponse
}

/** Current TRON block height, used to compute confirmation depth. */
export async function fetchCurrentBlock(
  options: { apiKey: string; signal?: AbortSignal }
): Promise<number> {
  const res = await fetch(`${TRONSCAN_BASE}/block?sort=-number&limit=1`, {
    headers: authHeaders(options.apiKey),
    signal: options.signal,
  })

  if (!res.ok) {
    throw new Error(`Tronscan block request failed status=${res.status}`)
  }

  const json = (await res.json()) as {
    data?: Array<{ number?: number }>
    number?: number
  }

  const height = json.data?.[0]?.number ?? json.number
  if (typeof height !== "number" || height <= 0) {
    throw new Error("Tronscan block response did not contain a usable height")
  }

  return height
}
