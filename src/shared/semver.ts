/** Compara versiones tipo semver simple (solo segmentos numéricos). */
export function compareSemver(a: string, b: string): number {
  const norm = (s: string): number[] =>
    s
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((x) => parseInt(x.replace(/\D/g, ''), 10) || 0)
  const pa = norm(a)
  const pb = norm(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}
