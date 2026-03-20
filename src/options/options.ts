type PageKey = 'from_scratch' | 'documents_sales' | 'mobile_sales'
type TonePreset =
  | 'classic'
  | 'bell'
  | 'digital'
  | 'arcade'
  | 'low_impact'
  | 'minimal'
  | 'error_siren'
  | 'error_triple'
  | 'error_buzzer'
  | 'error_horn'

type Settings = {
  enabled: boolean
  pages: Record<PageKey, boolean>
  volume: number // 0..1
  toneTruePreset: TonePreset
  toneFalsePreset: TonePreset
}

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  pages: {
    from_scratch: true,
    documents_sales: true,
    mobile_sales: true,
  },
  volume: 0.6,
  toneTruePreset: 'classic',
  toneFalsePreset: 'classic',
}

const elFrom = document.getElementById('from_scratch') as HTMLInputElement | null
const elDocsSales = document.getElementById('documents_sales') as HTMLInputElement | null
const elMobile = document.getElementById('mobile_sales') as HTMLInputElement | null
const elVolume = document.getElementById('volume') as HTMLInputElement | null
const elVolumeLabel = document.getElementById('volume_label') as HTMLSpanElement | null
const elToneTruePreset = document.getElementById('tone_true_preset') as HTMLSelectElement | null
const elToneFalsePreset = document.getElementById('tone_false_preset') as HTMLSelectElement | null

if (!elFrom || !elDocsSales || !elMobile || !elVolume || !elVolumeLabel || !elToneTruePreset || !elToneFalsePreset) {
  // Si el HTML no coincide con el TS, preferimos fallar de forma visible.
  throw new Error('Faltan elementos en options.html')
}

let settings: Settings = DEFAULT_SETTINGS

function render(): void {
  elFrom.checked = settings.pages.from_scratch
  elDocsSales.checked = settings.pages.documents_sales
  elMobile.checked = settings.pages.mobile_sales
  elVolume.value = String(Math.round(settings.volume * 100))
  elVolumeLabel.textContent = String(Math.round(settings.volume * 100))
  elToneTruePreset.value = settings.toneTruePreset
  elToneFalsePreset.value = settings.toneFalsePreset
}

function persist(): void {
  chrome.storage.local.set({
    bsale_barras_settings: settings,
  })
}

function bind(): void {
  elFrom.addEventListener('change', () => {
    settings = {
      ...settings,
      pages: {
        ...settings.pages,
        from_scratch: elFrom.checked,
      },
    }
    render()
    persist()
  })

  elMobile.addEventListener('change', () => {
    settings = {
      ...settings,
      pages: {
        ...settings.pages,
        mobile_sales: elMobile.checked,
      },
    }
    render()
    persist()
  })

  elDocsSales.addEventListener('change', () => {
    settings = {
      ...settings,
      pages: {
        ...settings.pages,
        documents_sales: elDocsSales.checked,
      },
    }
    render()
    persist()
  })

  elVolume.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Number(elVolume.value)))
    settings = {
      ...settings,
      volume: v / 100,
    }
    render()
    persist()
  })

  elToneTruePreset.addEventListener('change', () => {
    settings = { ...settings, toneTruePreset: elToneTruePreset.value as TonePreset }
    render()
    persist()
    void previewTone(true)
  })

  elToneFalsePreset.addEventListener('change', () => {
    settings = { ...settings, toneFalsePreset: elToneFalsePreset.value as TonePreset }
    render()
    persist()
    void previewTone(false)
  })
}

async function init(): Promise<void> {
  const res = await chrome.storage.local.get('bsale_barras_settings')
  if (res?.bsale_barras_settings) {
    const storedAny = res.bsale_barras_settings as unknown as { tonePreset?: TonePreset }
    settings = {
      ...DEFAULT_SETTINGS,
      ...res.bsale_barras_settings,
      pages: { ...DEFAULT_SETTINGS.pages, ...(res.bsale_barras_settings.pages ?? {}) },
    }
    // Compatibilidad: versiones anteriores guardaban `tonePreset` único.
    if (storedAny.tonePreset) {
      settings = { ...settings, toneTruePreset: storedAny.tonePreset, toneFalsePreset: storedAny.tonePreset }
    }
  }
  render()
  bind()
}

void init()

// --- Preview local (solo en la página de opciones) ---
let previewAudioCtx: AudioContext | null = null
let previewMasterGain: GainNode | null = null

function ensurePreviewAudio(): void {
  if (previewAudioCtx && previewMasterGain) return
  previewAudioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  previewMasterGain = previewAudioCtx.createGain()
  previewMasterGain.gain.value = settings.volume
  previewMasterGain.connect(previewAudioCtx.destination)
}

