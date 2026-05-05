/**
 * Verifica que el content script marque el DOM (`data-bsale-barras-ext`)
 * con Chromium + extensión cargada desde `dist/`.
 *
 * Uso:
 *   npm run pw:verify
 *   npm run pw:verify -- https://app.bsale.cl/documents/shipping/from_scratch
 *
 * Variables:
 *   PW_HEADLESS=1  intenta modo headless (la extensión puede no cargarse según versión de Chromium).
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const extensionPath = path.resolve(projectRoot, 'dist')
const userDataDir = path.resolve(projectRoot, '.playwright-chromium-profile')

const targetUrl =
  process.argv.find((a) => a.startsWith('http')) ||
  'https://app.bsale.cl/documents/shipping/from_scratch'

const headless = process.env.PW_HEADLESS === '1'

if (!fs.existsSync(extensionPath)) {
  console.error(`[pw:verify] No existe dist en: ${extensionPath}. Ejecuta "npm run build".`)
  process.exit(1)
}

console.log('[pw:verify] Extensión:', extensionPath)
console.log('[pw:verify] URL:', targetUrl)
console.log('[pw:verify] headless:', headless)

const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
  viewport: { width: 1280, height: 800 },
})

const page = await context.newPage()

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await new Promise((r) => setTimeout(r, 1500))
  const marker = await page.evaluate(() =>
    document.documentElement.getAttribute('data-bsale-barras-ext'),
  )
  const title = await page.title()

  console.log('[pw:verify] document.title:', title)
  console.log('[pw:verify] data-bsale-barras-ext:', JSON.stringify(marker))

  if (marker === 'loaded') {
    console.log('[pw:verify] OK — content script cargado.')
    await context.close()
    process.exit(0)
  }

  console.error(
    '[pw:verify] FAIL — no se vio data-bsale-barras-ext=loaded (¿sesión expirada o URL sin coincidir con el manifest?).',
  )
  await context.close()
  process.exit(2)
} catch (e) {
  console.error('[pw:verify] ERROR', e)
  await context.close()
  process.exit(1)
}
