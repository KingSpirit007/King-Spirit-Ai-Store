import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const REDIS_URL = process.env.REDIS_URL

/**
 * Redis-backed infrastructure modules.
 *
 * Without these, Medusa silently falls back to an in-memory event bus, an
 * in-memory workflow engine and a "fake redis instance". That is not safe for a
 * store that has to run unattended: events are dropped on every restart and
 * workflow executions cannot be resumed, so an order can be paid for and then
 * never fulfilled. A Render Key Value instance is already provisioned and
 * exposed as REDIS_URL, so wire it in whenever it is present.
 */
const redisModules = REDIS_URL
  ? [
      {
        resolve: '@medusajs/medusa/cache-redis',
        options: { redisUrl: REDIS_URL },
      },
      {
        resolve: '@medusajs/medusa/event-bus-redis',
        options: {
          redisUrl: REDIS_URL,
          jobOptions: {
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 3600, count: 1000 },
          },
        },
      },
      {
        resolve: '@medusajs/medusa/workflow-engine-redis',
        options: { redis: { redisUrl: REDIS_URL } },
      },
    ]
  : []

/**
 * Payment providers.
 *
 * PayPal is registered only when both credentials are present. Registering it
 * without credentials would make the provider validate its options at boot and
 * fail the whole service, so an unconfigured store keeps running exactly as it
 * did before any credentials exist.
 *
 * Once registered, a provider still has to be enabled on a region in the admin
 * dashboard before a customer can select it.
 *
 * The cryptocurrency provider in `src/modules/payment-crypto` is deliberately
 * NOT listed here. Medusa only loads modules that appear in this array, so an
 * unregistered module cannot be offered at checkout. Crypto payments must stay
 * inactive until the regulatory reassessment is complete; see the header of
 * that module for the gate and the activation checklist.
 */
const paypalClientId = process.env.PAYPAL_CLIENT_ID
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET

const paymentModules =
  paypalClientId && paypalClientSecret
    ? [
        {
          resolve: '@medusajs/medusa/payment',
          options: {
            providers: [
              {
                resolve: './src/modules/payment-paypal',
                id: 'paypal',
                options: {
                  clientId: paypalClientId,
                  clientSecret: paypalClientSecret,
                  // Default to sandbox. Live requires an explicit opt-in, so a
                  // missing variable can never accidentally take real money.
                  sandbox: process.env.PAYPAL_SANDBOX !== 'false',
                  webhookId: process.env.PAYPAL_WEBHOOK_ID,
                  brandName: process.env.PAYPAL_BRAND_NAME,
                },
              },
            ],
          },
        },
      ]
    : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // Keep server sessions in Redis rather than express-session's MemoryStore,
    // which warns on boot, leaks memory and cannot be shared across instances.
    redisUrl: REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  modules: [...redisModules, ...paymentModules],
})
