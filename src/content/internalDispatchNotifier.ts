import {
  EMPTY_PENDING_DISPATCH_STATE,
  PENDING_DISPATCH_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  STOCK_RECEPTION_URL,
  type PendingDispatchState,
} from '../shared/internalDispatchMonitor'

type LocalSettings = {
  checkPendingInternalDispatch?: boolean
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000
const WIDGET_ID = 'bsale-pending-dispatch-widget'
const WIDGET_POS_STORAGE_KEY = 'bsale_pending_dispatch_widget_pos'
const VIEWPORT_MARGIN = 12

type WidgetPosition = {
  x: number
  y: number
}

let enabled = true
let currentState: PendingDispatchState = EMPTY_PENDING_DISPATCH_STATE
let intervalId: number | null = null
let widgetPosition: WidgetPosition | null = null
let preventNextClick = false

function isBsaleSite(): boolean {
  return /(?:^|\.)bsale\.(?:cl|app|io)$/i.test(window.location.hostname)
}

function isContextInvalidatedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /extension context invalidated/i.test(msg)
}

function hasLiveExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id
}

function formatWidgetText(state: PendingDispatchState): string {
  if (!state.ok && state.lastError) return 'Despachos internos: error de sesión'
  if (state.pendingCount <= 0) return 'Despachos internos: sin pendientes'
  const numbers = state.pending
    .map((row) => row.documentNumber)
    .filter(Boolean)
    .slice(0, 4)
    .join(', ')
  const plus = state.pendingCount > 4 ? ` +${state.pendingCount - 4}` : ''
  return `Despachos internos: ${state.pendingCount} pendiente(s) ${numbers}${plus}`
}

function clampPosition(x: number, y: number, widget: HTMLElement): WidgetPosition {
  const rect = widget.getBoundingClientRect()
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
  return {
    x: Math.min(Math.max(VIEWPORT_MARGIN, x), maxX),
    y: Math.min(Math.max(VIEWPORT_MARGIN, y), maxY),
  }
}

function applyWidgetPosition(widget: HTMLElement, pos: WidgetPosition | null): void {
  if (!pos) {
    widget.style.top = '14px'
    widget.style.right = '14px'
    widget.style.left = ''
    return
  }
  const next = clampPosition(pos.x, pos.y, widget)
  widget.style.left = `${next.x}px`
  widget.style.top = `${next.y}px`
  widget.style.right = 'auto'
}

function persistWidgetPosition(pos: WidgetPosition): void {
  if (!hasLiveExtensionContext()) return
  chrome.storage.local.set({ [WIDGET_POS_STORAGE_KEY]: pos }).catch((error) => {
    if (!isContextInvalidatedError(error)) {
      // eslint-disable-next-line no-console
      console.warn('[bsale-barras] no se pudo persistir posición del widget', error)
    }
  })
}

function bindDrag(widget: HTMLButtonElement): void {
  widget.addEventListener('pointerdown', (downEvt) => {
    if (downEvt.button !== 0) return
    const startRect = widget.getBoundingClientRect()
    const startX = downEvt.clientX
    const startY = downEvt.clientY
    let moved = false
    const onMove = (moveEvt: PointerEvent): void => {
      const dx = moveEvt.clientX - startX
      const dy = moveEvt.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
      moved = true
      const next = clampPosition(startRect.left + dx, startRect.top + dy, widget)
      widgetPosition = next
      applyWidgetPosition(widget, next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!moved) return
      preventNextClick = true
      if (widgetPosition) persistWidgetPosition(widgetPosition)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  })
}

function ensureWidget(): HTMLButtonElement {
  let widget = document.getElementById(WIDGET_ID) as HTMLButtonElement | null
  if (widget) return widget
  widget = document.createElement('button')
  widget.id = WIDGET_ID
  widget.type = 'button'
  widget.style.position = 'fixed'
  widget.style.top = '14px'
  widget.style.right = '14px'
  widget.style.zIndex = '2147483647'
  widget.style.padding = '10px 12px'
  widget.style.borderRadius = '8px'
  widget.style.border = '1px solid rgba(255,255,255,0.2)'
  widget.style.color = '#fff'
  widget.style.background = '#0f172a'
  widget.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  widget.style.fontSize = '12px'
  widget.style.cursor = 'pointer'
  widget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)'
  widget.style.maxWidth = '420px'
  widget.style.textAlign = 'left'
  widget.style.lineHeight = '1.35'
  widget.style.userSelect = 'none'
  widget.style.touchAction = 'none'
  widget.addEventListener('click', () => {
    if (preventNextClick) {
      preventNextClick = false
      return
    }
    window.open(STOCK_RECEPTION_URL, '_blank', 'noopener,noreferrer')
  })
  ;(document.body || document.documentElement).appendChild(widget)
  bindDrag(widget)
  applyWidgetPosition(widget, widgetPosition)
  return widget
}