function previewPlayBeep(frequency: number, start: number, duration: number, type: OscillatorType): void {
  if (!previewAudioCtx || !previewMasterGain) return
  const osc = previewAudioCtx.createOscillator()
  const env = previewAudioCtx.createGain()
  osc.type = type
  osc.frequency.value = frequency
  env.gain.value = 0.0001
  osc.connect(env)
  env.connect(previewMasterGain)
  const peak = Math.max(0.02, Math.min(1, settings.volume))
  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(peak, start + 0.01)
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.start(start)
  osc.stop(start + duration + 0.01)
}

async function previewTone(success: boolean): Promise<void> {
  ensurePreviewAudio()
  if (!previewAudioCtx) return
  if (previewAudioCtx.state === 'suspended') {
    try {
      await previewAudioCtx.resume()
    } catch {
      // ignorar
    }
  }

  if (previewMasterGain) previewMasterGain.gain.value = settings.volume

  const now = previewAudioCtx.currentTime
  const preset = success ? settings.toneTruePreset : settings.toneFalsePreset

  if (preset === 'classic') {
    if (success) previewPlayBeep(1180, now, 0.11, 'triangle')
    else {
      previewPlayBeep(260, now, 0.12, 'square')
      previewPlayBeep(180, now + 0.14, 0.14, 'square')
    }
    return
  }

  if (preset === 'bell') {
    if (success) {
      previewPlayBeep(980, now, 0.09, 'sine')
      previewPlayBeep(1310, now + 0.1, 0.12, 'sine')
    } else {
      previewPlayBeep(320, now, 0.18, 'triangle')
      previewPlayBeep(250, now + 0.2, 0.16, 'triangle')
    }
    return
  }

  if (preset === 'digital') {
    if (success) {
      previewPlayBeep(1400, now, 0.07, 'square')
      previewPlayBeep(1700, now + 0.08, 0.06, 'square')
    } else {
      previewPlayBeep(210, now, 0.1, 'square')
      previewPlayBeep(210, now + 0.13, 0.1, 'square')
    }
    return
  }

  if (preset === 'arcade') {
    if (success) {
      previewPlayBeep(740, now, 0.07, 'triangle')
      previewPlayBeep(988, now + 0.08, 0.07, 'triangle')
      previewPlayBeep(1318, now + 0.16, 0.08, 'triangle')
    } else {
      previewPlayBeep(410, now, 0.09, 'sawtooth')
      previewPlayBeep(300, now + 0.1, 0.1, 'sawtooth')
      previewPlayBeep(210, now + 0.21, 0.11, 'sawtooth')
    }
    return
  }

  if (preset === 'low_impact') {
    if (success) previewPlayBeep(880, now, 0.09, 'triangle')
    else {
      previewPlayBeep(170, now, 0.16, 'square')
      previewPlayBeep(140, now + 0.18, 0.18, 'square')
    }
    return
  }

  if (preset === 'error_siren') {
    if (success) {
      previewPlayBeep(1180, now, 0.09, 'triangle')
      return
    }
    previewPlayBeep(820, now, 0.06, 'triangle')
    previewPlayBeep(650, now + 0.06, 0.06, 'triangle')
    previewPlayBeep(520, now + 0.12, 0.08, 'triangle')
    previewPlayBeep(680, now + 0.20, 0.06, 'triangle')
    return
  }

  if (preset === 'error_triple') {
    if (success) {
      previewPlayBeep(1180, now, 0.09, 'triangle')
      return
    }
    previewPlayBeep(240, now, 0.08, 'square')
    previewPlayBeep(210, now + 0.10, 0.08, 'square')
    previewPlayBeep(180, now + 0.20, 0.09, 'square')
    return
  }

  if (preset === 'error_buzzer') {
    if (success) {
      previewPlayBeep(1180, now, 0.09, 'triangle')
      return
    }
    // "buzzer" pulsado.
    previewPlayBeep(140, now, 0.05, 'square')
    previewPlayBeep(120, now + 0.06, 0.05, 'square')
    previewPlayBeep(160, now + 0.12, 0.05, 'square')
    previewPlayBeep(130, now + 0.18, 0.06, 'square')
    return
  }

  if (preset === 'error_horn') {
    if (success) {
      previewPlayBeep(1180, now, 0.09, 'triangle')
      return
    }
    previewPlayBeep(320, now, 0.10, 'triangle')
    previewPlayBeep(390, now + 0.08, 0.09, 'triangle')
    previewPlayBeep(260, now + 0.16, 0.10, 'triangle')
    return
  }

  // minimal
  if (success) previewPlayBeep(1200, now, 0.06, 'sine')
  else previewPlayBeep(240, now, 0.09, 'square')

}

