import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium } = requireFromWeb('playwright')
const captureDir = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Usage: node demo/resume-live.mjs CAPTURE_DIR')
const manifest = JSON.parse(await readFile(join(captureDir, 'capture.json'), 'utf8'))
assert.equal(manifest.mode, 'live')
assert.equal(manifest.state, 'incomplete', 'Only an incomplete live capture can be resumed')
assert.ok(manifest.chain?.sessionId && manifest.chain?.revokeTxHash, 'Capture did not reach a confirmed revoke')
assert.deepEqual(Object.keys(manifest.chain.attempts || {}).sort(), ['A', 'B', 'C'], 'Expected a verified A/B/C partial capture')
assert.ok(manifest.shots.some((shot) => shot.id === '08-stopped'), 'Missing original stop frame')

const webUrl = (process.env.INTENTBOUND_WEB_URL || manifest.webUrl).replace(/\/+$/, '')
const apiUrl = (process.env.INTENTBOUND_API_URL || manifest.apiUrl).replace(/\/+$/, '')
const sessionId = manifest.chain.sessionId
const txPattern = /^(?:0x)?[a-fA-F0-9]{64}$/
let browser
let context
let page

async function apiGet(path) {
  const response = await fetch(new URL(path, apiUrl), { signal: AbortSignal.timeout(30_000) })
  const body = await response.json().catch(() => null)
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function responseFromClick(path, method, action, timeout = 120_000) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => new URL(candidate.url()).pathname === path && candidate.request().method() === method, { timeout }),
    action(),
  ])
  const body = await response.json().catch(() => null)
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function shot(id, description) {
  await page.waitForTimeout(400)
  const file = `shots/${id}.png`
  await page.screenshot({ path: join(captureDir, file) })
  manifest.shots.push({ id, file, description, at: new Date().toISOString() })
  await page.waitForTimeout(700)
}

