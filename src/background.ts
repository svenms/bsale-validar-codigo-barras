import { compareSemver } from './shared/semver'
import { fetchLatestPublishedVersion } from './shared/githubRelease'
import { UPDATE_STORAGE_KEY, type UpdateCheckState } from './shared/updateCheckState'
import {
  buildPendingDispatchEndpoint,
  EMPTY_PENDING_DISPATCH_STATE,
  LAST_OFFICE_ID_STORAGE_KEY,
  PENDING_DISPATCH_ALARM,
  PENDING_DISPATCH_PERIOD_MINUTES,
  PENDING_DISPATCH_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  STOCK_SESSION_ENDPOINT,
  STOCK_RECEPTION_URL,
  type BsaleSettings,
  type PendingDispatchItem,
  type PendingDispatchState,
} from './shared/internalDispatchMonitor'

const UPDATE_ALARM = 'bsale_barras_update_check'
/** 8 horas (Chrome usa minutos; mínimo efectivo en desarrollo puede variar). */
const PERIOD_MINUTES = 8 * 60
const SESSION_WARMUP_TIMEOUT_MS = 12000
const STOCK_BASE_URL = 'https://stock.bsale.app/'
const STOCK_GOTO_PATH = '/goto?owner=stock_v2&url=/admin/stock/reception'
const COOKIE_SOURCE_URLS = [
  'https://landing.bsale.cl/',
  'https://app.bsale.cl/',
  'https://clients.bsale.cl/',
  'https://report.bsale.app/',
  'https://login.bsale.cl/',
  'https://product-admin.bsale.io/',
]

const DEFAULT_PENDING_DISPATCH_ENABLED = true

async function runUpdateCheck(): Promise<UpdateCheckState> {
  const installedVersion = chrome.runtime.getManifest().version
  const base: UpdateCheckState = {
    installedVersion,
    remoteVersion: null,
    hasUpdate: false,
    releasePageUrl: null,
    lastCheckedAt: Date.now(),
    checking: false,
    error: null,
  }

  try {
    const remote = await fetchLatestPublishedVersion()
    if (!remote) {
      const err: UpdateCheckState = {
        ...base,
        error: 'No se pudo leer la versión en GitHub (sin releases/tags o error de red).',
      }
      await chrome.storage.local.set({ [UPDATE_STORAGE_KEY]: err })
      return err
    }

    const cmp = compareSemver(remote.version, installedVersion)
    const hasUpdate = cmp > 0

    const state: UpdateCheckState = {
      ...base,
      remoteVersion: remote.version,
      hasUpdate,
      releasePageUrl: remote.releasePageUrl,
    }
    await chrome.storage.local.set({ [UPDATE_STORAGE_KEY]: state })
    return state
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const errState: UpdateCheckState = {
      ...base,
      error: msg || 'Error desconocido',
    }
    await chrome.storage.local.set({ [UPDATE_STORAGE_KEY]: errState })
    return errState
  }
}

async function isPendingDispatchMonitorEnabled(): Promise<boolean> {
  const data = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY] as
    | Partial<BsaleSettings>
    | undefined
  return data?.checkPendingInternalDispatch ?? DEFAULT_PENDING_DISPATCH_ENABLED
}

function parsePendingDispatchPayload(payload: unknown): PendingDispatchItem[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const rec = row as Record<string, unknown>
      const dispatchId = Number(rec.dispatchId ?? 0)
      const documentId = Number(rec.documentId ?? 0)
      const documentNumber = String(rec.documentNumber ?? '').trim()
      const typeDocumentName = String(rec.typeDocumentName ?? '').trim()
      if (!documentNumber || !Number.isFinite(dispatchId) || !Number.isFinite(documentId)) return null
      return { dispatchId, documentId, documentNumber, typeDocumentName }
    })
    .filter((row): row is PendingDispatchItem => row != null)
}

async function persistPendingDispatchState(state: PendingDispatchState): Promise<void> {
  await chrome.storage.local.set({ [PENDING_DISPATCH_STORAGE_KEY]: state })
}

async function persistLastOfficeId(officeId: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_OFFICE_ID_STORAGE_KEY]: officeId })
}

async function readLastOfficeId(): Promise<number | null> {
  const raw = (await chrome.storage.local.get(LAST_OFFICE_ID_STORAGE_KEY))[LAST_OFFICE_ID_STORAGE_KEY]
  const officeId = Number(raw)
  return Number.isFinite(officeId) && officeId > 0 ? officeId : null
}

