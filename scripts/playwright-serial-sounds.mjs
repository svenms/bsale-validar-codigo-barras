/**
 * Observa los marcadores que el content script escribe en <html>:
 *   data-bsale-serial-tone="ok"|"fail"
 *   data-bsale-serial-tone-at="<timestamp>"
 *   data-bsale-cart-saleq-focus="1"|"0"
 *
 * El POS suele **aceptar el IMEI/Serie sin Enter** cuando es válido; los tonos igual se disparan
 * por XHR/fetch (`get_serial_number`) y por el bridge en la página.
 *
 * Uso:
 *   npm run build
 *   npm run pw:serial
 *   npm run pw:serial -- https://app.bsale.cl/mobile/sales
 *
 * Inicia sesión en Bsale, agrega un producto seriado, escanea serie válida e inválida en el modal.
 * Este script registra en consola cada cambio de tono y si el foco quedó en el buscador del carrito.
 *
 * Variables:
 *   PW_HEADLESS=1  (la extensión a veces no carga igual en headless)
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
  console.error(`[pw:serial] Falta dist/. Ejecuta "npm run build".`)
  process.exit(1)
}

console.log('[pw:serial] Extensión:', extensionPath)
console.log('[pw:serial] URL inicial:', targetUrl)
console.log('[pw:serial] headless:', headless)
console.log(
  '[pw:serial] Tras iniciar sesión: producto con serie → modal → serie válida (auto) / inválida (Enter o mensaje).\n',
)

const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  viewport: { width: 1280, height: 820 },
})

const page = await context.newPage()

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})

let lastTone = null
let lastToneAt = null
let lastFocus = null

let closing = false
process.on('SIGINT', async () => {
  closing = true
  try {
    await context.close()
  } catch {}
  process.exit(0)
})

for (let i = 0; !closing; i++) {
  await page.waitForTimeout(400)
  const snap = await page.evaluate(() => {
    const root = document.documentElement
    return {
      ext: root.getAttribute('data-bsale-barras-ext'),
      tone: root.getAttribute('data-bsale-serial-tone'),
      toneAt: root.getAttribute('data-bsale-serial-tone-at'),
      cartFocus: root.getAttribute('data-bsale-cart-saleq-focus'),
      activeId: document.activeElement?.id ?? '',
      activePh:
        document.activeElement instanceof HTMLInputElement
          ? document.activeElement.placeholder?.slice(0, 40) ?? ''
          : '',
    }
  })

  if (snap.ext !== 'loaded' && i % 25 === 0) {
    console.log('[pw:serial] (esperando content script marker)', snap.ext)
  }

  if (snap.toneAt !== lastToneAt || snap.tone !== lastTone) {
    if (snap.tone != null && snap.toneAt != null) {
      console.log('[pw:serial] TONO:', snap.tone, ' en', new Date(Number(snap.toneAt)).toISOString())
      lastTone = snap.tone
      lastToneAt = snap.toneAt
    }
  }

  if (snap.cartFocus !== lastFocus && snap.cartFocus != null) {
    console.log(
      '[pw:serial] FOCO carrito #sale_q:',
      snap.cartFocus === '1' ? 'OK' : 'NO',
      '| activeElement id=',
      snap.activeId,
      'placeholder~',
      JSON.stringify(snap.activePh),
    )
    lastFocus = snap.cartFocus
  }
}
