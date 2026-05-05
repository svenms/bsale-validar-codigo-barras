import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Bsale Validar Codigo Barras',
  version: '0.2.12',
  permissions: ['storage', 'alarms'],
  host_permissions: ['https://api.github.com/*'],
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
  ],
  web_accessible_resources: [
    {
      resources: ['page-bridge.js'],
      matches: ['https://app.bsale.cl/*', 'https://stock.bsale.app/*'],
    },
  ],
})

