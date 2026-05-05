type PageKey = 'from_scratch' | 'documents_sales' | 'mobile_sales' | 'stock_reception'
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
    stock_reception: true,
  },
  volume: 0.6,
  toneTruePreset: 'classic',
  toneFalsePreset: 'classic',
}

let settings: Settings = DEFAULT_SETTINGS

const pendingAttempts: Attempt[] = []
let saleQHandlerBound = false

/** Líneas POS para las que ya disparamos auto-apertura del modal de serie (se revierte al cerrar el modal). */
const serialAutoOpenedLines = new WeakSet<Element>()
let serialModalFocusTimer: number | null = null
/** Intervalo / observer para enfocar el input del ThickBox cuando el DOM pinta tarde. */
let serialFocusCleanup: (() => void) | null = null
let serialEditorWasVisible = false
/** Texto del modal de serie (para detectar mensajes de error que pinta Bsale en vivo). */
let serialModalErrorPrev = ''
/** `cod_serie` ya cargados en POS al abrir el modal (`get_serial_number` → `data`). Sirve para duplicados. */
const serialInventoryCodes = new Set<string>()
/** Cuántas líneas pedían serie al abrir el modal (para tono OK si baja al cerrar). */
let serialLinesPendingAtModalOpen = 0

// Web Audio (tonos). Lo preparamos lo más pronto posible.
let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null
let audioUnlocked = false

function getPageKeyFromLocation(): PageKey | null {
  const path = window.location.pathname
  if (window.location.hostname === 'stock.bsale.app' && path.includes('/admin/stock/reception')) {
    return 'stock_reception'
  }
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

function isPosSalesLikePage(): boolean {
  const k = getPageKeyFromLocation()
  return k === 'from_scratch' || k === 'documents_sales' || k === 'mobile_sales'
}

function isThickBoxSerialModalVisible(): boolean {
  const tb = document.querySelector('#TB_window')
  if (!tb) return false
  const st = window.getComputedStyle(tb)
  return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') > 0.01
}

/** Variante actual del POS: captura de serie dentro de `.msgPopUp`, sin `#TB_window`. */
function isMsgPopUpSerialScanVisible(): boolean {
  const mp = document.querySelector('.msgPopUp')
  if (!mp) return false
  const st = window.getComputedStyle(mp)
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01) return false
  return !!mp.querySelector('.sn_search input, .b-search.sn_search input, input[placeholder*="Serie" i]')
}

/**
 * Modal de serie abierto: ThickBox **o** popup msgPopUp (no usar solo `readOnly` del `#attr_ci`).
 */
function isSerialEditorOpen(): boolean {
  return isThickBoxSerialModalVisible() || isMsgPopUpSerialScanVisible()
}

function cartLineKey(li: Element): string | null {
  const hi = li.querySelector('input#cart_item_id') as HTMLInputElement | null
  const v = hi?.value?.trim()
  return v && v.length > 0 ? v : null
}

/**
 * El `.click()` programático sobre `<a href="javascript:void(0)">` hace que el navegador evalúe esa URL;
 * la CSP de Bsale (`script-src`) lo bloquea y aparece error en consola / extensiones.
 * Quitamos temporalmente `href`, disparamos el clic (los listeners siguen activos) y restauramos.
 */
function safeProgrammaticActivateAnchor(el: HTMLElement): void {
  if (!(el instanceof HTMLAnchorElement)) {
    el.click()
    return
  }
  const href = el.getAttribute('href')
  if (!href || !/^\s*javascript:/i.test(href)) {
    el.click()
    return
  }
  el.removeAttribute('href')
  try {
    el.click()
  } finally {
    // Restaurar en la siguiente tarea: si `href` vuelve antes de que terminen los handlers, Chrome puede volver a evaluar `javascript:` y CSP bloquea.
    const hrefVal = href
    window.setTimeout(() => {
      try {
        el.setAttribute('href', hrefVal)
      } catch {
        // ignorar
      }
    }, 0)
  }
}

function lineNeedsSerialModal(li: Element): boolean {
  const serialInput = li.querySelector('input[data-sn="1"]') as HTMLInputElement | null
  if (!serialInput) return false
  const ph = String(serialInput.getAttribute('placeholder') || '')
  if (ph.includes('Sin Serie')) return false
  const add = li.querySelector('a.add_note')
  if (add?.classList.contains('edited')) return false
  const v = serialInput.value.trim()
  if (v.length > 0) return false
  return true
}

