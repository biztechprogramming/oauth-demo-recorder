import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import type { StepTiming } from './runner.ts'

/**
 * Mix per-step narration onto the recorded WebM and transcode to MP4
 * (h.264 + aac, +faststart) suitable for YouTube upload.
 *
 * Strategy: build an ffmpeg filter graph that places each narration clip
 * starting at its step's `startMs` offset. Steps without narration just
 * leave silence. The audio mix and the video are then muxed into MP4.
 */
export async function encodeMixedMp4(opts: {
  videoPath: string
  stepTimings: StepTiming[]
  outputPath: string
  totalDurationMs: number
}): Promise<void> {
  const { videoPath, stepTimings, outputPath, totalDurationMs } = opts
  await fs.mkdir(dirname(outputPath), { recursive: true })

  const narrated = stepTimings.filter((s) => s.narrationPath)
  if (narrated.length === 0) {
    // No audio — just transcode video.
    await runFfmpeg([
      '-y',
      '-i', videoPath,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '20',
      '-movflags', '+faststart',
      outputPath,
    ])
    return
  }

  // Inputs: [0]=video, [1..N]=narration mp3s
  const inputs: string[] = ['-y', '-i', videoPath]
  for (const s of narrated) inputs.push('-i', s.narrationPath!)

  // Build filter: delay each audio input, then amix them, then concat-pad
  // to total duration with apad.
  const filterParts: string[] = []
  const mixLabels: string[] = []
  narrated.forEach((s, idx) => {
    const inputIdx = idx + 1 // [0] is video
    const delayMs = Math.max(0, Math.round(s.startMs))
    // adelay needs comma-separated per channel; stereo = `D|D`.
    filterParts.push(
      `[${inputIdx}:a]aresample=async=1,adelay=${delayMs}|${delayMs}[a${idx}]`,
    )
    mixLabels.push(`[a${idx}]`)
  })
  filterParts.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0[mixed]`,
  )
  // Pad with silence up to the full video length so audio doesn't end early.
  filterParts.push(
    `[mixed]apad=whole_dur=${(totalDurationMs / 1000).toFixed(3)}[aout]`,
  )

  await runFfmpeg([
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  ])
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('ffmpeg not found in PATH. Install it (apt install ffmpeg / brew install ffmpeg).'))
      } else reject(e)
    })
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.split('\n').slice(-30).join('\n')}`))
    })
  })
}
