import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const demoDir = join(root, 'demo')
const workDir = join(demoDir, '.voice-work', 'hailuo')
const sourceVideo = join(demoDir, 'intentbound-verified-shasta.mp4')
const outputVideo = join(demoDir, 'intentbound-verified-shasta-hailuo.mp4')
const outputAudio = join(demoDir, 'intentbound-hailuo-voiceover.mp3')
const outputManifest = join(demoDir, 'hailuo-voiceover-manifest.json')
const model = process.env.HAILUO_TTS_MODEL || 'speech-2.8-hd'
const voiceId = process.env.HAILUO_VOICE_ID || 'Charming_Lady'
const speed = Number(process.env.HAILUO_TTS_SPEED || '1.08')
const leadInSeconds = 0.35

const scenes = [
  {
    seconds: 12,
    text: 'At G W D C Seoul, Mina codes through dinner. Her personal agent picks a meal. But who gave it permission to pay?',
  },
  {
    seconds: 18,
    text: "She asks for a warm dinner without cilantro. Kiln's Kwen three, thirty-two B parses her intent and compares a simulated menu. It recommends a dish, but cannot authorize payment or quietly change her budget.",
  },
  {
    seconds: 15,
    text: 'Mina reviews the actual boundary: eighteen test T R X all-in, two exact payee addresses, and ten minutes. This prototype uses a server-side demo wallet, not her personal TronLink.',
  },
  {
    seconds: 10,
    text: "The demo owner funds a Shasta session. The model has no wallet key. Contract rules govern payment.",
  },
  {
    seconds: 23,
    text: "Look closer: a first quote says fifteen for food. Delivery adds two; service adds two. Nineteen total, one above Mina's cap. The contract rejects the attempt on Shasta and records the reason. No payment leaves the vault. The attractive menu price does not change that.",
  },
  {
    seconds: 22,
    text: "The next quote is cheaper at fourteen. The merchant name looks familiar; the receiving address does not. It is not one of Mina's two approved payees. Another on-chain rejection. Price alone is not permission, and a lookalike name is not identity.",
  },
  {
    seconds: 24,
    text: "This time, yes. Han Table's meal is thirteen; delivery adds two, service adds one. Sixteen test T R X fits the policy. Shasta confirms the payment, and the receipt shows its transaction hash. The merchant order is simulated; no actual dinner is delivered. The testnet transfer is real.",
  },
  {
    seconds: 13,
    text: 'Mina presses Stop. Shasta confirms revocation. A one T R X add-on now fails, despite two T R X of unused budget.',
  },
  {
    seconds: 18,
    text: 'With the exported record and session I D, anyone can run the read-only audit; no wallet is needed. It replays the policy, submitted quotes, payees, and four Shasta decisions. It checks authorization, not whether dinner arrives.',
  },
  {
    seconds: 10,
    text: 'Two Kiln calls. No model calls for enforcement. Dinner is the demo; accountable agentic commerce is the ambition.',
  },
]
assert.equal(scenes.reduce((total, scene) => total + scene.seconds, 0), 165)
assert.ok(Number.isFinite(speed) && speed >= 0.5 && speed <= 2)

async function command(binary, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolveResult({ stdout, stderr })
      : reject(new Error(binary + ' exited ' + code + ': ' + stderr.slice(-1200))))
  })
}

