type PageKey = 'from_scratch' | 'documents_sales' | 'mobile_sales'
type TonePreset =
  | 'classic'
  | 'bell'
  | 'digital'
  | 'arcade'
  | 'low_impact'
  | 'minimal'
  | 'error_siren'
  | 'error_triple'
  | 'error_buzzer'
  | 'error_horn'

type Settings = {
  enabled: boolean
  pages: Record<PageKey, boolean>
  volume: number // 0..1
  toneTruePreset: TonePreset
  toneFalsePreset: TonePreset
}

type Attempt = {
  id: string
  startedAt: number
  query: string
  resolved: boolean
  timeoutHandle: number | null
}

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  pages: {
    from_scratch: true,
    documents_sales: true,
    mobile_sales: true,
  },
  volume: 0.6,
  toneTruePreset: 'classic',
  toneFalsePreset: 'classic',
}

let settings: Settings = DEFAULT_SETTINGS

const pendingAttempts: Attempt[] = []
let saleQHandlerBound = false

// Web Audio (tonos). Lo preparamos lo más pronto posible.
let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null
let audioUnlocked = false

function getPageKeyFromLocation(): PageKey | null {
  const path = window.location.pathname
  if (path.startsWith('/documents/shipping/from_scratch')) return 'from_scratch'
  if (path.startsWith('/documents/sales')) return 'documents_sales'
  if (path.startsWith('/mobile/sales')) return 'mobile_sales'
  return null
}

function isEnabledForCurrentPage(): boolean {
  if (!settings.enabled) return false
  const key = getPageKeyFromLocation()
  if (!key) return false
  return settings.pages[key]
}

async function loadSettings(): Promise<void> {
  const res = await chrome.storage.local.get('bsale_barras_settings')
  if (res?.bsale_barras_settings) {
    const storedAny = res.bsale_barras_settings as unknown as { tonePreset?: TonePreset }
    settings = {
      ...DEFAULT_SETTINGS,
      ...res.bsale_barras_settings,
      pages: { ...DEFAULT_SETTINGS.pages, ...(res.bsale_barras_settings.pages ?? {}) },
    }
    // Compatibilidad: versiones anteriores guardaban `tonePreset` único.
    if (storedAny.tonePreset) {
      settings = { ...settings, toneTruePreset: storedAny.tonePreset, toneFalsePreset: storedAny.tonePreset }
    }
  }
}

function ensureAudio(): void {
  if (audioCtx && masterGain) return
  // Crear contexto dentro del gesto de usuario es lo ideal; aun así guardamos la instancia.
  audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  masterGain = audioCtx.createGain()
  masterGain.gain.value = settings.volume
  masterGain.connect(audioCtx.destination)
}

async function unlockAudio(): Promise<void> {
  ensureAudio()
  if (!audioCtx) return
  // Si está suspendido, intentamos reanudar.
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume()
    } catch {
      // Si falla, igualmente intentaremos play y asumiremos que Chrome lo permite.
    }
  }
  if (masterGain) masterGain.gain.value = settings.volume
  audioUnlocked = true
}

