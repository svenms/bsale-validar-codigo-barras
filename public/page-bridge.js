(() => {
  if (window.__bsaleBarrasBridgeInstalled) return
  window.__bsaleBarrasBridgeInstalled = true

  const emit = (detail) => window.dispatchEvent(new CustomEvent('bsale-barras-event', { detail }))

  const tryWrap = () => {
    try {
      if (!window.__bsaleXhrWrapped) {
        const origOpen = XMLHttpRequest.prototype.open
        const origSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this.__bsaleUrl = typeof url === 'string' ? url : String(url ?? '')
          return origOpen.call(this, method, url, ...rest)
        }
        XMLHttpRequest.prototype.send = function (body) {
          this.addEventListener('loadend', () => {
            try {
              emit({
                kind: 'ajax',
                url: this.__bsaleUrl || this.responseURL || '',
                body: typeof this.responseText === 'string' ? this.responseText : '',
              })
            } catch {}
          })
          return origSend.call(this, body)
        }
        window.__bsaleXhrWrapped = true
      }

      if (!window.__bsaleFetchWrapped && typeof window.fetch === 'function') {
        const origFetch = window.fetch
        window.fetch = async function (...args) {
          const res = await origFetch.apply(this, args)
          try {
            const first = args[0]
            const url = typeof first === 'string' ? first : first?.url || ''
            const body = await res.clone().text()
            emit({ kind: 'ajax', url, body })
          } catch {}
          return res
        }
        window.__bsaleFetchWrapped = true
      }

      if (window.jQuery && window.jQuery.ajax && !window.jQuery.ajax.__bsaleWrapped) {
        const orig = window.jQuery.ajax
        const wrapped = function (...args) {
          const first = args[0]
          const settings = (typeof first === 'string' ? args[1] : first) || {}
          const url = typeof first === 'string' ? first : (first && first.url) || ''
          const prev = settings.complete
          settings.complete = function (res) {
            try {
              emit({
                kind: 'ajax',
                url,
                body: typeof res?.responseText === 'string' ? res.responseText : '',
              })
            } catch {}
            if (typeof prev === 'function') return prev.apply(this, arguments)
          }
          if (typeof first === 'string') args[1] = settings
          else args[0] = settings
          return orig.apply(this, args)
        }
        wrapped.__bsaleWrapped = true
        window.jQuery.ajax = wrapped
      }
      if (typeof window.addToCart === 'function' && !window.addToCart.__bsaleWrapped) {
        const origAdd = window.addToCart
        const wrappedAdd = function (...args) {
          try {
            emit({ kind: 'addToCart' })
          } catch {}
          return origAdd.apply(this, args)
        }
        wrappedAdd.__bsaleWrapped = true
        window.addToCart = wrappedAdd
      }

      /**
       * Respuesta AJAX de validación de serie (no confundir con el GET que solo lista series existentes).
       */
      function serialAjaxLooksLikeReject(responseText) {
        const s = String(responseText ?? '').trim()
        if (!s) return false
        let j
        try {
          j = JSON.parse(s)
        } catch {
          return /fail|error|inválid|invalid|no válid/i.test(s)
        }
        if (j == null || typeof j !== 'object') return false
        if (j.status === 'ok' || j.success === true || j.valid === true) return false
        if (j.status === 'fail' || j.status === 'error' || j.success === false || j.valid === false) return true
        if (j.status === 0 || j.status === '0') return true
        if (typeof j.msg === 'string' && j.msg.trim().length > 0) {
          const m = j.msg.toLowerCase()
          if (
            /no válid|novalid|inválid|invalid|error|fail|duplic|encontr|no se|incorrect|ya fue|utilizada|repetid|limite|no pudo|no coincide/i.test(
              m,
            )
          )
            return true
        }
        if (typeof j.error === 'string' && j.error.trim().length > 0) return true
        // Solo listado de inventario { data: [{ cod_serie }] } sin señal de error
        if (Array.isArray(j.data) && !j.msg && j.status !== 'fail' && j.status !== 'error' && j.success !== false) {
          const keys = Object.keys(j)
          if (keys.length === 1 || (keys.length === 2 && keys.includes('data'))) return false
        }
        return false
      }

      // Serie / IMEI en POS: errores vía msgPopUp; éxito cuando add_note pasa a .edited tras AJAX get_serial_number.
      if (window.msgPopUp && !window.msgPopUp.__bsaleSerieBodyWrapped) {
        const origMsg = window.msgPopUp
        window.msgPopUp = function (opts) {
          try {
            const combined = [
              opts?.title,
              opts?.bodyContent,
              opts?.body,
              opts?.html,
              opts?.message,
              typeof opts?.content === 'string' ? opts.content : '',
            ]
              .map(function (x) {
                return String(x ?? '')
              })
              .join('\n')
            if (
              /no es valida|no es válida|ya fue utilizada|limite sin serie|no se encuentra|no encontrado|inválid|invalid|duplicad|repetid|no válid|no válido|error al registrar|no pudo agregar|no coincide|incorrecto|verifique|debe ingresar|serie incorrecta|número incorrecto|numero incorrecto/i.test(
                combined,
              )
            ) {
              emit({ kind: 'serial_validation', ok: false })
            }
          } catch {}
          return origMsg.apply(this, arguments)
        }
        window.msgPopUp.__bsaleSerieBodyWrapped = true
      }

      if (
        window.jQuery &&
        typeof window.validateSerialNumer === 'function' &&
        !window.validateSerialNumer.__bsaleSerieWrapped
      ) {
        const origValidate = window.validateSerialNumer
        window.validateSerialNumer = function (element) {
          const $ = window.jQuery
          const origAjax = $.ajax
          $.ajax = function () {
            try {
              const args = Array.prototype.slice.call(arguments)
              let settings = {}
              let url = ''
              if (typeof args[0] === 'string') {
                url = args[0] || ''
                settings = args[1] || {}
              } else {
                settings = args[0] || {}
                url = settings.url || ''
              }
              const urlStr = typeof url === 'string' ? url : String(url || '')
              if (urlStr.includes('/pos_mobile/get_serial_number')) {
                const prevComplete = settings.complete
                settings.complete = function (jqXHR /*, textStatus */) {
                  let ret
                  try {
                    const addNote = $(element).parent().find('#add_note')
                    const hadEdited = addNote.hasClass('edited')
                    const rt = jqXHR && typeof jqXHR.responseText === 'string' ? jqXHR.responseText : ''
                    if (typeof prevComplete === 'function') ret = prevComplete.apply(this, arguments)
                    const hasEdited = addNote.hasClass('edited')
                    if (!hadEdited && hasEdited) emit({ kind: 'serial_validation', ok: true })
                    else if (!hasEdited && rt && serialAjaxLooksLikeReject(rt))
                      emit({ kind: 'serial_validation', ok: false })
                  } catch {}
                  return ret
                }
                if (typeof args[0] === 'string') args[1] = settings
                else args[0] = settings
              }
              return origAjax.apply(this, args)
            } catch {
              return origAjax.apply(this, arguments)
            }
          }
          try {
            return origValidate.apply(this, arguments)
          } finally {
            $.ajax = origAjax
          }
        }
        window.validateSerialNumer.__bsaleSerieWrapped = true
      }
    } catch {}
  }

  tryWrap()
  const iv = setInterval(() => {
    tryWrap()
  }, 250)
  setTimeout(() => clearInterval(iv), 30000)
})()
