import { useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, Ban, Check, CheckCircle2,
  ChevronRight, CircleHelp, Clock3, Copy, Cpu, ExternalLink, FileCheck2,
  FileText, Globe2, Heart, Info, Link2, Loader2, LockKeyhole, MapPin,
  MessageSquareText, PauseCircle, Play, ReceiptText, RefreshCcw, Send,
  ShieldCheck, ShieldX, SlidersHorizontal, Sparkles, StopCircle, UtensilsCrossed,
  Wallet, X,
} from 'lucide-react'
import { getCatalog, getStatus, planWithAgent, recommendWithAgent } from './api'
import { explorerTxUrl, httpChainAdapter } from './chainAdapter'
import { examplePrompt, fallbackCatalog, itemImages } from './fixtures'
import { formatAmount, fromSun, previewDecision, toSun, type PolicyDraft } from './policy'
import type {
  AttemptView, AuditView, CatalogResponse, InferenceMeta, Merchant, PlanResponse,
  Quote, SessionView, StatusResponse, UsageRecord,
} from './types'

type View = 'run' | 'activity' | 'audit' | 'usage'
type MobilePane = 'menu' | 'agent' | 'policy'
type ChatTurn = { id: string; role: 'user' | 'agent'; text: string; source?: 'kiln' | 'demo_fallback' }

const chain = httpChainAdapter
const sessionStorageKey = 'intentbound-session-id'
const initialStatus: StatusResponse = {
  kiln: { configured: false, connected: null, model: 'qwen3-32b' },
  chain: { network: 'shasta', connected: null, configured: false, asset: 'test TRX' },
  merchantMode: 'fixture',
}

function pathToView(pathname: string): View {
  if (pathname.startsWith('/audit')) return 'audit'
  if (pathname.startsWith('/activity')) return 'activity'
  if (pathname.startsWith('/usage')) return 'usage'
  return 'run'
}

function shortHash(value: string | null, start = 8, end = 7): string {
  if (!value) return 'Not available'
  return value.length > start + end + 3 ? `${value.slice(0, start)}...${value.slice(-end)}` : value
}

function readableTime(value: string | null): string {
  if (!value) return 'Set on approval'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul', hour12: false }).format(date) + ' KST'
}

function codeLabel(code: string): string {
  const labels: Record<string, string> = {
    ELIGIBLE: 'Quote eligible',
    OVER_LIMIT: 'Full price over budget',
    MERCHANT_NOT_ALLOWED: 'Payee not approved',
    REVOKED: 'Permission stopped',
    EXPIRED: 'Permission expired',
    QUOTE_MISMATCH: 'Quote does not add up',
    MISSING_PAYEE: 'Payee address missing',
    PAYMENT_EXECUTED: 'Payment confirmed',
    INSUFFICIENT_ESCROW: 'Insufficient session balance',
  }
  return labels[code] ?? code.replaceAll('_', ' ').toLowerCase()
}

function merchantFor(catalog: CatalogResponse, quote: Quote): Merchant | undefined {
  return catalog.merchants.find((merchant) => merchant.id === quote.merchantId)
}

function itemFor(catalog: CatalogResponse, quote: Quote) {
  return merchantFor(catalog, quote)?.items.find((item) => item.id === quote.itemId)
}

function evidenceKind(attempt: AttemptView): string {
  if (attempt.status === 'pending') return attempt.txHash ? 'Testnet transaction pending' : 'Decision pending'
  if (!attempt.txHash) return 'Application decision only'
  return attempt.status === 'allowed' ? 'Testnet transaction' : 'Testnet rejection event'
}

