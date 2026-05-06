import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crx3 from 'crx3'

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
  const keyPath = arg('key') || process.env.CRX_KEY_PATH
  const outDirArg = arg('out') || path.join(rootDir, 'artifacts')
  const outDir = path.resolve(outDirArg)

  if (!keyPath) {
    throw new Error('Falta key PEM. Usa --key <path> o CRX_KEY_PATH.')
  }

  const version = await readVersion(rootDir)
  if (!version) throw new Error('No se pudo leer version desde package.json')

  await fs.mkdir(outDir, { recursive: true })

  await crx3([path.join(rootDir, 'dist', 'manifest.json')], {
    keyPath: path.resolve(keyPath),
    crxPath: path.join(outDir, `bsale-validar-codigo-barras-v${version}.crx`),
    zipPath: path.join(outDir, `bsale-validar-codigo-barras-v${version}.zip`),
    xmlPath: path.join(outDir, `bsale-validar-codigo-barras-v${version}.xml`),
  })

  const crxPath = path.join(outDir, `bsale-validar-codigo-barras-v${version}.crx`)
  await fs.access(crxPath)
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ version, crxPath }, null, 2))
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