function countSaleLinesNeedingSerial(): number {
  let n = 0
  document.querySelectorAll('#sale_items li.serial-number').forEach((li) => {
    if (lineNeedsSerialModal(li)) n++
  })
  return n
}

function serialFieldVisibleEnough(el: HTMLElement): boolean {
  const st = window.getComputedStyle(el)
  if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity || '1') <= 0.01) return false
  const r = el.getBoundingClientRect()
  return r.width >= 1 && r.height >= 1
}

/** Campo pistoleo dentro de un contenedor modal (`#TB_window`, `.msgPopUp`, …). */
function pickSerialInputInContainer(scope: Element): HTMLElement | null {
  const okType = (raw: HTMLInputElement): boolean => {
    const t = String(raw.type || 'text').toLowerCase()
    return (
      t !== 'hidden' &&
      t !== 'checkbox' &&
      t !== 'radio' &&
      t !== 'submit' &&
      t !== 'button' &&
      t !== 'image' &&
      t !== 'reset' &&
      t !== 'file'
    )
  }

  // Mismo id `sale_q` que el buscador del POS; debe resolverse solo dentro de `scope` (p. ej. `.msgPopUp`).
  const preferredSelectors = [
    '.b-search.sn_search input',
    '.sn_search input',
    'input[placeholder*="Número de Serie" i]',
    'input[placeholder*="Numero de Serie" i]',
    'input#sale_q',
  ]
  for (let s = 0; s < preferredSelectors.length; s++) {
    const el = scope.querySelector(preferredSelectors[s]) as HTMLInputElement | null
    if (!el || el.disabled || el.readOnly || !okType(el)) continue
    if (!serialFieldVisibleEnough(el)) continue
    return el
  }

  const nodes = scope.querySelectorAll('input, textarea')
  const scored: { el: HTMLElement; score: number }[] = []
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i] as HTMLInputElement | HTMLTextAreaElement
    if (raw.disabled || raw.readOnly) continue
    const tag = raw.tagName
    const type =
      tag === 'INPUT' ? String((raw as HTMLInputElement).type || 'text').toLowerCase() : 'textarea'
    if (
      type === 'hidden' ||
      type === 'checkbox' ||
      type === 'radio' ||
      type === 'submit' ||
      type === 'button' ||
      type === 'image' ||
      type === 'reset' ||
      type === 'file'
    ) {
      continue
    }
    if (!serialFieldVisibleEnough(raw)) continue
    let score = 0
    if (type === 'text' || type === 'search' || type === '') score += 12
    if (tag === 'TEXTAREA') score += 10
    const ph = (raw.getAttribute('placeholder') || '').toLowerCase()
    if (ph.includes('serie') || ph.includes('imei') || ph.includes('scan') || ph.includes('código'))
      score += 8
    const id = String(raw.id || '').toLowerCase()
    if (id.includes('serie') || id.includes('serial') || id.includes('sn')) score += 6
    scored.push({ el: raw as HTMLElement, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.el ?? null
}

function pickSerialScanInputEl(): HTMLElement | null {
  const tb = document.querySelector('#TB_window')
  if (tb) {
    const a = pickSerialInputInContainer(tb)
    if (a) return a
  }
  const mp = document.querySelector('.msgPopUp')
  if (mp) {
    const st = window.getComputedStyle(mp)
    if (st.display !== 'none' && st.visibility !== 'hidden') {
      const b = pickSerialInputInContainer(mp)
      if (b) return b
    }
  }
  return null
}

function applyFocusToSerialField(el: HTMLElement): boolean {
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  } catch {
    // ignorar
  }
  const applyFocusOnly = (): void => {
    try {
      el.focus({ preventScroll: false })
    } catch {
      try {
        el.focus()
      } catch {
        // ignorar
      }
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      try {
        if (typeof el.select === 'function') el.select()
      } catch {
        // ignorar
      }
    }
  }

  applyFocusOnly()

  if (document.activeElement !== el) {
    try {
      // Nunca `el.click()` genérico: en ThickBox a veces el objetivo es un `<a href="javascript:...">` y dispara CSP.
      if (el instanceof HTMLAnchorElement) {
        safeProgrammaticActivateAnchor(el)
      } else {
        applyFocusOnly()
      }
    } catch {
      // ignorar
    }
  }
  if (document.activeElement !== el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: false })
          if (typeof el.select === 'function') el.select()
        } catch {
          // ignorar
        }
      })
    })
  }
  return document.activeElement === el
}