function App() {
  const [view, setView] = useState<View>(() => pathToView(window.location.pathname))
  const [mobilePane, setMobilePane] = useState<MobilePane>('menu')
  const [catalog, setCatalog] = useState<CatalogResponse>(fallbackCatalog)
  const [catalogOrigin, setCatalogOrigin] = useState<'api' | 'bundled'>('bundled')
  const [status, setStatus] = useState<StatusResponse>(initialStatus)
  const [apiWarning, setApiWarning] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedQuoteId, setSelectedQuoteId] = useState('A')
  const [session, setSession] = useState<SessionView | null>(null)
  const [localPause, setLocalPause] = useState(false)
  const [attempts, setAttempts] = useState<AttemptView[]>([])
  const [working, setWorking] = useState<'approve' | 'attempt' | 'revoke' | 'plan' | 'recommend' | 'audit' | 'usage' | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [budget, setBudget] = useState(18)
  const [perPaymentCap, setPerPaymentCap] = useState(18)
  const [validMinutes, setValidMinutes] = useState(10)
  const [allowedMerchantIds, setAllowedMerchantIds] = useState<string[]>(['seoul-bowl', 'han-table'])
  const [composer, setComposer] = useState(examplePrompt)
  const [chat, setChat] = useState<ChatTurn[]>([])
  const [demoFallback, setDemoFallback] = useState(false)
  const [plan, setPlan] = useState<PlanResponse | null>(null)
  const [recommendation, setRecommendation] = useState<{ itemId: string; reason: string; source: string } | null>(null)
  const [browserUsage, setBrowserUsage] = useState<UsageRecord[]>([])
  const [usage, setUsage] = useState<UsageRecord[]>([])
  const [usageError, setUsageError] = useState<string | null>(null)
  const [auditInput, setAuditInput] = useState(() => new URLSearchParams(window.location.search).get('session') ?? '')
  const [audit, setAudit] = useState<AuditView | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)

  const selectedQuote = catalog.quotes.find((quote) => quote.id === selectedQuoteId) ?? catalog.quotes[0]
  const selectedMerchant = selectedQuote ? merchantFor(catalog, selectedQuote) : undefined
  const selectedItem = selectedQuote ? itemFor(catalog, selectedQuote) : undefined
  const policy: PolicyDraft = {
    budget: session?.budgetSun ? fromSun(session.budgetSun) : budget,
    perPaymentCap: session?.perPaymentCapSun ? fromSun(session.perPaymentCapSun) : perPaymentCap,
    allowedMerchantIds: session?.allowedMerchantIds.length ? session.allowedMerchantIds : allowedMerchantIds,
    expiresAt: session?.expiresAt ?? null,
  }
  const preview = selectedQuote ? previewDecision(selectedQuote, selectedMerchant, policy, session?.state ?? 'none', session ? fromSun(session.spentSun) : 0) : null
  const remaining = session ? Math.max(0, fromSun(session.budgetSun - session.spentSun)) : budget
  const allAttempts = useMemo(() => {
    const deduped = new Map<string, AttemptView>()
    for (const attempt of [...(session?.attempts ?? []), ...attempts]) {
      deduped.set(attempt.id || `${attempt.quoteId}-${attempt.timestamp ?? ''}`, attempt)
    }
    return [...deduped.values()].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  }, [session?.attempts, attempts])
  const paidAttempt = [...allAttempts].reverse().find((attempt) => attempt.status === 'allowed' && !!attempt.txHash)
  const catalogQuotes = ['A', 'B', 'C'].map((id) => catalog.quotes.find((quote) => quote.id === id)).filter((quote): quote is Quote => !!quote)
  const latestAttempt = [...allAttempts].reverse().find((attempt) => attempt.quoteId === selectedQuoteId)
  const decisionState = latestAttempt?.status === 'allowed' ? 'pass' : latestAttempt?.status === 'rejected' ? 'fail' : latestAttempt?.status === 'pending' ? 'pending' : preview?.allowed ? 'pass' : 'fail'
  const decisionText = latestAttempt ? latestAttempt.status === 'allowed' ? 'Payment confirmed' : latestAttempt.status === 'pending' ? 'Decision pending' : codeLabel(latestAttempt.code) : preview ? codeLabel(preview.code) : 'No quote'
  const displayNetwork = (status.chain.network || 'shasta').replace(/^./, (first) => first.toUpperCase())
  const confirmedTxRecorded = !!((session?.state !== 'pending' && session?.approvalTxHash) || (session?.state === 'revoked' && session.revokeTxHash) || allAttempts.some((attempt) => attempt.txHash && (attempt.status === 'allowed' || attempt.status === 'rejected')))
  const chainStatusLabel = confirmedTxRecorded ? 'confirmed tx recorded' : status.chain.connected === true ? 'RPC connected' : status.chain.configured ? 'contract configured' : 'not connected'

  useEffect(() => {
    let mounted = true
    Promise.allSettled([getStatus(), getCatalog()]).then(([statusResult, catalogResult]) => {
      if (!mounted) return
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
      if (catalogResult.status === 'fulfilled') {
        setCatalog(catalogResult.value)
        setCatalogOrigin('api')
      } else {
        setApiWarning('The server catalog is offline. Bundled restaurant fixtures are shown for layout preview only.')
      }
    })

    const existing = window.localStorage.getItem(sessionStorageKey)
    if (existing) chain.getSession(existing).then((record) => {
      if (mounted) setSession(record)
    }).catch(() => {
      if (mounted) setApiWarning('A saved session could not be refreshed. No live chain state is being claimed.')
    })

    const onPopState = () => setView(pathToView(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => {
      mounted = false
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  useEffect(() => {
    if (view === 'usage') void loadUsage()
  }, [view])

  function navigate(next: View) {
    const path = next === 'run' ? '/' : `/${next}`
    const suffix = next === 'audit' && session ? `?session=${encodeURIComponent(session.id)}` : ''
    window.history.pushState({}, '', path + suffix)
    setView(next)
    setActionError(null)
    if (next === 'audit' && session) setAuditInput(session.id)
  }

  function addUsage(purpose: string, inference: InferenceMeta) {
    if (inference.source !== 'kiln') return
    setBrowserUsage((current) => [...current, {
      id: inference.generationId ?? `browser-${Date.now()}`,
      purpose,
      inference,
      createdAt: new Date().toISOString(),
    }])
  }

  async function refreshStatus() {
    try {
      setStatus(await getStatus())
      setApiWarning(null)
      if (session) setSession(await chain.getSession(session.id))
    } catch (error) {
      setApiWarning(error instanceof Error ? error.message : 'Could not refresh live status.')
    }
  }

  async function handlePlan() {
    const message = composer.trim()
    if (!message || working) return
    setActionError(null)
    setWorking('plan')
    setChat((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: message }])
    setComposer('')
    try {
      const result = await planWithAgent(message, demoFallback)
      setPlan(result)
      setChat((current) => [...current, {
        id: `agent-${Date.now()}`,
        role: 'agent',
        text: result.assistantMessage,
        source: result.inference.source,
      }])
      if (result.draftPolicy.budget != null) setBudget(result.draftPolicy.budget)
      if (result.draftPolicy.perPaymentCap != null) setPerPaymentCap(result.draftPolicy.perPaymentCap)
      if (result.draftPolicy.allowedMerchantIds.length) setAllowedMerchantIds(result.draftPolicy.allowedMerchantIds)
      addUsage('Intent parsing', result.inference)
      void getStatus().then(setStatus).catch(() => undefined)
      setNotice(result.inference.source === 'kiln' ? 'Kiln parsed the brief. Permission still needs your confirmation.' : 'Scripted fallback parsed the brief. This was not a Kiln call.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The agent could not parse the request.')
      setComposer(message)
    } finally {
      setWorking(null)
    }
  }

  async function handleRecommend() {
    if (working) return
    setActionError(null)
    setWorking('recommend')
    try {
      const result = await recommendWithAgent(plan?.draftPolicy.preferences ?? { warm: true, avoidIngredients: ['cilantro'], notes: [] }, { budget, allowedMerchantIds }, demoFallback)
      const match = catalog.quotes.find((quote) => quote.itemId === result.itemId && quote.merchantId === result.merchantId)
      if (!match) throw new Error('The model returned an item outside the verified demo catalog. No quote was selected.')
      setSelectedQuoteId(match.id)
      setRecommendation({ itemId: result.itemId, reason: result.reason, source: result.inference.source })
      setChat((current) => [...current, {
        id: `recommend-${Date.now()}`,
        role: 'agent',
        text: result.reason,
        source: result.inference.source,
      }])
      addUsage('Menu comparison', result.inference)
      void getStatus().then(setStatus).catch(() => undefined)
      setNotice(result.inference.source === 'kiln' ? 'Kiln suggested an item from the verified catalog.' : 'Scripted fallback suggested an item; no Kiln usage was recorded.')
      setMobilePane('menu')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Recommendation failed.')
    } finally {
      setWorking(null)
    }
  }

  async function handleCreateSession() {
    if (working || !confirmed) return
    if (!(budget > 0 && perPaymentCap > 0 && perPaymentCap <= budget && validMinutes > 0 && allowedMerchantIds.length > 0)) {
      setActionError('Enter a valid budget, per-payment cap, duration and at least one approved merchant.')
      return
    }
    setActionError(null)
    setWorking('approve')
    try {
      const record = await chain.createSession({
        budgetSun: toSun(budget),
        perPaymentCapSun: toSun(perPaymentCap),
        allowedMerchantIds,
        expiresAt: new Date(Date.now() + validMinutes * 60_000).toISOString(),
      })
      setSession(record)
      setLocalPause(false)
      window.localStorage.setItem(sessionStorageKey, record.id)
      setShowReview(false)
      setNotice(record.state === 'active' ? 'The funded permission is active. Chain evidence is shown below.' : 'Permission submitted. Waiting for chain confirmation.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create a permission.')
    } finally {
      setWorking(null)
    }
  }

  async function handleAttempt() {
    if (!selectedQuote || working) return
    if (!session) {
      setShowReview(true)
      return
    }
    const revokeTest = selectedQuote.id === 'D' && session.state === 'revoked'
    if (session.state === 'revoking' || session.state === 'pending') return
    if ((localPause || session.state === 'revoked') && !revokeTest) return
    if (selectedQuote.id === 'D' && (!revokeTest || allAttempts.some((attempt) => attempt.quoteId === 'D'))) return
    setActionError(null)
    setWorking('attempt')
    try {
      const result = await chain.attempt(session.id, selectedQuote.id)
      setAttempts((current) => [...current, result.attempt])
      if (result.session) setSession(result.session)
      else setSession(await chain.getSession(session.id))
      if (result.attempt.status === 'allowed') {
        setNotice(result.attempt.txHash ? 'Testnet payment confirmed. Open the receipt for the chain evidence.' : 'Payment is pending. No chain receipt is available yet.')
      } else if (result.attempt.status === 'rejected') {
        setNotice(`Attempt ${selectedQuote.id} was blocked: ${codeLabel(result.attempt.code)}.`)
      } else {
        setNotice('The attempt was submitted. Waiting for a confirmed decision.')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The attempt could not be submitted.')
    } finally {
      setWorking(null)
    }
  }

  async function handleRevoke() {
    if (!session || working) return
    setShowStopConfirm(false)
    setLocalPause(true)
    setActionError(null)
    setWorking('revoke')
    try {
      const record = await chain.revoke(session.id)
      setSession(record)
      setNotice(record.state === 'revoked' ? 'The stop is confirmed on Shasta. No new payment can leave this session.' : 'Stop submitted. Local attempts are paused while the chain confirms.')
    } catch (error) {
      setActionError(`${error instanceof Error ? error.message : 'Stop failed.'} Local attempts remain paused; chain revocation is not confirmed. Retry Stop.`)
    } finally {
      setWorking(null)
    }
  }

  async function loadUsage() {
    setUsageError(null)
    setWorking('usage')
    try {
      setUsage(await chain.usage())
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : 'Usage records are not available.')
    } finally {
      setWorking(null)
    }
  }

  async function handleAudit() {
    const id = auditInput.trim()
    if (!id || working) return
    setAudit(null)
    setAuditError(null)
    setWorking('audit')
    try {
      setAudit(await chain.audit(id))
      window.history.replaceState({}, '', `/audit?session=${encodeURIComponent(id)}`)
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : 'Independent verification failed.')
    } finally {
      setWorking(null)
    }
  }

  function previewFixtureRules() {
    const expected: Record<string, string> = { A: 'OVER_LIMIT', B: 'MERCHANT_NOT_ALLOWED', C: 'ELIGIBLE' }
    const checks: AuditView['checks'] = ['A', 'B', 'C'].map((id) => {
      const quote = catalog.quotes.find((entry) => entry.id === id)
      if (!quote) return { label: `Case ${id} · fixture quote`, passed: false, detail: 'Quote missing from the demo catalog.' }
      const result = previewDecision(quote, merchantFor(catalog, quote), { ...policy, expiresAt: null }, 'none')
      return {
        label: `Case ${id} · ${codeLabel(expected[id])}`,
        passed: result.code === expected[id],
        detail: `${formatAmount(result.calculatedTotal)} ${catalog.currency} · ${result.code} · local rule replay`,
      }
    })
    checks.push(
      { label: 'Case D · post-stop regression test', passed: null as boolean | null, detail: 'Requires a confirmed revoke and contract attempt.' },
      { label: 'Owner approval transaction', passed: null as boolean | null, detail: 'Not checked in fixture preview.' },
      { label: 'Payment and rejection events', passed: null as boolean | null, detail: 'No chain event checked in fixture preview.' },
    )
    setAuditError(null)
    setAudit({
      sessionId: '',
      verdict: 'incomplete',
      source: 'local',
      summary: 'Fixture-only rule replay. A and B should block; C is quote-eligible. This is not an approved session or a chain audit.',
      checks,
      raw: { kind: 'fixture-rule-preview', fixture: true, chainEvidence: null, policy: { budget: policy.budget, perPaymentCap: policy.perPaymentCap, allowedMerchantIds: policy.allowedMerchantIds }, quotes: catalog.quotes.filter((quote) => ['A', 'B', 'C'].includes(quote.id)), checks },
    })
  }

  function copy(value: string) {
    void navigator.clipboard.writeText(value).then(() => setNotice('Copied to clipboard.')).catch(() => setActionError('Clipboard access was denied.'))
  }

  function downloadAudit() {
    if (!audit) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(audit.raw, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = audit.source === 'local' && !audit.sessionId ? 'intentbound-fixture-preview.json' : `intentbound-audit-${audit.sessionId}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const modelState = status.kiln.connected === true ? 'Live Kiln' : status.kiln.configured ? 'Kiln configured' : 'Kiln not connected'

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate('run')} aria-label="Open Dinner Run">
          <span className="brand-symbol"><ShieldCheck size={21} strokeWidth={2.4} /></span>
          <span className="brand-name">IntentBound<span className="brand-period">.</span></span>
        </button>
        <nav className="primary-nav" aria-label="Primary">
          <button className={view === 'run' ? 'active' : ''} onClick={() => navigate('run')}><UtensilsCrossed size={16} /><span className="nav-full">Dinner Run</span><span className="nav-short">Dinner</span></button>
          <button className={view === 'activity' ? 'active' : ''} onClick={() => navigate('activity')}><Activity size={16} /><span>Activity</span></button>
          <button className={view === 'audit' ? 'active' : ''} onClick={() => navigate('audit')}><FileCheck2 size={16} /><span className="nav-full">Public Audit</span><span className="nav-short">Audit</span></button>
          <button className={view === 'usage' ? 'active' : ''} onClick={() => navigate('usage')}><Cpu size={16} /><span className="nav-full">Model Usage</span><span className="nav-short">Usage</span></button>
        </nav>
        <div className="header-actions">
          <span className={`connection-dot ${confirmedTxRecorded || status.chain.connected === true ? 'is-live' : ''}`} />
          <span className="header-network">TRON {status.chain.network || 'Shasta'}</span>
          <button className="icon-button" onClick={() => void refreshStatus()} aria-label="Refresh connections" title="Refresh connections"><RefreshCcw size={17} /></button>
        </div>
      </header>

      <div className="evidence-strip">
        <span><span className="strip-mark fixture-mark" /> {catalogOrigin === 'api' ? 'Simulated merchants & quotes' : 'Bundled fixture preview'}</span>
        <span><span className={`strip-mark ${status.kiln.connected === true ? 'live-mark' : 'offline-mark'}`} /> {modelState} · {status.kiln.model}</span>
        <span><span className={`strip-mark ${confirmedTxRecorded || status.chain.connected === true ? 'live-mark' : 'offline-mark'}`} /> {displayNetwork} test TRX · {chainStatusLabel}</span>
        <span className="strip-end"><LockKeyhole size={13} /> No delivery claim on chain</span>
      </div>

      {(apiWarning || actionError || notice) && (
        <div className={`feedback-banner ${actionError ? 'feedback-error' : notice ? 'feedback-success' : ''}`} role={actionError ? 'alert' : 'status'}>
          {actionError ? <AlertCircle size={17} /> : notice ? <CheckCircle2 size={17} /> : <Info size={17} />}
          <span>{actionError || notice || apiWarning}</span>
          <button className="icon-button" onClick={() => { setActionError(null); setNotice(null); setApiWarning(null) }} aria-label="Dismiss message" title="Dismiss"><X size={16} /></button>
        </div>
      )}

      {view === 'run' && (
        <>
          <div className="mobile-panes" role="tablist" aria-label="Dinner Run panels">
            <button className={mobilePane === 'menu' ? 'selected' : ''} onClick={() => setMobilePane('menu')}><UtensilsCrossed size={16} /> Menu</button>
            <button className={mobilePane === 'agent' ? 'selected' : ''} onClick={() => setMobilePane('agent')}><MessageSquareText size={16} /> Agent</button>
            <button className={mobilePane === 'policy' ? 'selected' : ''} onClick={() => setMobilePane('policy')}><ShieldCheck size={16} /> Permission</button>
          </div>
          <main className={`workspace-grid mobile-${mobilePane}`}>
            <aside className="agent-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">PERSONAL AGENT</span>
                  <h2>Mina's brief</h2>
                </div>
                <span className="mini-avatar">M</span>
              </div>
              <div className="location-line"><MapPin size={15} /> GWDC venue, Seoul <span className="inline-separator">·</span> Dinner</div>
              <div className="brief-quote">“A warm meal, no cilantro, while I keep building.”</div>
              <div className="preference-heading"><Heart size={15} /> Saved preferences</div>
              <div className="preference-list"><span>Warm meal</span><span>No cilantro</span><span>Near venue</span></div>

              <div className="conversation-heading">
                <span>Conversation</span>
                <span className="subtle-caption">{chat.length ? `${chat.length} messages` : 'Ready to start'}</span>
              </div>
              <div className="conversation" aria-live="polite">
                {chat.length === 0 && <div className="empty-chat"><Sparkles size={18} /><p>Send the brief to parse intent. Financial limits remain a draft until you approve them.</p></div>}
                {chat.map((turn) => <div className={`chat-turn ${turn.role}`} key={turn.id}>
                  <span className="turn-label">{turn.role === 'user' ? 'Mina' : turn.source === 'kiln' ? 'Kiln · qwen3-32b' : 'Scripted fallback'}</span>
                  <p>{turn.text}</p>
                </div>)}
                {working === 'plan' || working === 'recommend' ? <div className="chat-loading"><Loader2 size={15} className="spin" /> Agent is working...</div> : null}
              </div>
              <div className="composer-block">
                <label htmlFor="agent-message" className="sr-only">Message to personal agent</label>
                <textarea id="agent-message" value={composer} onChange={(event) => setComposer(event.target.value)} rows={3} placeholder="Tell your agent what matters..." />
                <div className="composer-actions">
                  <label className="fallback-toggle" title="Uses a clearly marked scripted fallback instead of Kiln"><input type="checkbox" checked={demoFallback} onChange={(event) => setDemoFallback(event.target.checked)} /><span>Scripted fallback</span></label>
                  <button className="send-button" onClick={() => void handlePlan()} disabled={!composer.trim() || !!working} title="Parse brief with agent" aria-label="Parse brief with agent">{working === 'plan' ? <Loader2 className="spin" size={17} /> : <Send size={17} />}</button>
                </div>
                <button className="compare-button" onClick={() => void handleRecommend()} disabled={!!working}><Sparkles size={16} /> Compare menu with agent <ArrowRight size={15} /></button>
              </div>
            </aside>

            <section className="menu-panel">
              <div className="workspace-intro">
                <div>
                  <div className="intro-kicker"><span className="kicker-line" /> GWDC SEOUL / PERSONAL AGENT</div>
                  <h1>Dinner run <span className={`intro-status ${session?.state ?? 'none'}`}>{session?.state === 'active' ? 'Active' : session?.state === 'revoked' ? 'Stopped' : session?.state === 'pending' || localPause ? 'Pending' : 'Draft'}</span></h1>
                  <p>{session ? `Session ${shortHash(session.id, 10, 6)} · ${formatAmount(remaining)} test TRX remaining` : `${formatAmount(budget)} test TRX draft cap · ${allowedMerchantIds.length} draft payees · GWDC venue`}</p>
                </div>
                <button className="outline-command intro-action" onClick={() => setShowReview(true)}><SlidersHorizontal size={16} /> Review permission</button>
              </div>
              {recommendation && <div className="recommendation-note"><Sparkles size={15} /><span><strong>{recommendation.source === 'kiln' ? 'Kiln recommendation' : 'Scripted recommendation'}:</strong> {recommendation.reason}</span></div>}

              <div className="workflow-steps" aria-label="Order workflow">
                <div className={plan ? 'done' : 'current'}><span>{plan ? <Check size={14} /> : '1'}</span> Brief</div>
                <div className={session?.state === 'active' || session?.state === 'revoked' ? 'done' : session ? 'current' : ''}><span>{session?.state === 'active' || session?.state === 'revoked' ? <Check size={14} /> : '2'}</span> Permission</div>
                <div className={paidAttempt ? 'done' : allAttempts.length ? 'current' : ''}><span>{paidAttempt ? <Check size={14} /> : '3'}</span> Decisions</div>
                <div><span>4</span> Verify</div>
              </div>

              <div className="section-topline">
                <div><span className="eyebrow">SIMULATED CATALOG</span><h2>Tonight's options</h2></div>
                <div className="section-meta"><span>{catalog.merchants.length} merchants</span><span className="meta-dot">·</span><span>All-in quotes</span></div>
              </div>
              <div className="food-grid">
                {catalogQuotes.map((quote) => {
                  const merchant = merchantFor(catalog, quote)
                  const item = itemFor(catalog, quote)
                  const isSelected = selectedQuoteId === quote.id
                  const result = previewDecision(quote, merchant, { ...policy, expiresAt: null }, 'none')
                  const recorded = [...allAttempts].reverse().find((attempt) => attempt.quoteId === quote.id)
                  const isEligible = recorded?.status === 'allowed' || (!recorded && result.allowed)
                  const label = recorded?.status === 'allowed' ? 'Payment confirmed' : recorded?.status === 'rejected' ? codeLabel(recorded.code) : recorded?.status === 'pending' ? 'Decision pending' : codeLabel(result.code)
                  return <button key={quote.id} className={`food-card ${isSelected ? 'selected' : ''} result-${isEligible ? 'eligible' : 'blocked'}`} onClick={() => setSelectedQuoteId(quote.id)} aria-pressed={isSelected}>
                    <div className="food-photo-wrap"><img src={itemImages[quote.itemId] || item?.imageUrl || '/images/doenjang-stew.jpg'} alt={item?.name ?? 'Korean dinner'} /><span className="photo-case">CASE {quote.id}</span></div>
                    <div className="food-content">
                      <div className="merchant-row"><span>{merchant?.name ?? quote.merchantId}</span><span className="eta">{merchant?.etaMinutes ?? '–'} min</span></div>
                      <h3>{item?.name ?? quote.itemId}</h3>
                      <p>{item?.description ?? 'Demo menu item'}</p>
                      <div className="food-bottom"><strong>{formatAmount(quote.total)} <small>{catalog.currency}</small></strong><span className={`result-tag ${isEligible ? 'eligible' : 'blocked'}`}>{isEligible ? <Check size={13} /> : <Ban size={13} />}{label}</span></div>
                    </div>
                  </button>
                })}
              </div>

              <div className="inspector" id="decision-inspector">
                <div className="inspector-head">
                  <div><span className="eyebrow">DECISION INSPECTOR / CASE {selectedQuote?.id}</span><h2>{selectedQuote?.id === 'D' ? 'Post-stop regression test' : selectedItem?.name ?? 'Select a quote'}</h2></div>
                  <span className={`decision-pill ${decisionState}`}>{decisionState === 'pass' ? <ShieldCheck size={16} /> : decisionState === 'pending' ? <Clock3 size={16} /> : <ShieldX size={16} />}{decisionText}</span>
                </div>
                <div className="inspector-content">
                  <div className="quote-breakdown">
                    <div className="quote-header"><span>FULL QUOTE</span><span>Merchant fixture</span></div>
                    <div><span>Items</span><strong>{formatAmount(selectedQuote?.items ?? 0)} {catalog.currency}</strong></div>
                    <div><span>Delivery</span><strong>{formatAmount(selectedQuote?.deliveryFee ?? 0)} {catalog.currency}</strong></div>
                    <div><span>Service fee</span><strong>{formatAmount(selectedQuote?.serviceFee ?? 0)} {catalog.currency}</strong></div>
                    <div><span>Tax / discount</span><strong>{formatAmount((selectedQuote?.tax ?? 0) - (selectedQuote?.discount ?? 0))} {catalog.currency}</strong></div>
                    <div className="quote-total"><span>ALL-IN TOTAL</span><strong>{formatAmount(preview?.calculatedTotal ?? 0)} <small>{catalog.currency}</small></strong></div>
                    {selectedQuote?.id === 'A' && <p className="equation-alert">15 + 2 + 2 = 19 <span>&gt;</span> {formatAmount(policy.budget)} limit</p>}
                  </div>
                  <div className="rules-list">
                    <div className="rules-title"><span>CURRENT POLICY PREVIEW</span><span>{latestAttempt ? 'Browser math · recorded decision above' : 'Browser preview · no chain decision'}</span></div>
                    {preview?.checks.map((check) => <div className="rule-row" key={check.key}>
                      <span className={`check-icon ${check.passed === true ? 'ok' : check.passed === false ? 'no' : 'unknown'}`}>{check.passed === true ? <Check size={14} /> : check.passed === false ? <X size={13} /> : <CircleHelp size={13} />}</span>
                      <span className="rule-copy"><strong>{check.label}</strong><small>{check.detail}</small></span>
                    </div>)}
                  </div>
                </div>
                <div className="inspector-footer">
                  <div className="evidence-caption"><Info size={15} /><span>{latestAttempt ? `${evidenceKind(latestAttempt)} · ${latestAttempt.code}` : selectedQuote?.id === 'D' ? 'Regression test fixture only. It does not place an order.' : 'This is a local preview, not a payment or a chain decision.'}</span></div>
                  <button className={`primary-command ${selectedQuote?.id === 'C' ? 'pay-command' : ''}`} onClick={() => void handleAttempt()} disabled={!!working || !selectedQuote || (selectedQuote.id === 'D' && (session?.state !== 'revoked' || allAttempts.some((attempt) => attempt.quoteId === 'D'))) || ((!!localPause || session?.state === 'revoked') && selectedQuote.id !== 'D') || session?.state === 'pending' || session?.state === 'revoking' || (selectedQuote.id === 'C' && allAttempts.some((attempt) => attempt.quoteId === 'C' && attempt.status === 'allowed'))}>
                    {working === 'attempt' ? <Loader2 size={16} className="spin" /> : session ? selectedQuote?.id === 'D' ? <StopCircle size={16} /> : <Play size={16} /> : <Wallet size={16} />}
                    {!session ? 'Approve to run' : selectedQuote?.id === 'D' && session.state !== 'revoked' ? 'Stop first' : selectedQuote?.id === 'D' && allAttempts.some((attempt) => attempt.quoteId === 'D') ? 'Test recorded' : selectedQuote?.id === 'C' && allAttempts.some((attempt) => attempt.quoteId === 'C' && attempt.status === 'allowed') ? 'Already paid' : working === 'attempt' ? 'Submitting...' : selectedQuote?.id === 'D' ? 'Run revoke test' : 'Run attempt'}
                  </button>
                </div>
              </div>

              <div className="timeline-section">
                <div className="section-topline timeline-title"><div><span className="eyebrow">EVIDENCE TRAIL</span><h2>Scenario runs</h2></div><button className="text-command" onClick={() => navigate('activity')}>Open activity <ArrowUpRight size={15} /></button></div>
                <div className="storyline">
                  {[
                    { id: 'A', title: 'Fees cross the line', detail: '19 TRX all-in > 18 TRX cap', icon: AlertCircle, tone: 'red' },
                    { id: 'B', title: 'Lookalike payee', detail: 'Cheaper, but not allowlisted', icon: ShieldX, tone: 'red' },
                    { id: 'C', title: 'Approved dinner', detail: '16 TRX to Han Table', icon: CheckCircle2, tone: 'green' },
                    { id: 'D', title: 'Post-stop regression test', detail: '1 TRX add-on fixture, no order', icon: StopCircle, tone: 'grey' },
                  ].map((step) => {
                    const actual = [...allAttempts].reverse().find((attempt) => attempt.quoteId === step.id)
                    const Icon = step.icon
                    return <button className={`story-step tone-${step.tone} ${selectedQuoteId === step.id ? 'selected' : ''}`} key={step.id} onClick={() => setSelectedQuoteId(step.id)}>
                      <span className="story-icon"><Icon size={17} /></span>
                      <span className="story-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
                      <span className="story-state">{actual ? actual.status === 'allowed' ? 'PAID' : actual.status === 'rejected' ? 'BLOCKED' : 'PENDING' : 'READY'}</span>
                    </button>
                  })}
                </div>
              </div>
            </section>

            <aside className="policy-panel">
              <div className="policy-top"><span className="eyebrow">PERMISSION WALLET</span><span className={`policy-status ${localPause && session?.state !== 'revoked' ? 'revoking' : session?.state ?? 'none'}`}><span />{session?.state === 'revoked' ? 'STOPPED' : localPause || session?.state === 'revoking' ? 'STOP PENDING' : session?.state === 'active' ? 'ACTIVE' : session?.state === 'pending' ? 'PENDING' : 'NOT APPROVED'}</span></div>
              <div className="wallet-balance"><span>Remaining to spend</span><strong>{formatAmount(remaining)} <small>{catalog.currency}</small></strong><div className="balance-caption">{session ? `${formatAmount(fromSun(session.spentSun))} spent / ${formatAmount(fromSun(session.budgetSun))} approved` : 'Draft only. No funds delegated.'}</div></div>
              <div className="budget-track"><span style={{ width: session && session.budgetSun ? `${Math.min(100, Math.max(0, session.spentSun / session.budgetSun * 100))}%` : '0%' }} /></div>
              <div className="policy-facts">
                <div><span><Wallet size={15} /> Per payment</span><strong>{formatAmount(policy.perPaymentCap)} {catalog.currency}</strong></div>
                <div><span><Clock3 size={15} /> Expires</span><strong>{readableTime(session?.expiresAt ?? null)}</strong></div>
                <div><span><Globe2 size={15} /> Network</span><strong>TRON {displayNetwork}</strong></div>
              </div>
              <div className="allowlist"><div className="allowlist-title"><span>{session ? 'APPROVED PAYEES' : 'DRAFT PAYEES'}</span><span title="Contract checks addresses, not store names"><CircleHelp size={15} /></span></div>
                {catalog.merchants.filter((merchant) => policy.allowedMerchantIds.includes(merchant.id)).map((merchant) => <div className="payee-row" key={merchant.id}><span className="payee-icon"><Check size={14} /></span><div><strong>{merchant.name}</strong><small title={merchant.address ?? 'Address not configured'}>{merchant.address ? shortHash(merchant.address, 8, 6) : 'Address not configured'}</small></div></div>)}
              </div>
              <div className="policy-controls">
                {!session && <button className="policy-approve" onClick={() => setShowReview(true)}><LockKeyhole size={17} /> Review & approve <ArrowRight size={16} /></button>}
                {session && <button className="policy-stop" onClick={() => setShowStopConfirm(true)} disabled={!!working || session.state === 'revoked' || session.state === 'revoking'}><StopCircle size={17} /> {session.state === 'revoked' ? 'Permission stopped' : working === 'revoke' ? 'Stopping...' : 'Stop agent spending'}</button>}
                {session && <button className="policy-secondary" onClick={() => navigate('audit')}><FileCheck2 size={16} /> Verify session <ChevronRight size={15} /></button>}
              </div>
              <div className="policy-footnote"><LockKeyhole size={14} /><span>{session ? `Session ${shortHash(session.id, 10, 6)} · ${session.approvalTxHash ? 'approval transaction recorded' : 'approval transaction pending'}` : 'No funded session yet'}</span></div>
              {paidAttempt && <div className="mini-receipt"><div><ReceiptText size={16} /> LATEST RECEIPT</div><strong>{shortHash(paidAttempt.txHash)}</strong><button onClick={() => navigate('activity')}>View payment evidence <ArrowUpRight size={14} /></button></div>}
            </aside>
          </main>
        </>
      )}

      {view === 'activity' && <main className="detail-page activity-page">
        <div className="page-heading"><div><span className="eyebrow">SESSION LEDGER</span><h1>Decision history</h1><p>Application decisions and confirmed testnet transactions are marked separately.</p></div><button className="outline-command" onClick={() => navigate('run')}><ArrowRight size={16} className="left-arrow" /> Back to dinner</button></div>
        <div className="ledger-summary"><div><span>SESSION</span><strong>{session ? shortHash(session.id, 12, 8) : 'Not created'}</strong></div><div><span>STATE</span><strong>{session?.state ?? 'No permission'}</strong></div><div><span>CONFIRMED SPEND</span><strong>{session ? formatAmount(fromSun(session.spentSun)) : '0'} {catalog.currency}</strong></div><div><span>RECORDED ATTEMPTS</span><strong>{allAttempts.length}</strong></div></div>
        <div className="activity-layout"><section><div className="section-topline"><div><span className="eyebrow">DECISION HISTORY</span><h2>Attempts</h2></div>{session && <button className="icon-button" onClick={() => void refreshStatus()} aria-label="Refresh session" title="Refresh session"><RefreshCcw size={17} /></button>}</div>
          {allAttempts.length === 0 ? <div className="empty-state"><Activity size={26} /><h3>No attempts yet</h3><p>Approve a session and run a quote to create an actual decision record.</p><button className="text-command" onClick={() => navigate('run')}>Open dinner run <ArrowRight size={15} /></button></div> : <div className="attempt-list">{allAttempts.map((attempt, index) => <div className={`attempt-row ${attempt.status}`} key={attempt.id || `${attempt.quoteId}-${index}`}><span className="attempt-index">{String(index + 1).padStart(2, '0')}</span><span className="attempt-icon">{attempt.status === 'allowed' ? <Check size={18} /> : attempt.status === 'rejected' ? <X size={18} /> : <Clock3 size={18} />}</span><div className="attempt-main"><div><strong>Case {attempt.quoteId || '?'}</strong><span>{codeLabel(attempt.code)}</span></div><small>{attempt.reason || evidenceKind(attempt)}{attempt.timestamp ? ` · ${new Date(attempt.timestamp).toLocaleString()}` : ''}</small><code>{attempt.id || 'Decision ID not returned'}</code></div><span className="evidence-badge">{attempt.status === 'pending' ? 'TX PENDING' : attempt.onChain && attempt.txHash ? 'CHAIN EVENT' : 'APP LOG'}</span></div>)}</div>}
        </section><aside className="receipt-panel"><div className="section-topline"><div><span className="eyebrow">PAYMENT EVIDENCE</span><h2>Receipt</h2></div><ReceiptText size={19} /></div>{paidAttempt ? <><div className="receipt-amount"><span>TESTNET PAYMENT</span><strong>{formatAmount(catalog.quotes.find((quote) => quote.id === paidAttempt.quoteId)?.total ?? 0)} <small>{catalog.currency}</small></strong></div><div className="receipt-lines"><div><span>Network</span><strong>TRON {session?.network ?? 'Shasta'}</strong></div><div><span>Quote</span><strong>Case {paidAttempt.quoteId}</strong></div><div><span>Decision</span><strong>{paidAttempt.code}</strong></div><div><span>Payee</span><strong>{shortHash(paidAttempt.merchantAddress)}</strong></div><div><span>Order status</span><strong>Simulated merchant</strong></div></div><div className="hash-panel"><span>CONFIRMED TRANSACTION HASH</span><code>{paidAttempt.txHash}</code><div><button className="text-command" onClick={() => paidAttempt.txHash && copy(paidAttempt.txHash)}><Copy size={15} /> Copy hash</button>{paidAttempt.txHash && explorerTxUrl(paidAttempt.txHash, session?.network ?? 'shasta') && <a className="text-command" href={explorerTxUrl(paidAttempt.txHash, session?.network ?? 'shasta')!} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open explorer</a>}</div></div><button className="primary-command receipt-audit" onClick={() => navigate('audit')}><FileCheck2 size={16} /> Independently verify <ArrowRight size={16} /></button></> : <div className="empty-state compact"><FileText size={25} /><h3>No chain receipt</h3><p>A receipt appears only after a confirmed testnet payment with a real transaction hash.</p></div>}</aside></div>
      </main>}

      {view === 'audit' && <main className="detail-page audit-page"><div className="page-heading"><div><span className="eyebrow">OPEN VERIFICATION</span><h1>Public audit</h1><p>Read-only verification by session ID. No wallet connection is required.</p></div><div className="audit-icon"><FileCheck2 size={28} /></div></div>
        <div className="audit-search"><label htmlFor="audit-session">SESSION ID</label><div><Link2 size={18} /><input id="audit-session" value={auditInput} onChange={(event) => setAuditInput(event.target.value)} placeholder="Paste a session ID" /><button className="primary-command" onClick={() => void handleAudit()} disabled={!auditInput.trim() || !!working}>{working === 'audit' ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />} Verify</button></div><div className="audit-search-actions">{session && auditInput !== session.id && <button className="text-command" onClick={() => setAuditInput(session.id)}>Use current session <ArrowRight size={14} /></button>}<button className="text-command" onClick={previewFixtureRules}><Play size={14} /> Preview fixture rules</button></div></div>
        {auditError && <div className="inline-error" role="alert"><AlertCircle size={18} /> {auditError}</div>}
        {!audit && !auditError && <div className="audit-empty"><ShieldCheck size={32} /><h2>No session selected</h2><p>Enter a session ID to check recorded terms, fee math, payee and available chain evidence. This audit does not verify real-world delivery.</p><div><span>01 <strong>Read policy</strong></span><span>02 <strong>Recompute quote</strong></span><span>03 <strong>Compare chain record</strong></span></div></div>}
        {audit && <div className="audit-results"><div className={`verdict-panel verdict-${audit.verdict}`}><div><span className="eyebrow">{audit.source === 'local' && !audit.sessionId ? 'FIXTURE PREVIEW / NO CHAIN PROOF' : `AUDIT RESULT / ${audit.source.toUpperCase()} SOURCE`}</span><h2>{audit.source === 'local' && !audit.sessionId ? 'Fixture replay only' : audit.verdict === 'pass' ? 'Permission verified' : audit.verdict === 'fail' ? 'Permission mismatch' : 'Evidence incomplete'}</h2><p>{audit.summary}</p></div>{audit.verdict === 'pass' ? <CheckCircle2 size={43} /> : audit.verdict === 'fail' ? <ShieldX size={43} /> : <CircleHelp size={43} />}</div><div className="audit-checks"><div className="section-topline"><div><span className="eyebrow">RECOMPUTED CHECKS</span><h2>{audit.source === 'local' && !audit.sessionId ? 'Fixture rule outcomes' : 'What was verified'}</h2></div><button className="outline-command" onClick={downloadAudit}><FileText size={16} /> Export JSON</button></div>{audit.checks.length ? audit.checks.map((check, index) => <div className="audit-check" key={`${check.label}-${index}`}><span className={`check-icon ${check.passed === true ? 'ok' : check.passed === false ? 'no' : 'unknown'}`}>{check.passed === true ? <Check size={15} /> : check.passed === false ? <X size={15} /> : <CircleHelp size={14} />}</span><strong>{check.label}</strong><span>{check.detail || (check.passed === null ? 'Not available' : check.passed ? 'Match' : 'Mismatch')}</span></div>) : <div className="empty-state compact"><Info size={22} /><p>The API returned no itemized checks. Treat the summary as incomplete evidence.</p></div>}</div><details className="raw-evidence"><summary>Inspect raw audit response <ChevronRight size={16} /></summary><pre>{JSON.stringify(audit.raw, null, 2)}</pre></details></div>}
      </main>}

      {view === 'usage' && <main className="detail-page usage-page"><div className="page-heading"><div><span className="eyebrow">INFERENCE LEDGER</span><h1>Model usage</h1><p>Only reported Kiln tokens appear in the totals. Scripted fallback and policy checks are excluded.</p></div><button className="outline-command" onClick={() => void loadUsage()} disabled={working === 'usage'}>{working === 'usage' ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />} Refresh</button></div>
        {usageError && <div className="inline-error"><AlertCircle size={18} /> {usageError} {browserUsage.length > 0 ? 'This browser session still shows the Kiln responses it received.' : ''}</div>}
        {(() => { const sourceRecords = usageError ? browserUsage : usage; const records = [...new Map(sourceRecords.map((record) => [record.inference.generationId ?? record.id, record])).values()].filter((record) => record.inference.source === 'kiln'); const withTokens = records.filter((record) => !!record.inference.usage); const input = withTokens.reduce((sum, record) => sum + (record.inference.usage?.inputTokens ?? 0), 0); const output = withTokens.reduce((sum, record) => sum + (record.inference.usage?.outputTokens ?? 0), 0); return <><div className="usage-summary"><div><span>MODEL</span><strong>qwen3-32b</strong><small>Kiln API</small></div><div><span>REAL CALLS</span><strong>{records.length}</strong><small>{usageError ? 'Browser session only' : 'Server ledger · scripted excluded'}</small></div><div><span>INPUT TOKENS</span><strong>{withTokens.length ? input.toLocaleString() : '—'}</strong><small>Reported by Kiln</small></div><div><span>OUTPUT TOKENS</span><strong>{withTokens.length ? output.toLocaleString() : '—'}</strong><small>Reported by Kiln</small></div></div><div className="usage-layout"><section><div className="section-topline"><div><span className="eyebrow">REQUEST LOG</span><h2>Actual inference</h2></div><span className="subtle-caption">{records.length} records</span></div>{records.length ? <div className="usage-records">{records.map((record) => <div className="usage-record" key={record.id}><span className="usage-record-icon"><Cpu size={19} /></span><div><strong>{record.purpose}</strong><small>{record.inference.model || 'Model unreported'} · {record.createdAt ? new Date(record.createdAt).toLocaleString() : 'Time unreported'}</small><code>{record.inference.generationId || 'Generation ID unreported'}</code></div><div className="usage-numbers"><strong>{record.inference.usage?.totalTokens?.toLocaleString() ?? '—'}</strong><small>tokens</small><span>{record.inference.latencyMs != null ? `${(record.inference.latencyMs / 1000).toFixed(2)} s` : 'latency n/a'}</span></div></div>)}</div> : <div className="empty-state"><Cpu size={26} /><h3>No reported Kiln calls yet</h3><p>Parse the dinner brief or compare the menu with Kiln to populate this ledger.</p><button className="text-command" onClick={() => navigate('run')}>Open dinner run <ArrowRight size={15} /></button></div>}</section><aside className="usage-note"><span className="eyebrow">EXECUTION RESPONSIBILITIES</span><h2>Agent and policy</h2><p>All-in price, payee, deadline and stop conditions are checked outside the model.</p><div><span><CheckCircle2 size={17} /> Intent and menu choice</span><strong>Kiln, when called</strong></div><div><span><ShieldCheck size={17} /> Budget and payee checks</span><strong>Code + contract</strong></div><div><span><Ban size={17} /> Additional model calls on reject</span><strong>Not required</strong></div><p className="usage-disclaimer">No energy saving claim is made from token counts alone.</p></aside></div></> })()}
      </main>}

      <footer className="app-footer"><span>IntentBound / GWDC Seoul</span><span>Simulated food marketplace · Real results only when connected</span><button onClick={() => navigate('audit')}>Public audit <ArrowUpRight size={13} /></button></footer>

      {view === 'run' && <div className="mobile-policy-dock"><div><small>REMAINING · {session?.state === 'active' ? 'ACTIVE' : 'DRAFT'}</small><strong>{formatAmount(remaining)} {catalog.currency}</strong></div>{session && session.state !== 'revoked' ? <button className="dock-stop" onClick={() => setShowStopConfirm(true)} disabled={!!working}><StopCircle size={17} /> Stop</button> : <button className="dock-review" onClick={() => setShowReview(true)}><SlidersHorizontal size={17} /> Review</button>}</div>}

      {showReview && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowReview(false) }}><div className="permission-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="modal-head"><div><span className="eyebrow">{session ? 'CURRENT SESSION' : 'DEMO APPROVAL'}</span><h2 id="review-title">{session ? 'Current permission' : 'Review permission'}</h2><p>{session ? 'These terms are fixed for this session. Stop to revoke them.' : 'Confirm amounts, payees and expiry before funding.'}</p></div><button className="icon-button" onClick={() => setShowReview(false)} aria-label="Close review" title="Close"><X size={19} /></button></div><div className="permission-form"><div className="form-duo"><label>Session budget <span>test TRX</span><input type="number" min="0.000001" step="0.1" value={session ? fromSun(session.budgetSun) : budget} onChange={(event) => setBudget(Number(event.target.value))} disabled={!!session} /></label><label>Per payment cap <span>test TRX</span><input type="number" min="0.000001" step="0.1" value={session ? fromSun(session.perPaymentCapSun) : perPaymentCap} onChange={(event) => setPerPaymentCap(Number(event.target.value))} disabled={!!session} /></label></div>{session ? <div className="expiry-readonly">Expires <strong>{readableTime(session.expiresAt)}</strong></div> : <label className="duration-field">Expires after <span>minutes</span><input type="number" min="1" max="60" step="1" value={validMinutes} onChange={(event) => setValidMinutes(Number(event.target.value))} /></label>}<div className="form-allowlist"><div><strong>{session ? 'Approved payees' : 'Payees to approve'}</strong><small>Address, not similar-looking restaurant name, controls payment.</small></div>{catalog.merchants.filter((merchant) => merchant.allowed).map((merchant) => <label key={merchant.id}><input type="checkbox" checked={(session?.allowedMerchantIds ?? allowedMerchantIds).includes(merchant.id)} onChange={(event) => setAllowedMerchantIds((current) => event.target.checked ? [...current, merchant.id] : current.filter((id) => id !== merchant.id))} disabled={!!session} /><span><strong>{merchant.name}</strong><small>{merchant.address || 'Address not configured'}</small></span></label>)}</div><div className="permission-scope"><ShieldCheck size={19} /><p><strong>All-in total:</strong> items + delivery + service + tax - discount. Demo relayer pays network fees.</p></div><div className="custody-note"><LockKeyhole size={17} /><span><strong>Demo custody:</strong> after your click, the server-side demo owner wallet signs the Shasta transaction. Your personal TronLink wallet is not connected.</span></div>{!session && <label className="confirm-line"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I approve these exact financial limits and payees.</span></label>}</div><div className="modal-actions"><button className="outline-command" onClick={() => setShowReview(false)}>{session ? 'Close' : 'Cancel'}</button>{!session && <button className="primary-command" onClick={() => void handleCreateSession()} disabled={!confirmed || !!working || !(budget > 0 && perPaymentCap > 0 && perPaymentCap <= budget && validMinutes > 0 && allowedMerchantIds.length > 0)}>{working === 'approve' ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />}{working === 'approve' ? 'Submitting demo wallet transaction...' : 'Approve with demo wallet'}</button>}</div></div></div>}

      {showStopConfirm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowStopConfirm(false) }}><div className="stop-modal" role="alertdialog" aria-modal="true" aria-labelledby="stop-title"><div className="stop-symbol"><PauseCircle size={28} /></div><h2 id="stop-title">Stop agent spending?</h2><p>New attempts pause here immediately. The server-side demo owner wallet submits the Shasta revoke transaction; the chain boundary ends when it confirms.</p><div><button className="outline-command" onClick={() => setShowStopConfirm(false)}>Keep permission</button><button className="danger-command" onClick={() => void handleRevoke()}><StopCircle size={16} /> Stop & revoke</button></div></div></div>}
    </div>
  )
}

export default App
