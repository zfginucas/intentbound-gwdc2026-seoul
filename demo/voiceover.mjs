import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const captureDir = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Usage: node demo/voiceover.mjs CAPTURE_DIR [--voice Samantha]')
const voiceArg = process.argv.indexOf('--voice')
const voice = voiceArg > 0 ? process.argv[voiceArg + 1] : 'Samantha'
if (!voice) throw new Error('Voice name is missing')
const manifest = JSON.parse(await readFile(join(captureDir, 'capture.json'), 'utf8'))
assert.equal(manifest.mode, 'live')
assert.equal(manifest.state, 'complete')
assert.equal(manifest.chain?.auditVerdict, 'pass')

const scenes = [
  { seconds: 12, text: 'Mina is building at G W D C Seoul. Her personal agent can find dinner while she codes. But who decides whether it can pay?' },
  { seconds: 18, text: 'Kiln\'s Kwen three, thirty-two B reads her preference for a warm meal without cilantro and compares the available menu. It can recommend a dish. It cannot set, raise, or waive her spending limit.' },
  { seconds: 15, text: 'Mina reviews the all-in cap, exact recipient addresses, and expiry. For this prototype, she clicks to authorize a server-side demo owner wallet. Her personal TronLink wallet is not connected.' },
  { seconds: 10, text: 'That demo wallet funds a short-lived Shasta session. The model never gets the key. Contract rules control where the session\'s test T R X can go.' },
  { seconds: 23, text: 'First, a fifteen T R X meal looks affordable until delivery and service add four more. The full quote is nineteen, above the eighteen T R X limit. The contract records a rejection; spent funds remain zero.' },
  { seconds: 22, text: 'Second, a lookalike merchant is cheaper at fourteen. But its recipient address is not one of the two approved addresses. Names can resemble each other; the contract checks the payee. Again, no payment.' },
  { seconds: 24, text: 'The real choice is Han Table: thirteen for the meal, two for delivery, one for service. Sixteen test T R X is within the session\'s limit. This is a confirmed Shasta testnet payment and a simulated merchant order, not a claim of real delivery.' },
  { seconds: 13, text: 'Mina presses Stop. Once the revoke confirms, even a one T R X add-on is refused, despite two T R X remaining. Stop is an enforceable state, not a chat instruction.' },
  { seconds: 18, text: 'A stranger can enter the session I D and replay the approved policy, fee math, recipients, and four Shasta decisions. The audit checks financial authorization. It does not pretend to verify food quality or delivery.' },
  { seconds: 10, text: 'For this run, two Kiln calls make the choice. Policy checks need none. Dinner is the demo; accountable spending is the platform.' },
]
assert.equal(scenes.reduce((sum, scene) => sum + scene.seconds, 0), 165)

async function command(binary, args) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolveResult({ stdout, stderr }) : reject(new Error(`${binary} exited ${code}: ${stderr.slice(-2000)}`)))
  })
}

async function duration(file) {
  const result = await command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file])
  return Number(result.stdout.trim())
}

const voiceDir = join(captureDir, 'voice')
await mkdir(voiceDir, { recursive: true })
const segments = []
for (let index = 0; index < scenes.length; index++) {
  const scene = scenes[index]
  const raw = join(voiceDir, `raw-${String(index).padStart(2, '0')}.aiff`)
  const padded = join(voiceDir, `segment-${String(index).padStart(2, '0')}.wav`)
  let rawSeconds = 0
  let rate = 125
  for (const candidate of [125, 135, 145, 155, 165, 175, 185]) {
    await command('say', ['-v', voice, '-r', String(candidate), '-o', raw, scene.text])
    rawSeconds = await duration(raw)
    rate = candidate
    if (rawSeconds <= scene.seconds - 0.7) break
  }
  assert.ok(rawSeconds <= scene.seconds - 0.7, `Scene ${index + 1} narration does not fit ${scene.seconds}s even at ${rate} wpm`)
  await command('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', raw,
    '-af', `adelay=350:all=1,apad,atrim=0:${scene.seconds}`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', padded,
  ])
  segments.push({ scene: index + 1, seconds: scene.seconds, speechSeconds: rawSeconds, rate, text: scene.text })
}

const concatPath = join(voiceDir, 'concat.txt')
await writeFile(concatPath, scenes.map((_, index) => `file 'segment-${String(index).padStart(2, '0')}.wav'`).join('\n') + '\n')
const output = join(captureDir, 'voiceover-Samantha.wav')
await command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c:a', 'pcm_s16le', output])
const actual = await duration(output)
assert.ok(Math.abs(actual - 165) < 0.1, `Narration must be 165s; got ${actual}`)
await writeFile(join(captureDir, 'voiceover.json'), JSON.stringify({
  voice, output, durationSeconds: actual, scenes: segments,
  disclosure: 'Optional synthetic narration generated by the local macOS say voice. The verified silent master is unchanged.',
}, null, 2) + '\n')
console.log(`Generated ${voice} voiceover: ${output} (${actual.toFixed(2)}s)`)