function focusSerialScanInput(): void {
  serialFocusCleanup?.()
  serialFocusCleanup = null
  if (serialModalFocusTimer) {
    window.clearTimeout(serialModalFocusTimer)
    serialModalFocusTimer = null
  }

  let tries = 0
  let intervalId: number | null = null
  let mo: MutationObserver | null = null

  const stop = (): void => {
    if (serialModalFocusTimer !== null) {
      window.clearTimeout(serialModalFocusTimer)
      serialModalFocusTimer = null
    }
    if (intervalId !== null) {
      window.clearInterval(intervalId)
      intervalId = null
    }
    mo?.disconnect()
    mo = null
    serialFocusCleanup = null
  }

  const tick = (): boolean => {
    if (!isPosSalesLikePage() || !isEnabledForCurrentPage()) {
      stop()
      return true
    }
    void unlockAudio()

    const candPopup = pickSerialScanInputEl()
    if (candPopup && applyFocusToSerialField(candPopup)) {
      stop()
      return true
    }

    const w = window as unknown as { element_serial_number?: HTMLInputElement }
    if (
      w.element_serial_number &&
      !w.element_serial_number.readOnly &&
      serialFieldVisibleEnough(w.element_serial_number) &&
      applyFocusToSerialField(w.element_serial_number)
    ) {
      stop()
      return true
    }

    const lineOpen = document.querySelector(
      '#sale_items li.serial-number input[data-sn="1"]:not([readonly])',
    ) as HTMLInputElement | null
    if (lineOpen && serialFieldVisibleEnough(lineOpen) && applyFocusToSerialField(lineOpen)) {
      stop()
      return true
    }

    return false
  }

  serialFocusCleanup = stop

  void tick()
  intervalId = window.setInterval(() => {
    if (tick()) return
    if (++tries >= 160) stop()
  }, 45)

  mo = new MutationObserver(() => {
    void tick()
  })
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'readonly'],
  })

  serialModalFocusTimer = window.setTimeout(() => stop(), 9000)
}

function maybeAutoOpenSerialModal(li: Element): void {
  if (!isPosSalesLikePage() || !isEnabledForCurrentPage()) return
  if (!lineNeedsSerialModal(li)) return
  if (isSerialEditorOpen()) return
  if (serialAutoOpenedLines.has(li)) return
  const add = li.querySelector('a.add_note') as HTMLElement | null
  if (!add) return
  serialAutoOpenedLines.add(li)
  void unlockAudio()
  safeProgrammaticActivateAnchor(add)
  focusSerialScanInput()
  window.setTimeout(() => {
    try {
      if (lineNeedsSerialModal(li)) serialAutoOpenedLines.delete(li)
    } catch {
      // ignorar
    }
  }, 4000)
}

function captureSerialInventoryFromPayload(o: Record<string, unknown>): void {
  serialInventoryCodes.clear()
  const rows = Array.isArray(o.data) ? o.data : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const cod = String((row as { cod_serie?: string }).cod_serie ?? '')
      .trim()
      .toLowerCase()
    if (cod) serialInventoryCodes.add(cod)
  }
}

function clearSerialInventory(): void {
  serialInventoryCodes.clear()
}

/** Longitud mínima para descartar serie “imposible” frente al inventario recibido (evita falsos en 1–3 caracteres). */
const MIN_SERIAL_COMPARE_LEN = 4

/** Coincidencia exacta o por subcadena con algún `cod_serie` del GET inicial (pistoleo parcial o código relacionado). */
function enteredOverlapsAnyInventoryCode(entered: string): boolean {
  const e = normalizeQuery(entered)
  if (!e || e.length < 2) return false
  for (const c of serialInventoryCodes) {
    if (!c || c.length < 2) continue
    if (e === c) return true
    if (c.includes(e) || e.includes(c)) return true
  }
  return false
}

/**
 * Enter / pistola en el campo del modal:
 * - Duplicado exacto respecto al inventario recibido → error.
 * - Con inventario cargado: si el texto **no** coincide ni como subcadena con ningún `cod_serie` → error al instante.
 * - Si hay solapamiento posible o aún no hay inventario → solo fallo retardado si el modal sigue abierto.
 */
