import { compareSemver } from './shared/semver'
import { fetchLatestPublishedVersion } from './shared/githubRelease'
import { UPDATE_STORAGE_KEY, type UpdateCheckState } from './shared/updateCheckState'

const UPDATE_ALARM = 'bsale_barras_update_check'
/** 8 horas (Chrome usa minutos; mínimo efectivo en desarrollo puede variar). */
const PERIOD_MINUTES = 8 * 60

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: PERIOD_MINUTES })
  void runUpdateCheck()
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: PERIOD_MINUTES })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) void runUpdateCheck()
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as { type?: string }
  if (m?.type !== 'BSALE_BARRAS_CHECK_UPDATES') return false
  void runUpdateCheck().then((state) => {
    sendResponse({ ok: true, state })
  })
  return true
})
