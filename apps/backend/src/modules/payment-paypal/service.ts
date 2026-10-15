import {
  AbstractPaymentProvider,
  BigNumber,
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
 * PayPal Payment Module Provider.
 *
 * Uses the PayPal Orders v2 REST API with an `AUTHORIZE` intent, matching
 * Medusa's two-step authorize -> capture lifecycle.
 *
 * GUARANTEE: this provider never reports a payment as authorized or captured on
 * the basis of anything other than a status read back from PayPal itself. Every
 * state transition below is driven by the response to a real API call, so an
 * order cannot be marked paid because a client said so.
 *
 * The provider is only registered when PAYPAL_CLIENT_ID and
 * PAYPAL_CLIENT_SECRET are both present (see medusa-config.ts), so the store
 * keeps working exactly as before until real credentials are supplied.
 */

type Options = {
  clientId: string
  clientSecret: string
  /** Use the PayPal sandbox environment. Defaults to true. */
  sandbox?: boolean
  /** Webhook id used to verify inbound webhook signatures. */
  webhookId?: string
  /** Optional brand name shown on the PayPal approval page. */
  brandName?: string
}

type PayPalLink = { href: string; rel: string; method?: string }
type PayPalOrder = {
  id: string
  status: string
  links?: PayPalLink[]
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{ id: string; status: string }>
      authorizations?: Array<{ id: string; status: string }>
    }
  }>
}

const APPROVAL_REL = "approve"
const PAYER_ACTION_REL = "payer-action"

class PayPalPaymentProviderService extends AbstractPaymentProvider<Options> {
  static identifier = "paypal"

  protected logger_: Logger
  protected options_: Options
  protected baseUrl_: string

  /** Cached OAuth token and its expiry, so every call does not re-authenticate. */
  private token_: { value: string; expiresAt: number } | null = null

  constructor(container: MedusaContainer, options: Options) {
    super(container, options)

    this.options_ = options
    this.logger_ = container.resolve("logger") as Logger
    this.baseUrl_ =
      options.sandbox === false
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com"
  }

  /**
   * Fail fast at boot rather than at the first checkout attempt. Without
   * credentials every PayPal call would fail, so an unconfigured provider must
   * not be registered at all.
   */
  static validateOptions(options: Record<string, unknown>) {
    if (!options.clientId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal provider requires `clientId`."
      )
    }

