import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Bsale Validar Codigo Barras',
  version: '0.2.14',
  update_url: 'https://raw.githubusercontent.com/svenms/bsale-validar-codigo-barras/master/updates.xml',
  permissions: ['storage', 'alarms', 'tabs', 'cookies'],
  host_permissions: [
    'https://api.github.com/*',
    'https://stock.bsale.app/*',
    'https://landing.bsale.cl/*',
    'https://clients.bsale.cl/*',
    'https://app.bsale.cl/*',
    'https://report.bsale.app/*',
    'https://login.bsale.cl/*',
    'https://product-admin.bsale.io/*',
  ],
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  options_page: 'src/options/options.html',
  content_scripts: [
    {
      js: ['src/content/main.ts'],
      matches: [
        'https://app.bsale.cl/documents/shipping/from_scratch*',
        'https://app.bsale.cl/documents/sales*',
        'https://app.bsale.cl/mobile/sales*',
        'https://stock.bsale.app/admin/stock/reception*',
      ],
      run_at: 'document_start',
    },
    {
      js: ['src/content/internalDispatchNotifier.ts'],
      matches: [
        'https://landing.bsale.cl/*',
        'https://clients.bsale.cl/*',
        'https://app.bsale.cl/*',
        'https://stock.bsale.app/*',
        'https://report.bsale.app/*',
        'https://product-admin.bsale.io/*',
      ],
      run_at: 'document_idle',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['page-bridge.js'],
      matches: ['https://app.bsale.cl/*', 'https://stock.bsale.app/*'],
    },
  ],
})

