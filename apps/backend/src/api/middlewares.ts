import {
  configureStoreSearch,
  defineMiddlewares,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { rateLimit } from "./../utils/rate-limit"

/**
 * Baseline security headers.
 *
 * Medusa does not set any of these, and the live deployment confirmed it: every
 * application route was served with no `X-Content-Type-Options`,
 * `X-Frame-Options`, `Referrer-Policy` or HSTS header. Only the default Express
 * 404 carried a `Content-Security-Policy`.
 *
 * A Content-Security-Policy is deliberately NOT set here. The admin dashboard at
 * `/app` is a large React bundle and a restrictive policy silently breaks it;
 * one must be derived from the real asset origins and tested before it is
 * enabled. That is recorded as a remaining hardening item instead of being
 * guessed at.
 */
function securityHeaders(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  // Stop browsers from MIME-sniffing a response into something executable.
  res.setHeader("X-Content-Type-Options", "nosniff")
  // The admin dashboard and storefront are same-origin; refuse framing outright.
  res.setHeader("X-Frame-Options", "SAMEORIGIN")
  // Do not leak full URLs (which can contain order or cart ids) to third parties.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  )
  // The service is only reachable over HTTPS through Cloudflare/Render.
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  )

  next()
}

export default defineMiddlewares({
  routes: [
    // Global: applies to every route, including the admin dashboard at /app.
    // A RegExp matcher must be anchored for a global middleware.
    {
      matcher: /^\/.*/,
      middlewares: [securityHeaders],
    },
    // Credential endpoints are the highest-value target: unbounded requests here
    // allow password brute force and account enumeration.
    {
      matcher: "/auth*",
      method: ["POST"],
      middlewares: [
        rateLimit({ windowMs: 5 * 60 * 1000, max: 20, keyPrefix: "auth" }),
      ],
    },
    // Checkout and payment endpoints. Generous enough for normal shopping
    // (including retries after a declined card) but bounded against abuse.
    {
      matcher: "/store*",
      method: ["POST"],
      middlewares: [
        rateLimit({ windowMs: 60 * 1000, max: 120, keyPrefix: "store" }),
      ],
    },
    // The product index declares filterable `status` and `sales_channel_ids`, so
    // the route narrows it to published products in the key's sales channels.
    {
      method: ["POST"],
      matcher: "/store/search",
      middlewares: [
        configureStoreSearch({
          allowed_indexes: {
            product: true,
          },
        }),
      ],
    },
  ],
})