async function duration(file) {
  const result = await command('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ])
  return Number(result.stdout.trim())
}

async function credentials() {
  if (process.env.HAILUO_API_KEY && process.env.HAILUO_API_URL) {
    return { key: process.env.HAILUO_API_KEY, endpoint: process.env.HAILUO_API_URL }
  }
  const lines = (await readFile(join(root, '海螺_ASR'), 'utf8'))
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const key = process.env.HAILUO_API_KEY || lines.find((line) => !/^https?:\/\//.test(line))
  const baseUrl = lines.find((line) => /^https?:\/\//.test(line))
  if (!key || !baseUrl) throw new Error('Missing local Hailuo access code or base URL')
  const base = new URL(baseUrl)
  if (base.origin !== 'https://ai.hashsight.org') {
    throw new Error('Refusing to send the local access code to an unexpected host')
  }
  return { key, endpoint: new URL('/v1/t2a_v2', base).toString() }
}

async function synthesize(scene, index, auth) {
  const file = join(workDir, 'scene-' + String(index).padStart(2, '0') + '.mp3')
  const metadataFile = file + '.json'
  const signature = createHash('sha256')
    .update(JSON.stringify({ text: scene.text, model, voiceId, speed, endpoint: auth.endpoint }))
    .digest('hex')
  if (existsSync(file) && existsSync(metadataFile)) {
    const cached = JSON.parse(await readFile(metadataFile, 'utf8'))
    if (cached.signature === signature) return { file, ...cached, cached: true }
  }
  const body = {
    model,
    text: scene.text,
    stream: false,
    output_format: 'hex',
    voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    language_boost: 'English',
  }
  const response = await fetch(auth.endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + auth.key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const result = await response.json()
  const status = result?.base_resp?.status_code
  if (!response.ok || status !== 0 || typeof result?.data?.audio !== 'string') {
    const message = String(result?.base_resp?.status_msg || 'No audio returned')
      .replaceAll(auth.key, '[REDACTED]')
    throw new Error('Hailuo scene ' + (index + 1) + ' failed: HTTP ' + response.status
      + ', code ' + status + ', ' + message.slice(0, 160))
  }
  const hex = result.data.audio
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error('Invalid hex audio in scene ' + (index + 1))
  await writeFile(file, Buffer.from(hex, 'hex'))
  const rawSeconds = await duration(file)
  if (!Number.isFinite(rawSeconds) || rawSeconds < 1) {
    throw new Error('Invalid audio duration in scene ' + (index + 1))
  }
  const metadata = {
    signature,
    scene: index + 1,
    text: scene.text,
    rawSeconds,
    usageCharacters: result?.extra_info?.usage_characters ?? null,
    voiceId,
    model,
  }
  await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n')
  return { file, ...metadata, cached: false }
}

const capture = JSON.parse(await readFile(join(demoDir, 'evidence', 'capture.json'), 'utf8'))
assert.equal(capture.mode, 'live')
assert.equal(capture.state, 'complete')
assert.equal(capture.chain?.auditVerdict, 'pass')
if (!existsSync(sourceVideo)) throw new Error('Verified silent master is missing')
await mkdir(workDir, { recursive: true })
const auth = await credentials()
const sourceDuration = await duration(sourceVideo)
assert.ok(Math.abs(sourceDuration - 165) < 0.1, 'Verified video must be 165 seconds')

const generated = []
for (let index = 0; index < scenes.length; index++) {
  const scene = scenes[index]
  const audio = await synthesize(scene, index, auth)
  const targetSpeech = scene.seconds - 2.2
  const tempo = Math.max(0.88, Math.min(1.25, audio.rawSeconds / targetSpeech))
  const adjustedSeconds = audio.rawSeconds / tempo
  const tailSeconds = scene.seconds - leadInSeconds - adjustedSeconds
  if (tailSeconds < 0.35) {
    throw new Error('Scene ' + (index + 1) + ' is too long (' + audio.rawSeconds.toFixed(2)
      + ' s raw). Shorten its narration or increase voice speed.')
  }
  if (tailSeconds > 5) {
    throw new Error('Scene ' + (index + 1) + ' leaves ' + tailSeconds.toFixed(2)
      + ' s of silence. Add narration before rendering.')
  }
  const padded = join(workDir, 'segment-' + String(index).padStart(2, '0') + '.wav')
  const samples = scene.seconds * 48000
  await command('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', audio.file,
    '-af', 'atempo=' + tempo.toFixed(4)
      + ',aresample=48000,asetpts=N/SR/TB,adelay=350:all=1'
      + ',apad=whole_len=' + samples + ',atrim=end_sample=' + samples
      + ',asetpts=N/SR/TB',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', padded,
  ])
  generated.push({
    scene: index + 1,
    seconds: scene.seconds,
    text: scene.text,
    rawSeconds: audio.rawSeconds,
    tempo,
    adjustedSeconds,
    tailSeconds,
    usageCharacters: audio.usageCharacters,
    cached: audio.cached,
  })
  process.stdout.write('Scene ' + (index + 1) + '/10: ' + audio.rawSeconds.toFixed(2)
    + 's raw, ' + tailSeconds.toFixed(2) + 's tail\n')
}

const concatFile = join(workDir, 'concat.txt')
await writeFile(concatFile,
  scenes.map((_, index) => "file 'segment-" + String(index).padStart(2, '0') + ".wav'").join('\n') + '\n')
const fullWav = join(workDir, 'voiceover.wav')
await command('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
  '-i', concatFile, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9',
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', fullWav,
])
const fullDuration = await duration(fullWav)
assert.ok(Math.abs(fullDuration - 165) < 0.1, 'Voiceover duration differs from 165 seconds')

await command('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error', '-i', fullWav,
  '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', outputAudio,
])
const tempVideo = outputVideo + '.tmp.mp4'
await command('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-i', sourceVideo, '-i', fullWav,
  '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-metadata', 'title=IntentBound verified Shasta demo',
  '-metadata', 'artist=xlen',
  '-metadata:s:a:0', 'language=eng',
  '-disposition:a:0', 'default',
  '-t', '165', '-movflags', '+faststart', tempVideo,
])
const finalDuration = await duration(tempVideo)
assert.ok(Math.abs(finalDuration - 165) < 0.1, 'Final video duration differs from 165 seconds')
await rename(tempVideo, outputVideo)

await writeFile(outputManifest, JSON.stringify({
  sourceVideo: 'intentbound-verified-shasta.mp4',
  outputVideo: 'intentbound-verified-shasta-hailuo.mp4',
  outputAudio: 'intentbound-hailuo-voiceover.mp3',
  durationSeconds: finalDuration,
  gatewayOrigin: new URL(auth.endpoint).origin,
  model,
  voiceId,
  totalUsageCharacters: generated.reduce((total, scene) => total + Number(scene.usageCharacters || 0), 0),
  scenes: generated,
  disclosure: 'Simulated food merchants; real Kiln and TRON Shasta evidence. Voice synthesized through the configured Hailuo TTS gateway.',
}, null, 2) + '\n')
process.stdout.write('Created ' + outputVideo + ' and ' + outputAudio + '\n')
