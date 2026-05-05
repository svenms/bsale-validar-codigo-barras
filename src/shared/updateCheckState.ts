export type UpdateCheckState = {
  installedVersion: string
  remoteVersion: string | null
  hasUpdate: boolean
  releasePageUrl: string | null
  lastCheckedAt: number | null
  error: string | null
}

export const UPDATE_STORAGE_KEY = 'bsale_barras_update_info'
