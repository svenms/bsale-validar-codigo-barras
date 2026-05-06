export const PENDING_DISPATCH_STORAGE_KEY = 'bsale_pending_internal_dispatch_state'
export const SETTINGS_STORAGE_KEY = 'bsale_barras_settings'
export const PENDING_DISPATCH_ALARM = 'bsale_pending_internal_dispatch_check'
export const PENDING_DISPATCH_PERIOD_MINUTES = 5
export const STOCK_RECEPTION_URL = 'https://stock.bsale.app/admin/stock/reception'
export const STOCK_SESSION_ENDPOINT = 'https://stock.bsale.app/gateway/menu/session'
export const LAST_OFFICE_ID_STORAGE_KEY = 'bsale_pending_internal_dispatch_last_office_id'
export const PENDING_DISPATCH_LIMIT = 10000

export function buildPendingDispatchEndpoint(officeId: number): string {
  const params = new URLSearchParams({
    office_id: String(officeId),
    limit: String(PENDING_DISPATCH_LIMIT),
  })
  return `https://stock.bsale.app/gateway/stock_reception/available_from_dispatch/list.json?${params.toString()}`
}

export type PendingDispatchItem = {
  dispatchId: number
  documentId: number
  documentNumber: string
  typeDocumentName: string
}

export type PendingDispatchState = {
  checkedAt: number
  ok: boolean
  officeId: number | null
  pendingCount: number
  pending: PendingDispatchItem[]
  requiresSessionRefresh: boolean
  lastError: string | null
}

export const EMPTY_PENDING_DISPATCH_STATE: PendingDispatchState = {
  checkedAt: 0,
  ok: false,
  officeId: null,
  pendingCount: 0,
  pending: [],
  requiresSessionRefresh: false,
  lastError: null,
}

export type BsaleSettings = {
  enabled: boolean
  pages: {
    from_scratch: boolean
    documents_sales: boolean
    mobile_sales: boolean
    stock_reception: boolean
  }
  volume: number
  toneTruePreset: string
  toneFalsePreset: string
  checkPendingInternalDispatch: boolean
}