function bindSerialModalEnterOutcome(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter') return
      if (!isPosSalesLikePage() || !isEnabledForCurrentPage()) return
      const t = e.target
      if (!(t instanceof HTMLInputElement)) return
      if (!t.closest('.msgPopUp')) return
      const ph = (t.getAttribute('placeholder') ?? '').toLowerCase()
      const serialLike =
        t.id === 'sale_q' ||
        ph.includes('serie') ||
        ph.includes('imei') ||
        !!t.closest('.sn_search')
      if (!serialLike) return
      const raw = t.value.trim()
      if (!raw) return
      void unlockAudio()
      const norm = normalizeQuery(raw)
      if (serialInventoryCodes.size > 0 && serialInventoryCodes.has(norm)) {
        notifySerialValidationTone(false)
        return
      }
      if (
        serialInventoryCodes.size > 0 &&
        raw.length >= MIN_SERIAL_COMPARE_LEN &&
        !enteredOverlapsAnyInventoryCode(raw)
      ) {
        notifySerialValidationTone(false)
        return
      }

      const captured = raw
      const needDelayedReject =
        serialInventoryCodes.size === 0 ||
        enteredOverlapsAnyInventoryCode(raw) ||
        raw.length < MIN_SERIAL_COMPARE_LEN
      if (!needDelayedReject) return

      window.setTimeout(() => {
        if (!isEnabledForCurrentPage()) return
        if (!isSerialEditorOpen()) return
        const inp =
          (document.querySelector('.msgPopUp .sn_search input') as HTMLInputElement | null) ||
          (document.querySelector('.msgPopUp input#sale_q') as HTMLInputElement | null)
        if (!inp || inp.value.trim() !== captured) return
        notifySerialValidationTone(false)
      }, 950)
    },
    true,
  )
}

function scanMsgPopUpSerialError(): void {
  if (!isEnabledForCurrentPage() || !isPosSalesLikePage()) return
  if (!isSerialEditorOpen()) {
    serialModalErrorPrev = ''
    return
  }
  const mp = document.querySelector('.msgPopUp')
  if (!mp) return
  const now = (mp.innerText ?? '').replace(/\s+/g, ' ').trim()
  if (now === serialModalErrorPrev) return
  const prev = serialModalErrorPrev
  serialModalErrorPrev = now
  const delta = now.length >= prev.length && prev.length > 0 ? now.slice(prev.length) : now
  if (delta.length < 6) return
  const failHint =
    /no es válid|no es valida|inválid|incorrect|no coincide|no se encuentra|ya fue|duplic|repetid|no pudo|limite|error al|no válid|invalid/i
  if (failHint.test(delta)) {
    notifySerialValidationTone(false)
  }
}

function installAutoSerialModalFlow(): void {
  const pollTb = (): void => {
    try {
      const vis = isSerialEditorOpen()
      if (!serialEditorWasVisible && vis) {
        serialLinesPendingAtModalOpen = countSaleLinesNeedingSerial()
      }
      if (serialEditorWasVisible && !vis) {
        serialModalErrorPrev = ''
        clearSerialInventory()
        const pendingBeforeClose = serialLinesPendingAtModalOpen
        serialLinesPendingAtModalOpen = 0
        const checkSerialAcceptedOk = (): void => {
          if (!isEnabledForCurrentPage() || !isPosSalesLikePage()) return
          const pa = countSaleLinesNeedingSerial()
          if (pendingBeforeClose > 0 && pa < pendingBeforeClose) {
            notifySerialValidationTone(true)
          }
        }
        checkSerialAcceptedOk()
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => checkSerialAcceptedOk())
        })
        window.setTimeout(() => checkSerialAcceptedOk(), 220)
        document.querySelectorAll('#sale_items li.serial-number').forEach((li) => {
          if (lineNeedsSerialModal(li)) serialAutoOpenedLines.delete(li)
        })
      }
      serialEditorWasVisible = vis
    } catch {
      // ignorar
    }
  }
  window.setInterval(pollTb, 280)

  const obs = new MutationObserver(() => {
    try {
      if (!isPosSalesLikePage() || !isEnabledForCurrentPage()) return
      document.querySelectorAll('#sale_items li.serial-number').forEach((li) => {
        maybeAutoOpenSerialModal(li)
      })
    } catch {
      // ignorar
    }
  })
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value'],
  })

  const errObs = new MutationObserver(() => {
    try {
      scanMsgPopUpSerialError()
    } catch {
      // ignorar
    }
  })
  errObs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  })

  try {
    document.querySelectorAll('#sale_items li.serial-number').forEach((li) => maybeAutoOpenSerialModal(li))
  } catch {
    // ignorar
  }
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

/** Evita doble tono si el bridge y el análisis AJAX detectan el mismo resultado casi a la vez. */
let lastSerialValidationToneAt = 0
let lastSerialValidationToneOk: boolean | null = null