async function warmupStockSession(): Promise<boolean> {
  const tab = await chrome.tabs.create({ url: STOCK_RECEPTION_URL, active: false })
  if (tab.id == null) return false
  const tabId = tab.id
  const ok = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve(value)
    }
    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId !== tabId) return
      if (info.status === 'complete') finish(true)
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    setTimeout(() => finish(false), SESSION_WARMUP_TIMEOUT_MS)
  })
  await chrome.tabs.remove(tabId).catch(() => {
    // noop
  })
  return ok
}

function isBsaleHost(host: string): boolean {
  return /(?:^|\.)bsale\.(?:cl|app|io)$/i.test(host)
}

async function gatherGotoWarmupUrls(): Promise<string[]> {
  const urls = new Set<string>()
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (!tab.url) continue
    try {
      const u = new URL(tab.url)
      if (!isBsaleHost(u.hostname)) continue
      urls.add(`${u.origin}${STOCK_GOTO_PATH}`)
    } catch {
      // noop
    }
  }
  urls.add(`https://app.bsale.cl${STOCK_GOTO_PATH}`)
  urls.add(`https://landing.bsale.cl${STOCK_GOTO_PATH}`)
  return Array.from(urls)
}

async function warmupStockSessionViaGoto(): Promise<boolean> {
  const urls = await gatherGotoWarmupUrls()
  for (const gotoUrl of urls) {
    const tab = await chrome.tabs.create({ url: gotoUrl, active: false })
    if (tab.id == null) continue
    const tabId = tab.id
    const ok = await new Promise<boolean>((resolve) => {
      let done = false
      const finish = (value: boolean): void => {
        if (done) return
        done = true
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve(value)
      }
      const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo): void => {
        if (updatedTabId !== tabId) return
        if (info.status === 'complete') finish(true)
      }
      chrome.tabs.onUpdated.addListener(onUpdated)
      setTimeout(() => finish(false), SESSION_WARMUP_TIMEOUT_MS)
    })
    await chrome.tabs.remove(tabId).catch(() => {
      // noop
    })
    if (!ok) continue
    const stockSession = await chrome.cookies.get({
      url: STOCK_BASE_URL,
      name: 'bsale-session',
    })
    if (stockSession?.value) return true
  }
  return false
}

async function bootstrapStockSessionFromOtherBsaleCookies(): Promise<boolean> {
  for (const sourceUrl of COOKIE_SOURCE_URLS) {
    const source = await chrome.cookies.getAll({
      url: sourceUrl,
      name: 'bsale-session',
    })
    if (!source.length) continue
    const candidate = source[0]
    const created = await chrome.cookies.set({
      url: STOCK_BASE_URL,
      name: 'bsale-session',
      value: candidate.value,
      path: candidate.path || '/',
      secure: true,
      httpOnly: true,
      sameSite: candidate.sameSite,
      expirationDate: candidate.expirationDate,
    })
    if (created) return true
  }
  return false
}

function parseOfficeIdFromSessionPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  const direct = Number(rec.office_id ?? rec.officeId)
  if (Number.isFinite(direct) && direct > 0) return direct

  const candidates = [rec.office, rec.currentOffice, rec.session, rec.user]
  for (const node of candidates) {
    if (!node || typeof node !== 'object') continue
    const nrec = node as Record<string, unknown>
    const nested = Number(nrec.id ?? nrec.office_id ?? nrec.officeId)
    if (Number.isFinite(nested) && nested > 0) return nested
  }
  return null
}

