# Bsale Validar Codigo Barras - Guia Operativa y de Diagnostico

Este documento resume como funciona la extension, como funciona el flujo de Bsale y que probar cuando Bsale cambie.

## 1) Objetivo de la extension

Dar feedback inmediato al escanear codigos en Bsale:

- `TRUE` cuando el producto se agrega/actualiza correctamente en el carrito.
- `FALSE` cuando no se agrega (multiples resultados, sin stock, error de backend, etc.).

La extension funciona en:

- `https://app.bsale.cl/documents/shipping/from_scratch*`
- `https://app.bsale.cl/documents/sales*`
- `https://app.bsale.cl/mobile/sales*`

## 2) Arquitectura actual (resumen rapido)

- `manifest.config.ts`
  - Define `content_scripts` y `web_accessible_resources`.
- `src/content/main.ts`
  - Lector de `Enter` en `#sale_q`.
  - Gestiona intentos en cola, decide `TRUE/FALSE`, reproduce sonido y loggea en consola.
  - Escucha eventos emitidos por el bridge de pagina.
- `public/page-bridge.js`
  - Se ejecuta en contexto de la pagina (no aislado).
  - Intercepta `XMLHttpRequest`, `fetch`, `jQuery.ajax` y `addToCart`.
  - Emite eventos `bsale-barras-event` hacia el content script.
- `src/options/options.html` + `src/options/options.ts`
  - Settings por pagina.
  - Volumen.
  - Presets de sonido separados para `TRUE` y `FALSE` con preview.

## 3) Flujo real de Bsale (observado)

En general, al escanear y enviar `Enter` en `#sale_q`:

1. Puede llamar a `find_code`:
   - `GET /pos_mobile/find_code?...`
2. Si no encuentra exacto, puede llamar a `find_attr`:
   - `GET /pos_mobile/find_attr?...`
3. Si agrega o actualiza cantidad:
   - `.../cart/update_cart/...`

Comportamientos importantes:

- A veces el segundo/tercer escaneo no pasa por `find_code`, solo por `cart/update_cart`.
- Cuando se supera stock, `cart/update_cart` puede responder:
  - `{"status":"fail","msg":"No posee stock disponible", ...}`
- Un codigo ambiguo (ej: varios resultados) suele pasar por `find_attr` con `search.length > 1`.

## 4) Reglas de decision actuales

### 4.1 Reglas principales

- Si llega `cart/update_cart`:
  - `status == "ok"` => `TRUE`
  - `status != "ok"` => `FALSE`
- Si llega `find_code` con `producto` o `plan` => `TRUE`
- Si llega `find_code` con `status == "cart-fail"` => `FALSE`
- Si llega `find_attr`:
  - `count > 1` => `FALSE`
  - `count == 1` y con stock (`stock_ilimitado == 1` o `stock_variante > 0`) => `TRUE`
  - `count == 1` sin stock => `FALSE`

### 4.2 Timeouts

- Cada intento abre un timeout de respaldo (actualmente 9s).
- Si no llega evidencia de red/flujo en ese tiempo, termina en `FALSE`.

## 5) Logs de consola clave

Prefijo: `[bsale-barras]`

Eventos tipicos:

- `{ stage: "bridge_injected" }`
- `{ stage: "attempt_start", query, pending }`
- `{ stage: "find_code", ... }`
- `{ stage: "find_attr", ... }`
- `{ stage: "cart_update", query, ok }`
- `{ success: true|false, query }`
- `{ stage: "storage_updated", volume }`

Si no ves logs en escaneo, sospechar:

- Extension no recargada.
- Script no inyectado.
- Sesion en login o pagina distinta.

## 6) Casos de prueba recomendados (regresion)

## 6.1 Basicos

- Exito claro (agrega):
  - Ejemplo historico: `4260248821409` => `TRUE`
- Fracaso por multiples resultados:
  - Ejemplo historico: `694349` => `FALSE`

## 6.2 Caso de stock limite

- Ejemplo historico: `6943498691074`
  - 1er escaneo: `TRUE`
  - 2do escaneo: `TRUE`
  - 3er escaneo (sin stock): `FALSE`

## 6.3 Prueba por pagina

Repetir en:

- `from_scratch`
- `documents/sales`
- `mobile/sales`

## 7) Si Bsale cambia: checklist de diagnostico

