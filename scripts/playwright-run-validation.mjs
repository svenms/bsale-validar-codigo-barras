import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const context = browser.contexts()[0]
if (!context) {
  throw new Error('No hay contexto Playwright activo en puerto 9222.')
}
const page = context.pages()[0] ?? (await context.newPage())
page.on('dialog', (dialog) => {
  dialog.accept().catch(() => {})
})
await page.goto('https://app.bsale.cl/documents/shipping/from_scratch', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#sale_q', { timeout: 30000 })

async function cartSnapshot() {
  return await page.evaluate(() => {
    const map = {}
    const items = document.querySelectorAll('#sale_items li')
    for (const li of items) {
      const barcode = li.querySelector('input#barcode_to_add')?.value?.trim()
      const qtyRaw =
        li.querySelector('input#cart_item_cantidad')?.value ??
        li.querySelector('input#cart_item_cantidad')?.getAttribute('current-value') ??
        '0'
      const qty = Number(qtyRaw)
      if (barcode && Number.isFinite(qty)) map[barcode] = qty
    }
    return map
  })
}

async function runCase(label, query, expectBarcode, expectSuccess) {
  const requests = []
  const logs = []
  const handler = (req) => {
    const url = req.url()
    if (url.includes('/pos_mobile/find_attr') || url.includes('/pos_mobile/find_code') || url.includes('/cart/update_cart/')) {
      requests.push(url)
    }
  }
  const consoleHandler = (msg) => {
    const txt = msg.text()
    if (txt.includes('[bsale-barras]')) logs.push(txt)
  }
  page.on('request', handler)
  page.on('console', consoleHandler)

  const before = await cartSnapshot()
  await page.fill('#sale_q', query)
  await page.press('#sale_q', 'Enter')
  await page.waitForTimeout(3500)
  const after = await cartSnapshot()

  page.off('request', handler)
  page.off('console', consoleHandler)

  const beforeQty = Number(before[expectBarcode] ?? 0)
  const afterQty = Number(after[expectBarcode] ?? 0)
  const domSuccess = afterQty > beforeQty
  const netSuccess = requests.some((u) => u.includes('/cart/update_cart/'))
  const success = domSuccess && netSuccess

  return {
    label,
    query,
    expectBarcode,
    expectSuccess,
    beforeQty,
    afterQty,
    domSuccess,
    netSuccess,
    success,
    requests,
    logs,
  }
}

const successCase = await runCase('success', '4260248821409', '4260248821409', true)
const failCase = await runCase('fail', '694349', '694349', false)

console.log(JSON.stringify({ successCase, failCase }, null, 2))

