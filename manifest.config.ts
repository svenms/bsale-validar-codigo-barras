import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Bsale Validar Codigo Barras',
  version: '0.1.0',
  permissions: ['storage'],
  options_page: 'src/options/options.html',
  content_scripts: [
    {
      js: ['src/content/main.ts'],
      matches: [
        'https://app.bsale.cl/documents/shipping/from_scratch*',
        'https://app.bsale.cl/documents/sales*',
        'https://app.bsale.cl/mobile/sales*',
      ],
      run_at: 'document_start',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['page-bridge.js'],
      matches: ['https://app.bsale.cl/*'],
    },
  ],
})