function playTone(success: boolean): void {
  ensureAudio()
  if (!audioCtx || !masterGain) return
  const now = audioCtx.currentTime
  const peak = Math.max(0.02, Math.min(1, settings.volume))

  const playBeep = (frequency: number, start: number, duration: number, type: OscillatorType) => {
    const osc = audioCtx!.createOscillator()
    const env = audioCtx!.createGain()
    osc.type = type
    osc.frequency.value = frequency
    env.gain.value = 0.0001
    osc.connect(env)
    env.connect(masterGain!)
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(peak, start + 0.01)
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    osc.start(start)
    osc.stop(start + duration + 0.01)
  }

  const preset = success ? settings.toneTruePreset : settings.toneFalsePreset
  if (preset === 'classic') {
    if (success) playBeep(1180, now, 0.11, 'triangle')
    else {
      playBeep(260, now, 0.12, 'square')
      playBeep(180, now + 0.14, 0.14, 'square')
    }
    return
  }
  if (preset === 'bell') {
    if (success) {
      playBeep(980, now, 0.09, 'sine')
      playBeep(1310, now + 0.1, 0.12, 'sine')
    } else {
      playBeep(320, now, 0.18, 'triangle')
      playBeep(250, now + 0.2, 0.16, 'triangle')
    }
    return
  }
  if (preset === 'digital') {
    if (success) {
      playBeep(1400, now, 0.07, 'square')
      playBeep(1700, now + 0.08, 0.06, 'square')
    } else {
      playBeep(210, now, 0.1, 'square')
      playBeep(210, now + 0.13, 0.1, 'square')
    }
    return
  }
  if (preset === 'arcade') {
    if (success) {
      playBeep(740, now, 0.07, 'triangle')
      playBeep(988, now + 0.08, 0.07, 'triangle')
      playBeep(1318, now + 0.16, 0.08, 'triangle')
    } else {
      playBeep(410, now, 0.09, 'sawtooth')
      playBeep(300, now + 0.1, 0.1, 'sawtooth')
      playBeep(210, now + 0.21, 0.11, 'sawtooth')
    }
    return
  }
  if (preset === 'low_impact') {
    if (success) playBeep(880, now, 0.09, 'triangle')
    else {
      playBeep(170, now, 0.16, 'square')
      playBeep(140, now + 0.18, 0.18, 'square')
    }
    return
  }

  if (preset === 'error_siren') {
    if (success) {
      playBeep(1180, now, 0.09, 'triangle')
      return
    }
    playBeep(820, now, 0.06, 'triangle')
    playBeep(650, now + 0.06, 0.06, 'triangle')
    playBeep(520, now + 0.12, 0.08, 'triangle')
    playBeep(680, now + 0.20, 0.06, 'triangle')
    return
  }

  if (preset === 'error_triple') {
    if (success) {
      playBeep(1180, now, 0.09, 'triangle')
      return
    }
    playBeep(240, now, 0.08, 'square')
    playBeep(210, now + 0.10, 0.08, 'square')
    playBeep(180, now + 0.20, 0.09, 'square')
    return
  }

  if (preset === 'error_buzzer') {
    if (success) {
      playBeep(1180, now, 0.09, 'triangle')
      return
    }
    playBeep(140, now, 0.05, 'square')
    playBeep(120, now + 0.06, 0.05, 'square')
    playBeep(160, now + 0.12, 0.05, 'square')
    playBeep(130, now + 0.18, 0.06, 'square')
    return
  }

  if (preset === 'error_horn') {
    if (success) {
      playBeep(1180, now, 0.09, 'triangle')
      return
    }
    playBeep(320, now, 0.10, 'triangle')
    playBeep(390, now + 0.08, 0.09, 'triangle')
    playBeep(260, now + 0.16, 0.10, 'triangle')
    return
  }
  // minimal
  if (success) playBeep(1200, now, 0.06, 'sine')
  else playBeep(240, now, 0.09, 'square')
}

function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase()
}

function latestPendingAttempt(): Attempt | null {
  const unresolved = pendingAttempts.filter((a) => !a.resolved)
  if (unresolved.length === 0) return null
  return unresolved.reduce((prev, cur) => (cur.startedAt > prev.startedAt ? cur : prev))
}

function findAttemptByQuery(query: string): Attempt | null {
  const unresolved = pendingAttempts.filter((a) => !a.resolved)
  const exact = unresolved.filter((a) => a.query === query)
  if (exact.length > 0) {
    return exact.reduce((prev, cur) => (cur.startedAt > prev.startedAt ? cur : prev))
  }
  return latestPendingAttempt()
}

