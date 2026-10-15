import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import PayPalPaymentProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [PayPalPaymentProviderService],
})
