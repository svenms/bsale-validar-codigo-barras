import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function arg(name, fallback = '') {
  const key = `--${name}`
  const idx = process.argv.indexOf(key)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return fallback
}

async function readVersion(rootDir) {
  const pkgRaw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  return String(pkg.version || '').trim()
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const rootDir = path.resolve(here, '..')

  const version = arg('version') || (await readVersion(rootDir))
  const extensionId = arg('extension-id') || process.env.EXTENSION_ID
  const codebase = arg('codebase') || process.env.CRX_CODEBASE_URL
  const outPath = path.resolve(arg('out') || path.join(rootDir, 'updates.xml'))

  if (!version) throw new Error('Falta version')
  if (!extensionId) throw new Error('Falta extension-id (usar --extension-id o EXTENSION_ID)')
  if (!codebase) throw new Error('Falta codebase URL (usar --codebase o CRX_CODEBASE_URL)')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${extensionId}">
    <updatecheck codebase="${codebase}" version="${version}" />
  </app>
</gupdate>
`

  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, xml, 'utf8')
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ outPath, version, extensionId, codebase }, null, 2))
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