function focusMainCartSaleQ(): boolean {
  const modalRoots = document.querySelectorAll('.msgPopUp, #TB_window')
  const isInsideModal = (el: Element): boolean => {
    for (const r of modalRoots) {
      if (r.contains(el)) return true
    }
    return false
  }

  const candidates: HTMLInputElement[] = []
  document.querySelectorAll('#sale_q').forEach((node) => {
    if (node instanceof HTMLInputElement && !isInsideModal(node)) candidates.push(node)
  })

  const cartSearchScore = (el: HTMLInputElement): number => {
    const ph = (el.getAttribute('placeholder') ?? '').toLowerCase()
    if (/serie|imei|número de serie|numero de serie/.test(ph)) return 0
    return 1
  }
  candidates.sort((a, b) => cartSearchScore(b) - cartSearchScore(a))

  for (const el of candidates) {
    try {
      el.focus()
      if (typeof el.select === 'function') el.select()
    } catch {
      continue
    }
    if (document.activeElement === el) return true
  }
  return false
}

/**
 * Tras un IMEI/Serie OK el POS suele cerrar el modal solo (sin Enter). El foco se devuelve al
 * buscador del carrito cuando el modal deja de estar activo; si es demasiado pronto, Bsale vuelve a robar el foco.
 */
function scheduleFocusCartSearchAfterSerialOk(): void {
  let attempts = 0
  const maxAttempts = 55

  const tick = (): void => {
    attempts++
    if (!isPosSalesLikePage() || !isEnabledForCurrentPage()) {
      try {
        document.documentElement.setAttribute('data-bsale-cart-saleq-focus', '0')
      } catch {
        // ignorar
      }
      return
    }

    if (isSerialEditorOpen() && attempts < maxAttempts) {
      window.setTimeout(tick, 95)
      return
    }

    let focused = focusMainCartSaleQ()
    try {
      document.documentElement.setAttribute('data-bsale-cart-saleq-focus', focused ? '1' : '0')
    } catch {
      // ignorar
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        focused = focusMainCartSaleQ() || focused
        try {
          document.documentElement.setAttribute('data-bsale-cart-saleq-focus', focused ? '1' : '0')
        } catch {
          // ignorar
        }
      })
    })
  }

  window.setTimeout(tick, 0)
}

/** Respuesta tipo listado de series ya cargadas (GET inicial), sin resultado de validación. */
function isSerialInventoryListPayload(o: Record<string, unknown>): boolean {
  if (!Array.isArray(o.data)) return false
  if ('msg' in o || 'error' in o || 'success' in o) return false
  if (o.status === 'fail' || o.status === 'error' || o.success === false) return false
  const keys = Object.keys(o)
  if (keys.length === 1 && keys[0] === 'data') return true
  return keys.every((k) => k === 'data' || k === 'timestamp' || k === 'time')
}

/**
 * Interpreta la respuesta de validación/carga de número de serie (AJAX).
 * Si no hay señal clara, devuelve null y pueden actuar otros hooks (p. ej. evento del bridge).
 */
