import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const extensionPath = path.resolve(projectRoot, 'dist')
const userDataDir = path.resolve(projectRoot, '.playwright-chromium-profile')

if (!fs.existsSync(extensionPath)) {
  console.error(`No existe dist en: ${extensionPath}. Ejecuta "npm run build" primero.`)
  process.exit(1)
}

console.log('Iniciando Chromium persistente con Playwright...')
console.log(`Extension: ${extensionPath}`)
console.log(`Perfil: ${userDataDir}`)

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--remote-debugging-port=9222',
  ],
  viewport: null,
})

const pages = context.pages()
if (pages.length === 0) {
  await context.newPage()
}

const page = context.pages()[0]
await page.goto('https://app.bsale.cl/documents/shipping/from_scratch', {
  waitUntil: 'domcontentloaded',
})

console.log('Chromium listo. Mantengo la ventana abierta para pruebas.')
console.log('Inicia sesion en Bsale y avisa cuando quieras que pruebe.')

// Mantener vivo el proceso.
await new Promise(() => {})

