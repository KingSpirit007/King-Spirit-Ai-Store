/**
 * Minimal dependency-free rate limiter.
 *
 * Medusa ships no rate limiting, so login, registration and checkout endpoints
 * are otherwise unbounded: an attacker can brute-force customer passwords or
 * hammer payment-session creation as fast as the network allows.
 *
 * IMPORTANT LIMITATION — read before relying on this in production.
 *
 * Counters live in this process's memory. That is correct for the current
 * single-instance deployment, but if the service is ever scaled past one
 * instance each instance keeps its own counters, so the effective limit becomes
 * `max x instanceCount`. A shared Redis-backed counter is the correct fix and is
 * documented as a remaining hardening item rather than silently assumed here.
 *
 * There is also no eviction of idle keys beyond the periodic sweep below, which
 * is sufficient for the key space involved (one entry per client IP per window).
 */

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

export type RateLimitOptions = {
  /** Length of the window in milliseconds. */
  windowMs: number
  /** Maximum requests permitted per client per window. */
  max: number
  /** Namespace so different limiters keep separate counters. */
  keyPrefix: string
}

/**
 * Resolve the client identity for rate limiting.
 *
 * The service sits behind Cloudflare in front of Render, so `req.ip` is the
 * proxy address unless Express is told to trust the proxy chain. Reading the
 * headers the proxies actually set is more reliable here. Cloudflare always
 * overwrites `cf-connecting-ip` with the real client address, so it is the
 * strongest signal when present.
 */
function clientKey(req: MedusaRequest, keyPrefix: string): string {
  const headers = req.headers as Record<string, string | string[] | undefined>

  const cf = headers["cf-connecting-ip"]
  const forwarded = headers["x-forwarded-for"]

  const ip =
    (typeof cf === "string" && cf) ||
    (typeof forwarded === "string" && forwarded.split(",")[0]?.trim()) ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown"

  return `${keyPrefix}:${ip}`
}

/**
 * Build an Express-style middleware enforcing a fixed-window rate limit.
 *
 * Responds with 429 and a `Retry-After` header once the limit is exceeded, and
 * emits the standard `RateLimit-*` headers on every response so clients can back
 * off before being refused.
 */
export function rateLimit({ windowMs, max, keyPrefix }: RateLimitOptions) {
  return (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
    const now = Date.now()
    const key = clientKey(req, keyPrefix)

    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    bucket.count += 1

    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    const remaining = Math.max(0, max - bucket.count)

    res.setHeader("RateLimit-Limit", String(max))
    res.setHeader("RateLimit-Remaining", String(remaining))
    res.setHeader("RateLimit-Reset", String(resetSeconds))

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(resetSeconds))
      res.status(429).json({
        type: "rate_limited",
        message: "Too many requests. Please try again shortly.",
      })
      return
    }

    next()
  }
}

// Drop expired buckets so the map cannot grow without bound.
const sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key)
    }
  }
}, 60_000)

// Never hold the process open just for the sweep.
sweep.unref?.()