function classifyGetSerialNumberResponse(rawBody: string, parsed: unknown, depth = 0): 'ok' | 'fail' | null {
  if (depth > 5) return null
  const raw = String(rawBody ?? '')
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed)) return null
    const o = parsed as Record<string, unknown>

    if (isSerialInventoryListPayload(o)) return null

    const status = o.status
    const success = o.success

    if (success === false) return 'fail'
    if (success === true) return 'ok'

    if (status === false) return 'fail'
    if (status === 'fail' || status === 'error' || status === 'FAIL' || status === 0 || status === '0') return 'fail'
    if (status === 'ok' || status === 'success' || status === 'OK' || status === 1 || status === '1') return 'ok'

    for (const key of ['msg', 'message', 'error', 'mensaje']) {
      const v = o[key]
      if (typeof v === 'string' && v.trim().length > 0) {
        const tl = v.toLowerCase()
        if (
          /no encontr|no válid|novalid|inválid|invalid|error|fail|duplic|utilizada|repetid|no es válid|limite|incorrect|no coincide|no se pudo|verifique|debe ingresar/i.test(
            tl,
          )
        ) {
          return 'fail'
        }
      }
    }

    const nested = o.data ?? o.result
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const sub = classifyGetSerialNumberResponse('', nested, depth + 1)
      if (sub !== null) return sub
    }
  }

  const t = raw.trim()
  if (!t) return null
  if (/\"success\"\s*:\s*false/i.test(t)) return 'fail'
  if (/\"status\"\s*:\s*\"fail\"/i.test(t) || /\"status\"\s*:\s*\"error\"/i.test(t)) return 'fail'
  if (/\"success\"\s*:\s*true/i.test(t)) return 'ok'
  if (/\"status\"\s*:\s*\"ok\"/i.test(t) || /\"status\"\s*:\s*\"success\"/i.test(t)) return 'ok'

  return null
}

function notifySerialValidationTone(ok: boolean): void {
  if (!isEnabledForCurrentPage()) return
  const now = Date.now()
  if (now - lastSerialValidationToneAt < 400 && lastSerialValidationToneOk === ok) return
  lastSerialValidationToneAt = now
  lastSerialValidationToneOk = ok

  try {
    document.documentElement.setAttribute('data-bsale-serial-tone', ok ? 'ok' : 'fail')
    document.documentElement.setAttribute('data-bsale-serial-tone-at', String(Date.now()))
  } catch {
    // ignorar
  }

  void unlockAudio()
  playTone(ok)

  if (ok && isPosSalesLikePage()) {
    scheduleFocusCartSearchAfterSerialOk()
  }
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

/** Texto del helper cuando Bsale marca número de serie duplicado (recepción stock). */
const STOCK_DUPLICATE_MSG = 'Serie repetida'
const stockSeriesHelperPrevText = new WeakMap<Element, string>()

function scanStockReceptionDuplicateSeries(): void {
  if (!isEnabledForCurrentPage()) return
  if (getPageKeyFromLocation() !== 'stock_reception') return

  const helpers = document.querySelectorAll('.numbered-fields .mdc-text-field-helper-text')
  helpers.forEach((el) => {
    const now = (el.textContent ?? '').trim()
    const prev = stockSeriesHelperPrevText.get(el) ?? ''
    stockSeriesHelperPrevText.set(el, now)
    if (now === STOCK_DUPLICATE_MSG && prev !== STOCK_DUPLICATE_MSG) {
      void unlockAudio()
      playTone(false)
    }
  })
}

function installStockReceptionDuplicateWatcher(): void {
  const obs = new MutationObserver(() => {
    scanStockReceptionDuplicateSeries()
  })
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
  })
  document.addEventListener(
    'input',
    (e) => {
      const t = e.target
      if (t instanceof Element && t.closest('.numbered-fields')) void unlockAudio()
    },
    true,
  )
  scanStockReceptionDuplicateSeries()
}

function installBsaleFlowHooks(): void {
  window.addEventListener('bsale-barras-event', (evt: Event) => {
    try {
    const ce = evt as CustomEvent<{
      kind: 'ajax' | 'addToCart' | 'serial_validation'
      url?: string
      body?: string
      ok?: boolean
    }>
    const detail = ce.detail
    if (detail == null || typeof detail !== 'object' || !('kind' in detail)) return
    const kind = (detail as { kind: string }).kind
    if (typeof kind !== 'string') return

    if (kind === 'serial_validation') {
      notifySerialValidationTone(detail.ok === true)
      return
    }

    if (kind === 'addToCart') {
      const attempt = latestPendingAttempt()
      if (!attempt || attempt.resolved) return
      // eslint-disable-next-line no-console
      console.info('[bsale-barras]', { stage: 'addToCart', query: attempt.query })
      resolveAttempt(attempt, true)
      return
    }

    if (kind !== 'ajax' || !('url' in detail) || !detail.url) return
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

    const urlJoined = `${parsedUrl.pathname}${parsedUrl.search}`
    if (/get_serial_number/i.test(urlJoined) || /get_serial_number/i.test(String(detail.url ?? ''))) {
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>
        if (isSerialInventoryListPayload(rec)) {
          captureSerialInventoryFromPayload(rec)
        }
      }
      const verdict = classifyGetSerialNumberResponse(String(detail.body ?? ''), parsed)
      if (verdict !== null) {
        notifySerialValidationTone(verdict === 'ok')
        return
      }
    }

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
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bsale-barras]', err)
    }
  })

  const injected = document.createElement('script')
  injected.src = chrome.runtime.getURL('page-bridge.js')
  injected.async = false
  const parent = document.head || document.documentElement
  if (parent) {
    parent.appendChild(injected)
    injected.remove()
  }
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
  bindSerialModalEnterOutcome()
  ensureSaleQHandler()
  installStockReceptionDuplicateWatcher()
  installAutoSerialModalFlow()
}

void init().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bsale-barras] init failed', err)
})

