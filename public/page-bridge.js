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
    } catch {}
  }

  tryWrap()
  const iv = setInterval(() => {
    tryWrap()
  }, 250)
  setTimeout(() => clearInterval(iv), 30000)
})()