    if (!options.clientSecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal provider requires `clientSecret`."
      )
    }
  }

  // ---------------------------------------------------------------- internals

  private async getAccessToken(): Promise<string> {
    const now = Date.now()

    if (this.token_ && this.token_.expiresAt > now + 30_000) {
      return this.token_.value
    }

    const credentials = Buffer.from(
      `${this.options_.clientId}:${this.options_.clientSecret}`
    ).toString("base64")

    const response = await fetch(`${this.baseUrl_}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    })

    if (!response.ok) {
      const body = await response.text()
      this.logger_.error(
        `PayPal authentication failed (${response.status}): ${body.slice(0, 300)}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Unable to authenticate with PayPal."
      )
    }

    const json = (await response.json()) as {
      access_token: string
      expires_in: number
    }

    this.token_ = {
      value: json.access_token,
      expiresAt: now + json.expires_in * 1000,
    }

    return this.token_.value
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    idempotencyKey?: string
  ): Promise<T> {
    const token = await this.getAccessToken()

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    }

    // PayPal honours this header to make retried writes safe, which is what
    // stops a retried capture from charging the customer twice.
    if (idempotencyKey) {
      headers["PayPal-Request-Id"] = idempotencyKey
    }

    const response = await fetch(`${this.baseUrl_}${path}`, {
      ...init,
      headers,
    })

    const text = await response.text()
    const json = text ? JSON.parse(text) : {}

    if (!response.ok) {
      this.logger_.error(
        `PayPal request ${path} failed (${response.status}): ${text.slice(0, 300)}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `PayPal request failed with status ${response.status}.`
      )
    }

    return json as T
  }

  private approvalUrl(order: PayPalOrder): string | undefined {
    return order.links?.find(
      (link) => link.rel === APPROVAL_REL || link.rel === PAYER_ACTION_REL
    )?.href
  }

  /**
   * Map a PayPal order status onto a Medusa payment session status.
   *
   * `COMPLETED` alone is treated as captured; `APPROVED` only means the payer
   * approved the order, so it is still only authorized.
   */
  private mapStatus(status: string): PaymentSessionStatus {
    switch (status) {
      case "COMPLETED":
        return PaymentSessionStatus.CAPTURED
      case "APPROVED":
      case "SAVED":
        return PaymentSessionStatus.AUTHORIZED
      case "CREATED":
      case "PAYER_ACTION_REQUIRED":
        return PaymentSessionStatus.PENDING
      case "VOIDED":
        return PaymentSessionStatus.CANCELED
      default:
        return PaymentSessionStatus.PENDING
    }
  }

  // ------------------------------------------------------------- public API

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, context } = input

    const order = await this.request<PayPalOrder>(
      "/v2/checkout/orders",
      {
        method: "POST",
        body: JSON.stringify({
          intent: "AUTHORIZE",
          purchase_units: [
            {
              // Amounts are sent in major units; PayPal expects a decimal string.
              amount: {
                currency_code: currency_code.toUpperCase(),
                value: new BigNumber(amount).numeric.toFixed(2),
              },
              custom_id: (context?.idempotency_key as string) ?? undefined,
            },
          ],
          application_context: this.options_.brandName
            ? { brand_name: this.options_.brandName }
            : undefined,
        }),
      },
      // Idempotency key derived from the cart/session so a retried initiate
      // does not create a second PayPal order.
      (context?.idempotency_key as string) ?? undefined
    )

    return {
      id: order.id,
      status: this.mapStatus(order.status),
      data: {
        id: order.id,
        status: order.status,
        approval_url: this.approvalUrl(order),
        // Remembered so a later partial refund can state the currency, which
        // PayPal requires whenever an explicit refund amount is sent.
        currency_code: currency_code.toUpperCase(),
      },
    }
  }

  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const { amount, currency_code, data } = input
    const orderId = data?.id as string | undefined

    // PayPal orders are immutable once created. The correct update is to void
    // the old order and create a fresh one for the new amount.
    if (orderId) {
      await this.cancelPayment({ data: { id: orderId } } as CancelPaymentInput)
    }

    const replacement = await this.request<PayPalOrder>("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "AUTHORIZE",
        purchase_units: [
          {
            amount: {
              currency_code: currency_code.toUpperCase(),
              value: new BigNumber(amount).numeric.toFixed(2),
            },
          },
        ],
      }),
    })

    // UpdatePaymentOutput carries no `id`; the provider's own reference is
    // returned inside `data`.
    return {
      status: this.mapStatus(replacement.status),
      data: {
        id: replacement.id,
        status: replacement.status,
        approval_url: this.approvalUrl(replacement),
      },
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const orderId = input.data?.id as string | undefined

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing PayPal order id."
      )
    }

    // Re-read the order from PayPal. Never trust a status passed in by the
    // caller, which is what would otherwise allow a forged "approved".
    const order = await this.request<PayPalOrder>(`/v2/checkout/orders/${orderId}`)

    if (order.status !== "APPROVED") {
      return {
        status: this.mapStatus(order.status),
        data: { id: order.id, status: order.status },
      }
    }

    const authorized = await this.request<PayPalOrder>(
      `/v2/checkout/orders/${orderId}/authorize`,
      { method: "POST", body: "{}" }
    )

    const authorization =
      authorized.purchase_units?.[0]?.payments?.authorizations?.[0]

    return {
      status: this.mapStatus(authorized.status),
      data: {
        id: authorized.id,
        status: authorized.status,
        authorization_id: authorization?.id,
      },
    }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const orderId = input.data?.id as string | undefined

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing PayPal order id."
      )
    }

    const captured = await this.request<PayPalOrder>(
      `/v2/checkout/orders/${orderId}/capture`,
      { method: "POST", body: "{}" },
      `capture-${orderId}`
    )

    const capture = captured.purchase_units?.[0]?.payments?.captures?.[0]

    return {
      data: {
        id: captured.id,
        status: captured.status,
        capture_id: capture?.id,
      },
    }
  }

  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const captureId = (input.data?.capture_id ?? input.data?.id) as
      | string
      | undefined

    if (!captureId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing PayPal capture id required to refund."
      )
    }

    const refundValue = new BigNumber(input.amount).numeric.toFixed(2)

    // RefundPaymentInput does not carry a currency, so the one recorded when the
    // payment was initiated is used. Omitting `amount` entirely asks PayPal to
    // refund the full capture, which is the only safe fallback: sending a bare
    // number without a currency would be rejected.
    const currency = (
      input.data?.currency_code as string | undefined
    )?.toUpperCase()

    await this.request(
      `/v2/payments/captures/${captureId}/refund`,
      {
        method: "POST",
        body: JSON.stringify(
          currency
            ? { amount: { currency_code: currency, value: refundValue } }
            : {}
        ),
      },
      `refund-${captureId}-${refundValue}`
    )

    return { data: input.data }
  }

  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    const authorizationId = input.data?.authorization_id as string | undefined
    const orderId = input.data?.id as string | undefined

    // A void only applies to an authorization. Before authorization there is
    // nothing to release, so this is a no-op rather than an error.
    if (authorizationId) {
      await this.request(
        `/v2/payments/authorizations/${authorizationId}/void`,
        { method: "POST", body: "{}" },
        `void-${authorizationId}`
      )
    }

    return { data: { ...input.data, id: orderId, status: "VOIDED" } }
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    // PayPal keeps its own records; nothing is deleted here.
    return { data: input.data }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const orderId = input.data?.id as string | undefined

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing PayPal order id."
      )
    }

    const order = await this.request<PayPalOrder>(
      `/v2/checkout/orders/${orderId}`
    )

    return { data: { id: order.id, status: order.status } }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const orderId = input.data?.id as string | undefined

    if (!orderId) {
      return { status: PaymentSessionStatus.PENDING }
    }

    const order = await this.request<PayPalOrder>(
      `/v2/checkout/orders/${orderId}`
    )

    return {
      status: this.mapStatus(order.status),
      data: { id: order.id, status: order.status },
    }
  }

  /**
   * Handle a PayPal webhook.
   *
   * The signature is verified against PayPal before the payload is trusted: an
   * unverified webhook is an unauthenticated request that could otherwise be
   * used to mark an arbitrary order as paid.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    if (!this.options_.webhookId) {
      this.logger_.warn(
        "PayPal webhook received but PAYPAL_WEBHOOK_ID is not configured; ignoring."
      )
      return { action: "not_supported" }
    }

    const verified = await this.request<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        body: JSON.stringify({
          auth_algo: headers["paypal-auth-algo"],
          cert_url: headers["paypal-cert-url"],
          transmission_id: headers["paypal-transmission-id"],
          transmission_sig: headers["paypal-transmission-sig"],
          transmission_time: headers["paypal-transmission-time"],
          webhook_id: this.options_.webhookId,
          webhook_event: rawData ?? data,
        }),
      }
    )

    if (verified.verification_status !== "SUCCESS") {
      this.logger_.warn("Rejected a PayPal webhook with an invalid signature.")
      return { action: "not_supported" }
    }

    const event = (rawData ?? data) as {
      event_type?: string
      resource?: { id?: string; custom_id?: string }
    }

    const sessionId = event.resource?.custom_id
    const amount = new BigNumber(0)

    if (!sessionId) {
      return { action: "not_supported" }
    }

    switch (event.event_type) {
      case "PAYMENT.AUTHORIZATION.CREATED":
        return { action: "authorized", data: { session_id: sessionId, amount } }
      case "PAYMENT.CAPTURE.COMPLETED":
        return { action: "captured", data: { session_id: sessionId, amount } }
      case "PAYMENT.AUTHORIZATION.DENIED":
      case "PAYMENT.CAPTURE.DENIED":
        return { action: "failed", data: { session_id: sessionId, amount } }
      default:
        return { action: "not_supported" }
    }
  }
}

export default PayPalPaymentProviderService
