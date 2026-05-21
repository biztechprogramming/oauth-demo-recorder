import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// Generate TTS audio per narration string, write to disk, return durations
// in seconds so the runner can pad on-screen time to fit the narration.
export interface NarrationClip {
  index: number
  path: string         // path to the MP3 file
  durationSec: number  // measured via ffprobe
  text: string         // original narration text
}

export class OpenAITTS {
  private model: string
  private voice: string
  private apiKey: string

  constructor(opts: { model?: string; voice?: string }) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set. Add it to .env or your shell environment.')
    }
    this.apiKey = apiKey
    this.model = opts.model ?? process.env.OPENAI_TTS_MODEL ?? 'tts-1-hd'
    this.voice = opts.voice ?? process.env.OPENAI_TTS_VOICE ?? 'onyx'
  }

  /** Generate one MP3 file at `outPath`. Throws on API failure. */
  async synthesize(text: string, outPath: string): Promise<void> {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        voice: this.voice,
        input: text,
        response_format: 'mp3',
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenAI TTS ${res.status}: ${body.slice(0, 300)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(outPath, buf)
  }
}

/** ffprobe wrapper: returns duration in seconds (float). */
export function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]
    const p = spawn('ffprobe', args)
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr}`))
      const n = parseFloat(stdout.trim())
      if (!Number.isFinite(n)) return reject(new Error(`ffprobe returned non-numeric: ${stdout}`))
      resolve(n)
    })
  })
}

/**
 * Generate narration clips for every step that has a `narration` field.
 * Returns clips indexed by step position, with measured durations.
 */
export async function generateClips(
  texts: { index: number; text: string }[],
  outDir: string,
  tts: OpenAITTS,
): Promise<NarrationClip[]> {
  await fs.mkdir(outDir, { recursive: true })
  const clips: NarrationClip[] = []
  for (const { index, text } of texts) {
    const path = join(outDir, `step-${String(index).padStart(3, '0')}.mp3`)
    await tts.synthesize(text, path)
    const durationSec = await probeDuration(path)
    clips.push({ index, path, durationSec, text })
  }
  return clips
}
