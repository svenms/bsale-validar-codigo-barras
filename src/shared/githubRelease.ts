import { compareSemver } from './semver'

/** Repo público publicado en GitHub (releases o tags). */
export const GITHUB_REPO_FULL = 'svenms/bsale-validar-codigo-barras'

type GhHeaders = Record<string, string>

function ghHeaders(): GhHeaders {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function stripVersionTag(tag: string): string {
  return tag.replace(/^v/i, '').trim()
}

/**
 * Última versión publicada y enlace útil.
 * 1) Release más reciente (sin usar `/releases/latest` para evitar 404 cuando no hay releases).
 * 2) Si no hay releases, el tag semver más alto entre los devueltos por la API.
 */
export async function fetchLatestPublishedVersion(): Promise<{
  version: string
  releasePageUrl: string
} | null> {
  const base = `https://api.github.com/repos/${GITHUB_REPO_FULL}`
  const headers = ghHeaders()

  try {
    const rel = await fetch(`${base}/releases?per_page=10`, { headers })
    if (rel.ok) {
      const list = (await rel.json()) as Array<{
        tag_name?: string
        html_url?: string
        draft?: boolean
        prerelease?: boolean
      }>
      const latestStable = list.find((r) => r && r.draft !== true && r.prerelease !== true)
      if (!latestStable) throw new Error('No stable release')
      const raw = String(latestStable.tag_name ?? '')
      const version = stripVersionTag(raw)
      if (version && /^\d+\.\d+/.test(version)) {
        return {
          version,
          releasePageUrl:
            typeof latestStable.html_url === 'string'
              ? latestStable.html_url
              : `https://github.com/${GITHUB_REPO_FULL}/releases`,
        }
      }
    }
  } catch {
    // seguir con tags
  }

  try {
    const res = await fetch(`${base}/tags?per_page=100`, { headers })
    if (!res.ok) return null
    const tags = (await res.json()) as Array<{ name?: string }>
    let best = ''
    let bestName = ''
    for (const t of tags) {
      const name = String(t.name ?? '')
      const v = stripVersionTag(name)
      if (!/^\d+\.\d+/.test(v)) continue
      if (!best || compareSemver(v, best) > 0) {
        best = v
        bestName = name
      }
    }
    if (!best) return null
    return {
      version: best,
      releasePageUrl: `https://github.com/${GITHUB_REPO_FULL}/releases/tag/${encodeURIComponent(bestName)}`,
    }
  } catch {
    return null
  }
}