function renderWidget(): void {
  const existing = document.getElementById(WIDGET_ID)
  const shouldShow = enabled && currentState.pendingCount > 0
  if (!shouldShow) {
    existing?.remove()
    return
  }
  const widget = ensureWidget()
  widget.textContent = formatWidgetText(currentState)
  applyWidgetPosition(widget, widgetPosition)
  if (currentState.pendingCount > 0) {
    widget.style.background = '#9f1239'
  } else if (!currentState.ok) {
    widget.style.background = '#7c2d12'
  } else {
    widget.style.background = '#14532d'
  }
}

function requestCheck(): void {
  if (!hasLiveExtensionContext()) return
  chrome.runtime.sendMessage({ type: 'BSALE_BARRAS_CHECK_PENDING_INTERNAL_DISPATCH' }, () => {
    const lastError = chrome.runtime.lastError
    if (lastError && !/extension context invalidated/i.test(lastError.message)) {
      // eslint-disable-next-line no-console
      console.warn('[bsale-barras] error al pedir revisión', lastError.message)
    }
  })
}

async function loadInitialState(): Promise<void> {
  if (!hasLiveExtensionContext()) return
  const data = await chrome.storage.local.get([
    SETTINGS_STORAGE_KEY,
    PENDING_DISPATCH_STORAGE_KEY,
    WIDGET_POS_STORAGE_KEY,
  ])
  const settings = data[SETTINGS_STORAGE_KEY] as LocalSettings | undefined
  enabled = settings?.checkPendingInternalDispatch ?? true
  currentState = (data[PENDING_DISPATCH_STORAGE_KEY] as PendingDispatchState | undefined) ?? EMPTY_PENDING_DISPATCH_STATE
  const maybePos = data[WIDGET_POS_STORAGE_KEY] as WidgetPosition | undefined
  if (maybePos && Number.isFinite(maybePos.x) && Number.isFinite(maybePos.y)) {
    widgetPosition = { x: maybePos.x, y: maybePos.y }
  }
  renderWidget()
}

function bindStorageSync(): void {
  if (!hasLiveExtensionContext()) return
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[SETTINGS_STORAGE_KEY]) {
      const next = (changes[SETTINGS_STORAGE_KEY].newValue ?? {}) as LocalSettings
      enabled = next.checkPendingInternalDispatch ?? true
    }
    if (changes[PENDING_DISPATCH_STORAGE_KEY]) {
      currentState =
        (changes[PENDING_DISPATCH_STORAGE_KEY].newValue as PendingDispatchState | undefined) ??
        EMPTY_PENDING_DISPATCH_STATE
    }
    if (changes[WIDGET_POS_STORAGE_KEY]) {
      const next = changes[WIDGET_POS_STORAGE_KEY].newValue as WidgetPosition | undefined
      widgetPosition = next && Number.isFinite(next.x) && Number.isFinite(next.y) ? next : null
    }
    renderWidget()
  })
}

function startPeriodicChecks(): void {
  if (intervalId != null) return
  intervalId = window.setInterval(() => {
    if (enabled) requestCheck()
  }, CHECK_INTERVAL_MS)
}

async function init(): Promise<void> {
  if (!isBsaleSite()) return
  try {
    await loadInitialState()
  } catch (error) {
    if (isContextInvalidatedError(error)) return
    throw error
  }
  bindStorageSync()
  startPeriodicChecks()
  requestCheck()
}

void init()