async function fetchCurrentOfficeIdFromSession(): Promise<{
  officeId: number | null
  requiresSessionRefresh: boolean
  error: string | null
}> {
  try {
    const response = await fetch(STOCK_SESSION_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    })
    const bodyText = await response.text()
    if (response.status === 401 || response.status === 403) {
      return { officeId: null, requiresSessionRefresh: true, error: `HTTP ${response.status}` }
    }
    if (!response.ok) return { officeId: null, requiresSessionRefresh: false, error: `HTTP ${response.status}` }

    let payload: unknown = null
    try {
      payload = bodyText ? JSON.parse(bodyText) : null
    } catch {
      payload = null
    }
    const officeId = parseOfficeIdFromSessionPayload(payload)
    if (officeId) {
      await persistLastOfficeId(officeId)
      return { officeId, requiresSessionRefresh: false, error: null }
    }
    const lastOfficeId = await readLastOfficeId()
    if (lastOfficeId) return { officeId: lastOfficeId, requiresSessionRefresh: false, error: null }
    return { officeId: null, requiresSessionRefresh: false, error: 'No se pudo determinar office_id desde sesión' }
  } catch (error) {
    return {
      officeId: null,
      requiresSessionRefresh: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function fetchPendingDispatchStateOnce(officeId: number): Promise<PendingDispatchState> {
  try {
    const response = await fetch(buildPendingDispatchEndpoint(officeId), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    })
    const bodyText = await response.text()
    if (response.status === 401 || response.status === 403) {
      return {
        ...EMPTY_PENDING_DISPATCH_STATE,
        checkedAt: Date.now(),
        officeId,
        lastError: `HTTP ${response.status}`,
        requiresSessionRefresh: true,
      }
    }
    if (!response.ok) {
      return {
        ...EMPTY_PENDING_DISPATCH_STATE,
        checkedAt: Date.now(),
        officeId,
        lastError: `HTTP ${response.status}`,
      }
    }
    let payload: unknown = null
    try {
      payload = bodyText ? JSON.parse(bodyText) : null
    } catch {
      payload = null
    }
    const pending = parsePendingDispatchPayload(payload)
    return {
      checkedAt: Date.now(),
      ok: true,
      officeId,
      pendingCount: pending.length,
      pending,
      requiresSessionRefresh: false,
      lastError: null,
    }
  } catch (error) {
    return {
      ...EMPTY_PENDING_DISPATCH_STATE,
      checkedAt: Date.now(),
      officeId,
      lastError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runPendingDispatchCheck(trigger: 'alarm' | 'startup' | 'message'): Promise<PendingDispatchState> {
  const enabled = await isPendingDispatchMonitorEnabled()
  if (!enabled) {
    const disabledState: PendingDispatchState = {
      ...EMPTY_PENDING_DISPATCH_STATE,
      checkedAt: Date.now(),
      ok: true,
      lastError: null,
    }
    await persistPendingDispatchState(disabledState)
    return disabledState
  }

  let officeInfo = await fetchCurrentOfficeIdFromSession()
  if (officeInfo.requiresSessionRefresh) {
    const cookieBootstrapOk = await bootstrapStockSessionFromOtherBsaleCookies()
    if (cookieBootstrapOk) officeInfo = await fetchCurrentOfficeIdFromSession()
  }
  if (officeInfo.requiresSessionRefresh && trigger !== 'alarm') {
    const gotoWarmupOk = await warmupStockSessionViaGoto()
    if (gotoWarmupOk) officeInfo = await fetchCurrentOfficeIdFromSession()
  }
  if (officeInfo.requiresSessionRefresh && trigger !== 'alarm') {
    const warmupOk = await warmupStockSession()
    if (warmupOk) officeInfo = await fetchCurrentOfficeIdFromSession()
  }
  if (!officeInfo.officeId) {
    const lastOfficeId = await readLastOfficeId()
    if (lastOfficeId) {
      officeInfo = { officeId: lastOfficeId, requiresSessionRefresh: false, error: null }
    }
  }
  if (!officeInfo.officeId) {
    const errState: PendingDispatchState = {
      ...EMPTY_PENDING_DISPATCH_STATE,
      checkedAt: Date.now(),
      lastError: officeInfo.error ?? 'No hay office_id disponible',
      requiresSessionRefresh: officeInfo.requiresSessionRefresh,
    }
    await persistPendingDispatchState(errState)
    return errState
  }

  let state = await fetchPendingDispatchStateOnce(officeInfo.officeId)
  if (state.requiresSessionRefresh && trigger !== 'alarm') {
    const warmupOk = await warmupStockSession()
    if (warmupOk) state = await fetchPendingDispatchStateOnce(officeInfo.officeId)
  }

  await persistPendingDispatchState(state)
  return state
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: PERIOD_MINUTES })
  chrome.alarms.create(PENDING_DISPATCH_ALARM, { periodInMinutes: PENDING_DISPATCH_PERIOD_MINUTES })
  void runUpdateCheck()
  void runPendingDispatchCheck('startup')
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: PERIOD_MINUTES })
  chrome.alarms.create(PENDING_DISPATCH_ALARM, { periodInMinutes: PENDING_DISPATCH_PERIOD_MINUTES })
  void runPendingDispatchCheck('startup')
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) void runUpdateCheck()
  if (alarm.name === PENDING_DISPATCH_ALARM) void runPendingDispatchCheck('alarm')
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as { type?: string }
  if (m?.type === 'BSALE_BARRAS_CHECK_UPDATES') {
    void runUpdateCheck().then((state) => {
      sendResponse({ ok: true, state })
    })
    return true
  }
  if (m?.type === 'BSALE_BARRAS_CHECK_PENDING_INTERNAL_DISPATCH') {
    void runPendingDispatchCheck('message').then((state) => {
      sendResponse({ ok: true, state })
    })
    return true
  }
  return false
})