async function saveManifest() {
  await writeFile(join(captureDir, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n')
}

async function verifyOriginalSession() {
  const status = await apiGet('/api/status')
  assert.equal(status.chain?.network, 'shasta')
  assert.equal(status.chain?.configured, true)
  assert.equal(status.chain?.contractAddress, manifest.status.chain.contractAddress)
  const { session } = await apiGet(`/api/sessions/${sessionId}`)
  assert.equal(session?.state, 'revoked')
  assert.equal(session?.spentSun, 16_000_000)
  assert.equal(session?.approvalTxHash, manifest.chain.approvalTxHash)
  assert.equal(session?.revokeTxHash, manifest.chain.revokeTxHash)
  const { evidence } = await apiGet(`/api/sessions/${sessionId}/evidence`)
  for (const id of ['A', 'B', 'C']) {
    const fromCapture = manifest.chain.attempts[id]
    const fromServer = evidence.attempts.find((attempt) => attempt.id === fromCapture.id)
    assert.equal(fromServer?.txHash, fromCapture.txHash, `Case ${id} is not from the original capture session`)
    assert.equal(fromServer?.chainEvent?.name, fromCapture.event)
  }
}

async function finish() {
  await verifyOriginalSession()
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true })
  context = await browser.newContext({
    viewport: { width: 1920, height: 960 },
    deviceScaleFactor: 1,
    recordVideo: { dir: captureDir, size: { width: 1920, height: 960 } },
  })
  page = await context.newPage()
  page.on('pageerror', (error) => manifest.pageErrors.push(error.message))
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate((id) => window.localStorage.setItem('intentbound-session-id', id), sessionId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('STOPPED', { exact: true }).first().waitFor({ timeout: 30_000 })

  await page.locator('.story-step').filter({ hasText: 'Post-stop regression test' }).click()
  const runButton = page.locator('.inspector-footer .primary-command')
  assert.equal(await runButton.isEnabled(), true, 'Case D is not enabled after revoke')
  const decision = await responseFromClick(`/api/sessions/${sessionId}/attempts`, 'POST', () => runButton.click(), 180_000)
  const attempt = decision.attempt
  assert.equal(attempt?.quoteId, 'D')
  assert.equal(attempt?.status, 'rejected')
  assert.equal(attempt?.code, 'REVOKED')
  assert.equal(attempt?.onChain, true)
  assert.match(attempt?.txHash || '', txPattern)
  assert.equal(decision.session?.spentSun, 16_000_000)
  const afterD = await apiGet(`/api/sessions/${sessionId}/evidence`)
  const recordedD = afterD.evidence.attempts.find((entry) => entry.id === attempt.id)
  assert.equal(recordedD?.chainEvent?.name, 'AttemptRejected')
  assert.equal(recordedD?.chainEvent?.reason, 'REVOKED')
  assert.equal(recordedD?.chainEvent?.amountSun, attempt.amountSun)
  assert.equal(recordedD?.chainEvent?.merchantAddress, attempt.merchantAddress)
  assert.equal(recordedD?.chainEvent?.quoteHash?.toLowerCase(), attempt.quoteHash?.toLowerCase())
  manifest.chain.attempts.D = {
    id: attempt.id, code: attempt.code, status: attempt.status,
    amountSun: attempt.amountSun, txHash: attempt.txHash,
    event: 'AttemptRejected', spentSun: decision.session.spentSun,
  }
  await page.locator('.inspector-footer .evidence-caption').filter({ hasText: 'REVOKED' }).waitFor()
  await shot('09-case-d', 'Post-revoke regression test: real REVOKED event from the original session')

  await page.locator('.primary-nav').getByRole('button', { name: /Public Audit/ }).click()
  await page.getByRole('heading', { name: 'Public audit' }).waitFor()
  await page.locator('#audit-session').fill(sessionId)
  const audit = await responseFromClick(`/api/sessions/${sessionId}/audit`, 'GET', () => page.getByRole('button', { name: 'Verify' }).click())
  assert.equal(audit?.audit?.verdict, 'pass')
  assert.ok(audit.audit.checks.every((check) => check.passed === true))
  assert.ok(audit.audit.checks.some((check) => check.label.includes('Attempt D')))
  manifest.chain.auditVerdict = 'pass'
  await page.getByRole('heading', { name: 'Permission verified' }).waitFor()
  await writeFile(join(captureDir, 'shasta-audit.json'), JSON.stringify(audit, null, 2) + '\n')
  await writeFile(join(captureDir, 'shasta-session-evidence.json'), JSON.stringify(afterD, null, 2) + '\n')
  manifest.chain.auditFile = 'shasta-audit.json'
  manifest.chain.evidenceFile = 'shasta-session-evidence.json'
  await shot('10-audit', 'Read-only audit passed for all four decisions from the original session')

  await page.locator('.primary-nav').getByRole('button', { name: /Model Usage/ }).click()
  await page.getByRole('heading', { name: 'Model usage' }).waitFor()
  const usage = await apiGet('/api/usage')
  const current = {}
  for (const [flow, inference] of Object.entries({ plan: manifest.kiln.plan, recommend: manifest.kiln.recommend })) {
    const matches = usage.records.filter((record) => record.purpose === flow
      && record.inference?.source === 'kiln'
      && record.inference?.generationId === inference.generationId
      && record.inference?.usage?.totalTokens === inference.usage.totalTokens)
    assert.equal(matches.length, 1, `Cannot isolate ${flow} Kiln usage from the original run`)
    current[flow] = matches[0]
  }
  const totals = {
    inputTokens: current.plan.inference.usage.inputTokens + current.recommend.inference.usage.inputTokens,
    outputTokens: current.plan.inference.usage.outputTokens + current.recommend.inference.usage.outputTokens,
    totalTokens: current.plan.inference.usage.totalTokens + current.recommend.inference.usage.totalTokens,
  }
  await writeFile(join(captureDir, 'kiln-usage-server-snapshot.json'), JSON.stringify(usage, null, 2) + '\n')
  await writeFile(join(captureDir, 'kiln-usage-this-run.json'), JSON.stringify({
    model: 'qwen3-32b', capturedAt: manifest.capturedAt,
    disclosure: 'These two API ledger records belong to the original capture session. Server totals include earlier calls.',
    records: [current.plan, current.recommend], totals,
  }, null, 2) + '\n')
  manifest.kiln.usageFiles = { currentRun: 'kiln-usage-this-run.json', serverSnapshot: 'kiln-usage-server-snapshot.json' }
  manifest.kiln.currentRunTotals = totals
  manifest.kiln.usageRecordCount = usage.records.filter((entry) => entry.inference?.source === 'kiln').length
  await shot('11-usage', 'Cumulative server usage summary; this run is isolated in kiln-usage-this-run.json')
  await page.locator('.usage-record').filter({ hasText: manifest.kiln.recommend.generationId }).scrollIntoViewIfNeeded()
  await shot('12-usage-current', 'The two Kiln request rows from the original capture')

  assert.deepEqual(manifest.pageErrors, [], 'The UI raised an uncaught error')
  manifest.capturePath = 'A/B/C and revoke were captured in the original browser context; the renamed D UI step, audit, and usage were captured in a new browser context using the same session ID.'
  manifest.resumedAt = new Date().toISOString()
  manifest.state = 'complete'
  delete manifest.failure
  await saveManifest()
  const video = page.video()
  await context.close()
  context = null
  if (video) await rename(await video.path(), join(captureDir, 'raw-ui-resume.webm'))
  const rawClips = (await readdir(captureDir)).filter((name) => name.endsWith('.webm') && name !== 'raw-ui-resume.webm')
  if (rawClips.length === 1) await rename(join(captureDir, rawClips[0]), join(captureDir, 'raw-ui-initial.webm'))
  console.log(`Completed resumed live capture for ${sessionId}: ${captureDir}`)
}

try {
  await finish()
} catch (error) {
  manifest.state = 'incomplete'
  manifest.failure = error instanceof Error ? error.message : String(error)
  await saveManifest()
  if (context) await context.close().catch(() => {})
  console.error(`Resume incomplete: ${manifest.failure}`)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
}