Cuando algo deje de funcionar, revisar en este orden:

1. **Inyeccion**
   - Confirmar atributo `data-bsale-barras-ext="loaded"` en `documentElement`.
   - Confirmar log `bridge_injected`.
2. **Input de escaneo**
   - Confirmar que existe `#sale_q`.
   - Confirmar que `Enter` dispara `attempt_start`.
3. **Red**
   - En Network/console, confirmar si siguen existiendo:
     - `/pos_mobile/find_code`
     - `/pos_mobile/find_attr`
     - `/cart/update_cart`
4. **Formato de respuesta**
   - Ver si cambiaron campos clave:
     - `status`
     - `producto`
     - `plan`
     - `search`
     - `stock_variante`, `stock_ilimitado`
5. **Nuevas rutas**
   - Si cambiaron endpoints, actualizar deteccion en `main.ts`.
6. **Cambio de funciones JS internas**
   - Si renombraron funciones o flujo, reforzar interceptacion en `page-bridge.js`.

## 8) Que modificar si falla cada tipo

- **No suena y no loggea**
  - Revisar inyeccion/manifest/matches.
- **Loggea `attempt_start` pero nunca decide**
  - Revisar interceptores de red (`page-bridge.js`) y endpoints nuevos.
- **Marca `FALSE` en exito**
  - Revisar prioridad de `cart/update_cart` y parseo de `status`.
- **Lag perceptible**
  - Revisar duraciones de tonos/patrones.
  - Evitar operaciones bloqueantes en el flujo de `resolveAttempt`.

## 9) Ubicaciones de codigo importantes

- `manifest.config.ts`
- `public/page-bridge.js`
- `src/content/main.ts`
- `src/options/options.ts`
- `src/options/options.html`
- `scripts/playwright-chrome-extension.mjs`
- `scripts/playwright-run-validation.mjs`

## 10) Notas de operacion para pruebas

- Compilar:
  - `npm run build`
- Ventana persistente para pruebas:
  - `npm run pw:chrome`
- Si hay sesion expirada:
  - Re-login en la ventana persistente antes de validar.
- Siempre confirmar:
  - Resultado funcional (`TRUE/FALSE` correcto)
  - Logs de consola (`[bsale-barras]`)
  - Comportamiento en las 3 paginas soportadas

---

Si Bsale cambia fuerte (endpoints, payloads o estructura), este documento sirve como mapa para detectar rapido donde ajustar y como validar regresion.

## 11) Auto-update CRX (GitHub + PEM)

### 11.1 Requisitos

- Tener la clave `.pem` privada de la extension (NO subirla al repo).
- Conocer el `extension_id` fijo de esa clave.
- En GitHub (repo settings -> Secrets and variables -> Actions), crear:
  - `CRX_PEM_BASE64`: contenido del `.pem` en base64.
  - `EXTENSION_ID`: id de la extension (32 letras).

### 11.2 Flujo automatizado

- Existe workflow: `.github/workflows/release-crx.yml`
- Se ejecuta al hacer push de tag `v*`.
- Acciones:
  1. Compila extension (`npm run build`).
  2. Genera CRX firmado con PEM.
  3. Genera `updates.xml` con el `extension_id`, version y URL del CRX.
  4. Sube el `.crx` y `updates.xml` al release del tag.
  5. Actualiza `updates.xml` en rama `master` (URL usada por `update_url`).

### 11.3 Instalacion inicial de CRX (primera vez)

1. Abrir `chrome://extensions`.
2. Activar **Developer mode**.
3. Arrastrar el archivo `.crx` al navegador y confirmar instalacion.
4. Verificar que la extension aparece con el mismo ID esperado.

> Nota: si Chrome bloquea instalacion directa por politicas, se puede usar politica de empresa o flujo administrado. Para pruebas locales suele bastar con Developer mode.

### 11.4 Publicar una nueva version con auto-update

1. Subir version en `manifest.config.ts` y `package.json` (ej. `0.2.15`).
2. Commit + push a `master`.
3. Crear tag y push:
   - `git tag -a v0.2.15 -m "Release v0.2.15"`
   - `git push origin v0.2.15`
4. Esperar workflow `Release CRX`.
5. Chrome detectara el nuevo `updates.xml` y actualizara la extension instalada por CRX.