function resolveAttempt(attempt: Attempt, success: boolean): void {
  if (attempt.resolved) return
  attempt.resolved = true
  if (attempt.timeoutHandle) {
    window.clearTimeout(attempt.timeoutHandle)
    attempt.timeoutHandle = null
  }

  const saleQ = document.getElementById('sale_q') as HTMLInputElement | null
  if (saleQ) {
    saleQ.dataset.bsaleLast = success ? 'ok' : 'fail'
    saleQ.dataset.bsaleLastBarcode = attempt.query
  }
  const idx = pendingAttempts.findIndex((a) => a.id === attempt.id)
  if (idx >= 0) pendingAttempts.splice(idx, 1)
  // eslint-disable-next-line no-console
  console.info('[bsale-barras]', { success, query: attempt.query })
  playTone(success)
}

function applyStorageSettings(stored: unknown): void {
  const res = stored as Partial<Settings> & {
    pages?: Partial<Record<PageKey, boolean>>
  }
  settings = {
    ...DEFAULT_SETTINGS,
    ...(stored as Partial<Settings>),
    pages: { ...DEFAULT_SETTINGS.pages, ...(res.pages ?? {}) },
  }

  // Compatibilidad: versiones anteriores guardaban `tonePreset` único.
  const storedAny = stored as unknown as { tonePreset?: TonePreset }
  if (storedAny.tonePreset) {
    settings.toneTruePreset = storedAny.tonePreset
    settings.toneFalsePreset = storedAny.tonePreset
  }

  if (masterGain && audioCtx) {
    masterGain.gain.value = settings.volume
  }
}

function getFindAttrInfoFromJson(payload: unknown): { count: number; hasStock: boolean } {
  const raw = payload as { search?: Array<{ variante_producto?: Record<string, unknown> }> }
  const items = Array.isArray(raw?.search) ? raw.search : []
  const count = items.length
  if (count !== 1) return { count, hasStock: false }
  const variant = items[0]?.variante_producto ?? {}
  const stockUnlimited = Number(variant.stock_ilimitado ?? 0) === 1
  const stockQty = Number(variant.stock_variante ?? 0)
  const hasStock = stockUnlimited || stockQty > 0
  return { count, hasStock }
}

function startAttempt(rawQuery: string): void {
  if (!isEnabledForCurrentPage()) return
  const normalized = normalizeQuery(rawQuery)
  if (!normalized) return

  const attempt: Attempt = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    startedAt: Date.now(),
    query: normalized,
    resolved: false,
    timeoutHandle: null,
  }

  pendingAttempts.push(attempt)
  // eslint-disable-next-line no-console
  console.info('[bsale-barras]', { stage: 'attempt_start', query: normalized, pending: pendingAttempts.length })

  // Tiempo de espera amplio: la decision principal se toma al recibir respuesta XHR.
  attempt.timeoutHandle = window.setTimeout(() => {
    if (attempt.resolved) return
    // eslint-disable-next-line no-console
    console.info('[bsale-barras]', { success: false, query: attempt.query, reason: 'timeout' })
    resolveAttempt(attempt, false)
  }, 9000)
}

function bindSaleQEnterHandler(saleQ: HTMLInputElement): void {
  if (saleQHandlerBound) return
  saleQHandlerBound = true
  saleQ.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    if (!isEnabledForCurrentPage()) return
    // Desbloquea audio lo más cerca del gesto.
    void unlockAudio()
    const rawQuery = saleQ.value
    startAttempt(rawQuery)
  })
}

function ensureSaleQHandler(): void {
  const existing = document.getElementById('sale_q') as HTMLInputElement | null
  if (existing) {
    bindSaleQEnterHandler(existing)
    return
  }

  const obs = new MutationObserver(() => {
    const el = document.getElementById('sale_q') as HTMLInputElement | null
    if (el) {
      obs.disconnect()
      bindSaleQEnterHandler(el)
    }
  })
  obs.observe(document.documentElement, { subtree: true, childList: true })
}

