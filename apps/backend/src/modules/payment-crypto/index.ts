import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import CryptoPaymentProviderService from "./service"

/**
 * Cryptocurrency payment provider — ARCHITECTURE ONLY, NOT ACTIVATED.
 *
 * This module is intentionally NOT registered in `medusa-config.ts`. Medusa only
 * loads modules listed there, so an unregistered module cannot be offered at
 * checkout. See the header comment in `./service.ts` for the regulatory gate and
 * the full activation checklist.
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [CryptoPaymentProviderService],
})
