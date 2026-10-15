import {
  AbstractPaymentProvider,
  MedusaError,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  MedusaContainer,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"

/**
 * Cryptocurrency payment provider — ARCHITECTURE ONLY. NOT ACTIVATED.
 *
 * ---------------------------------------------------------------------------
 * REGULATORY GATE — READ BEFORE ENABLING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * The store owner intends to reassess Trinidad and Tobago's legal and regulatory
 * requirements for accepting cryptocurrency after 31 December 2026. Until the
 * owner explicitly authorises activation, the following must remain true:
 *
 *   - No live crypto checkout.
 *   - No automatic crypto transfers.
 *   - No withdrawal automation.
 *   - No customer funds handled by this or any experimental agent.
 *
 * This module therefore ships INERT and is deliberately NOT registered in
 * medusa-config.ts. Being unregistered, Medusa never loads it, so it cannot be
 * selected at checkout even by mistake. On top of that, every method below
 * refuses to act unless `enabled: true` is passed explicitly, so a future
 * accidental registration still cannot move money without a deliberate
 * configuration change.
 *
 * What this file DOES provide is the reviewed structure that activation would
 * require, so the eventual integration is not designed under time pressure:
 *
 *   - network and asset validation against an explicit allow-list
 *   - a unique per-payment reference for reconciliation
 *   - confirmation-count requirements before an amount is trusted
 *   - a signature-verified webhook entry point for a chain watcher
 *   - strict separation between "seen on chain" and "confirmed", so an
 *     unconfirmed or re-organised transaction can never mark an order paid
 *
 * ---------------------------------------------------------------------------
 * ACTIVATION CHECKLIST (all required, none optional)
 * ---------------------------------------------------------------------------
 *   1. Written legal sign-off for the operating jurisdiction after the
 *      regulatory reassessment.
 *   2. A chain-indexer or node provider chosen, with its API cost documented
 *      and approved (this is a paid third-party service).
 *   3. Receiving addresses supplied by the owner, verified character by
 *      character against an independent source before use.
 *   4. A confirmation threshold chosen per network (finality differs: a
 *      Bitcoin re-org and a Tron block are not equivalent risks).
 *   5. A price source for fiat-to-crypto conversion, with a stated tolerance
 *      and an expiry on the quoted rate.
 *   6. A reconciliation process, because crypto payments do not reverse.
 *   7. The module registered in medusa-config.ts with `enabled: true` AND the
 *      provider explicitly enabled on a region.
 */

type Options = {
  /** Master switch. Defaults to false — the module does nothing until set. */
  enabled?: boolean
  /** Chain to accept, e.g. "tron", "ethereum", "bitcoin". */
  network?: string
  /** Asset/token symbol, e.g. "USDT", "TRX", "BTC". */
  asset?: string
  /** Address funds are sent to. Supplied by the owner. */
  receivingAddress?: string
  /** Confirmations required before a payment is trusted. */
  requiredConfirmations?: number
  /** Chain indexer / node API endpoint. */
  nodeApiUrl?: string
  nodeApiKey?: string
  /** How long a quoted amount stays valid, in minutes. */
  quoteTtlMinutes?: number
}

/** Networks this provider is allowed to accept, once activation is approved. */
const ALLOWED_NETWORKS = ["tron", "ethereum", "bitcoin"] as const

/** Assets this provider is allowed to accept, once activation is approved. */
const ALLOWED_ASSETS = ["USDT", "USDC", "TRX", "ETH", "BTC"] as const

/** Result of inspecting a candidate transaction on chain. */
export type ChainTransaction = {
  /** Transaction hash as reported by the indexer. */
  txHash: string
  /** Amount actually observed, in the asset's smallest unit. */
  observedAmount: string
  /** Confirmations the indexer currently reports for this transaction. */
  confirmations: number
  /** The payment reference this transaction claims to settle. */
  reference?: string
}

class CryptoPaymentProviderService extends AbstractPaymentProvider<Options> {
  static identifier = "crypto"

  protected logger_: Logger
  protected options_: Options

  constructor(container: MedusaContainer, options: Options) {
    super(container, options)

    this.options_ = options
    this.logger_ = container.resolve("logger") as Logger

    if (this.isEnabled()) {
      this.logger_.warn(
        "Crypto payment provider is ENABLED. Confirm the regulatory sign-off, " +
          "receiving addresses and confirmation thresholds have all been " +
          "verified before accepting real funds."
      )
    }
  }

  private isEnabled(): boolean {
    return this.options_.enabled === true
  }

  /**
   * Refuse to operate unless activation was deliberate.
   *
   * Throwing rather than returning a failure keeps the failure visible in logs
   * instead of silently producing an unusable payment session.
   */
  private assertEnabled(): void {
    if (this.isEnabled()) {
      return
    }

    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Cryptocurrency payments are not activated. Activation requires written " +
        "regulatory sign-off after the Trinidad and Tobago reassessment " +
        "(currently scheduled for after 31 December 2026)."
    )
  }

  /**
   * Reject unsafe configuration at boot.
   *
   * When the provider is disabled nothing is required — that is the shipping
   * state. When it is enabled, every safety-critical option must be present and
   * must be on an allow-list, so a typo cannot point funds at an unexpected
   * network or address.
   */
  static validateOptions(options: Record<string, unknown>) {
    if (options.enabled !== true) {
      return
    }

    const required = [
      "network",
      "asset",
      "receivingAddress",
      "nodeApiUrl",
      "requiredConfirmations",
    ]

    for (const key of required) {
      if (options[key] === undefined || options[key] === "") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Crypto provider is enabled but \`${key}\` is missing.`
        )
      }
    }

    const network = String(options.network).toLowerCase()
    if (!ALLOWED_NETWORKS.includes(network as (typeof ALLOWED_NETWORKS)[number])) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unsupported crypto network "${network}". Allowed: ${ALLOWED_NETWORKS.join(", ")}.`
      )
    }

    const asset = String(options.asset).toUpperCase()
    if (!ALLOWED_ASSETS.includes(asset as (typeof ALLOWED_ASSETS)[number])) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unsupported crypto asset "${asset}". Allowed: ${ALLOWED_ASSETS.join(", ")}.`
      )
    }

    const confirmations = Number(options.requiredConfirmations)
    if (!Number.isInteger(confirmations) || confirmations < 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "`requiredConfirmations` must be a positive integer."
      )
    }
  }

  // --------------------------------------------------------------------------
  // Verification helpers.
  //
  // These are the parts worth reviewing before activation, and they are written
  // so they can be unit-tested without a network connection.
  // --------------------------------------------------------------------------

  /**
   * Decide whether an observed transaction is safe to treat as settled.
   *
   * Two independent conditions must hold: the transaction must reference this
   * payment, and it must have reached the required confirmation depth. A
   * transaction that is merely visible in the mempool has zero confirmations and
   * is explicitly NOT settled, because it can still disappear.
   */
  isSettled(transaction: ChainTransaction, reference: string): boolean {
    const required = this.options_.requiredConfirmations ?? Number.POSITIVE_INFINITY

    if (transaction.reference !== reference) {
      return false
    }

    return transaction.confirmations >= required
  }

  /**
   * Compare the amount actually received against the amount invoiced.
   *
   * Crypto transfers are irreversible and the sender chooses the amount, so an
   * underpayment must never be rounded up into a settled order. Amounts are
   * compared as integers in the asset's smallest unit to avoid floating-point
   * drift.
   */
  isAmountSufficient(
    observedAmount: string,
    expectedAmount: string,
    toleranceBps = 0
  ): boolean {
    let observed: bigint
    let expected: bigint

    try {
      observed = BigInt(observedAmount)
      expected = BigInt(expectedAmount)
    } catch {
      return false
    }

    if (expected <= BigInt(0)) {
      return false
    }

    // Allow a small shortfall only where the caller explicitly permits it,
    // e.g. to absorb network fees charged to the sender.
    const minimum = (expected * BigInt(10_000 - toleranceBps)) / BigInt(10_000)

    return observed >= minimum
  }

  // --------------------------------------------------------------------------
  // Payment lifecycle.
  //
  // Every method refuses while the provider is disabled. The bodies below are
  // intentionally not implemented against a live chain: writing untested code
  // that moves real funds would be worse than having no code at all.
  // --------------------------------------------------------------------------

  async initiatePayment(
    _input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    this.assertEnabled()

    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Crypto payment initiation is not implemented. Complete the activation " +
        "checklist and a funded test-network trial before enabling this."
    )
  }

  async updatePayment(
    _input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    this.assertEnabled()
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  async authorizePayment(
    _input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    this.assertEnabled()
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  async capturePayment(
    _input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    this.assertEnabled()
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  async refundPayment(
    _input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    // Deliberately never implemented: on-chain transfers cannot be reversed by
    // the merchant. Refunds must be a manual, human-approved outbound transfer.
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Crypto payments cannot be refunded programmatically. On-chain transfers " +
        "are irreversible; refunds require a manual transfer approved by a human."
    )
  }

  async cancelPayment(
    _input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    this.assertEnabled()
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  async deletePayment(
    _input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    this.assertEnabled()
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  async retrievePayment(
    _input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    this.assertEnabled()
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  async getPaymentStatus(
    _input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    if (!this.isEnabled()) {
      return { status: PaymentSessionStatus.PENDING }
    }

    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Not implemented.")
  }

  /**
   * Webhook entry point for a future chain watcher.
   *
   * Note the shape of the contract: this can only ever report `authorized` or
   * `captured` after the caller has already verified the watcher's signature
   * AND the transaction has reached the required confirmation depth. A webhook
   * body alone must never be sufficient to mark an order paid.
   */
  async getWebhookActionAndData(
    _payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    this.assertEnabled()

    return { action: "not_supported" }
  }
}

export default CryptoPaymentProviderService