function installBsaleFlowHooks(): void {
  window.addEventListener('bsale-barras-event', (evt: Event) => {
    const ce = evt as CustomEvent<{ kind: 'ajax' | 'addToCart'; url?: string; body?: string }>
    const detail = ce.detail
    if (!detail) return

    if (detail.kind === 'addToCart') {
      const attempt = latestPendingAttempt()
      if (!attempt || attempt.resolved) return
      // eslint-disable-next-line no-console
      console.info('[bsale-barras]', { stage: 'addToCart', query: attempt.query })
      resolveAttempt(attempt, true)
      return
    }

    if (detail.kind !== 'ajax' || !detail.url) return
    let parsed: unknown = null
    try {
      parsed = detail.body ? JSON.parse(detail.body) : null
    } catch {
      parsed = null
    }
    const parsedUrl = (() => {
      try {
        return new URL(detail.url!, window.location.href)
      } catch {
        return null
      }
    })()
    if (!parsedUrl) return

    if (parsedUrl.pathname.includes('/pos_mobile/find_attr')) {
      const q = normalizeQuery(parsedUrl.searchParams.get('q') ?? '')
      const attempt = findAttemptByQuery(q) ?? latestPendingAttempt()
      if (!attempt || attempt.resolved) return
      const info = getFindAttrInfoFromJson(parsed)
      // eslint-disable-next-line no-console
      console.info('[bsale-barras]', { stage: 'find_attr', q, info })
      if (info.count > 1) resolveAttempt(attempt, false)
      else if (info.count === 1) resolveAttempt(attempt, info.hasStock)
      return
    }

    if (parsedUrl.pathname.includes('/pos_mobile/find_code')) {
      const q = normalizeQuery(parsedUrl.searchParams.get('q') ?? '')
      const attempt = findAttemptByQuery(q) ?? latestPendingAttempt()
      if (!attempt || attempt.resolved) return
      const obj = parsed as { status?: string; producto?: unknown; plan?: unknown; msg?: string } | null
      // eslint-disable-next-line no-console
      console.info('[bsale-barras]', { stage: 'find_code', q, status: obj?.status, hasProducto: !!obj?.producto })
      if (obj?.producto || obj?.plan) resolveAttempt(attempt, true)
      else if (obj?.status === 'cart-fail') resolveAttempt(attempt, false)
      else if (obj?.status === 'fail' && obj?.msg !== 'Producto o Servicio no se encuentra') resolveAttempt(attempt, false)
      return
    }

    if (parsedUrl.pathname.includes('/cart/update_cart/')) {
      const attempt = latestPendingAttempt()
      if (!attempt || attempt.resolved) return
      const obj = parsed as { status?: string } | null
      const ok = obj?.status === 'ok'
      // eslint-disable-next-line no-console
      console.info('[bsale-barras]', { stage: 'cart_update', query: attempt.query, ok })
      resolveAttempt(attempt, ok)
    }
  })

  const injected = document.createElement('script')
  injected.src = chrome.runtime.getURL('page-bridge.js')
  injected.async = false
  ;(document.head || document.documentElement).appendChild(injected)
  injected.remove()
  // eslint-disable-next-line no-console
  console.info('[bsale-barras]', { stage: 'bridge_injected' })
}

async function init(): Promise<void> {
  document.documentElement.setAttribute('data-bsale-barras-ext', 'loaded')
  await loadSettings().catch(() => {
    // Si falla, usamos defaults.
  })

  // Mantener sincronizado si cambias presets/volumen desde el options.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const v = changes?.bsale_barras_settings?.newValue
    if (!v) return
    applyStorageSettings(v)
    // eslint-disable-next-line no-console
    console.info('[bsale-barras]', { stage: 'storage_updated', volume: settings.volume })
  })

  installBsaleFlowHooks()
  ensureSaleQHandler()
}

void init()

