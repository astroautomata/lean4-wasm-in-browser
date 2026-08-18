// Final-feedback form for the completion page. The Lean4Game client owns the
// in-level "!" reports; this page is plain static HTML outside that bundle, so
// it re-implements the same POST against the same collector. Reports land in
// `feedback_reports` under a reserved world so they can be read back on their
// own: world_id "Ending", level_id 0.

const CONSENT_KEY = 'telemetryConsent'
const USER_COOKIE = 'lean_game_anonymous_id'
const MAX_MESSAGE = 1000

const FEEDBACK_ORIGIN = {
  game_id: 'g/local/NNG4',
  world_id: 'Ending',
  level_id: 0,
  mode: 'visual',
} as const

function telemetryBaseUrl(): string {
  const runtime = String(
    (window as Window & { __LEAN_TELEMETRY_URL__?: string }).__LEAN_TELEMETRY_URL__ ?? '',
  ).trim()
  if (runtime) {
    try { sessionStorage.setItem('leanTelemetryRuntimeUrl', runtime) } catch { /* private mode */ }
  }
  let persisted = ''
  try { persisted = sessionStorage.getItem('leanTelemetryRuntimeUrl') ?? '' } catch { /* private mode */ }
  const configured = runtime || persisted || String(import.meta.env.VITE_TELEMETRY_URL ?? '').trim()
  return configured ? configured.replace(/\/$/u, '') : ''
}

function readCookie(name: string): string {
  try {
    const prefix = `${encodeURIComponent(name)}=`
    for (const entry of document.cookie.split(';')) {
      const trimmed = entry.trim()
      if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length))
    }
  } catch { /* cookies unavailable */ }
  return ''
}

/** Only identify the report when the player accepted telemetry in the game. */
function consentedUserId(): string | null {
  try {
    if (localStorage.getItem(CONSENT_KEY) !== 'accepted') return null
  } catch {
    return null
  }
  return readCookie(USER_COOKIE) || null
}

function createReportId(): string {
  try {
    if (crypto.randomUUID) return crypto.randomUUID()
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return '00000000-0000-4000-8000-000000000000'
  }
}

async function submitFinalFeedback(message: string): Promise<boolean> {
  const baseUrl = telemetryBaseUrl()
  const trimmed = message.trim()
  if (!baseUrl || !trimmed || trimmed.length > MAX_MESSAGE) return false
  const userId = consentedUserId()
  const response = await fetch(`${baseUrl}/v1/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      report_id: createReportId(),
      ...(userId ? { user_uuid: userId } : {}),
      ...FEEDBACK_ORIGIN,
      message: trimmed,
      // The collector requires an object here; the completion page has no
      // proof to attach, so record where the report came from instead.
      proof_state: { source: 'congratulations-page' },
      ts: new Date().toISOString(),
    }),
  })
  return response.ok
}

function mount(): void {
  const form = document.querySelector<HTMLFormElement>('#final-feedback-form')
  const textarea = document.querySelector<HTMLTextAreaElement>('#final-feedback-message')
  const counter = document.querySelector<HTMLElement>('#final-feedback-count')
  const submit = document.querySelector<HTMLButtonElement>('#final-feedback-submit')
  const status = document.querySelector<HTMLParagraphElement>('#final-feedback-status')
  if (!form || !textarea || !counter || !submit || !status) return

  let submitting = false

  function setStatus(kind: 'idle' | 'sent' | 'error'): void {
    if (kind === 'idle') {
      status!.hidden = true
      status!.className = 'final-feedback-status'
      status!.textContent = ''
      return
    }
    status!.hidden = false
    status!.className = `final-feedback-status ${kind === 'sent' ? 'success' : 'error'}`
    status!.setAttribute('role', kind === 'sent' ? 'status' : 'alert')
    status!.textContent = kind === 'sent'
      ? 'Feedback sent. Thank you!'
      : 'Feedback could not be sent. Please try again.'
  }

  function sync(): void {
    const length = textarea!.value.length
    counter!.textContent = `${length}/${MAX_MESSAGE}`
    counter!.classList.toggle('invalid', length > MAX_MESSAGE)
    submit!.disabled = submitting || !textarea!.value.trim() || length > MAX_MESSAGE
  }

  textarea.addEventListener('input', () => { setStatus('idle'); sync() })

  form.addEventListener('submit', event => {
    event.preventDefault()
    if (submitting || submit.disabled) return
    submitting = true
    submit.textContent = 'Sending…'
    textarea.disabled = true
    sync()
    setStatus('idle')
    void submitFinalFeedback(textarea.value)
      .then(sent => {
        setStatus(sent ? 'sent' : 'error')
        if (sent) textarea.value = ''
      })
      .catch(() => setStatus('error'))
      .finally(() => {
        submitting = false
        submit.textContent = 'Submit feedback'
        textarea.disabled = false
        sync()
      })
  })

  sync()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
