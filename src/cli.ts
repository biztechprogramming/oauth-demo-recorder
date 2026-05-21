import { Command } from 'commander'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Flow } from './schema.ts'
import { OpenAITTS, generateClips } from './narration.ts'
import { runFlow } from './runner.ts'
import { encodeMixedMp4 } from './encode.ts'
import { authenticate, uploadToYouTube } from './upload.ts'

// Auto-load .env from the current working directory if present. Existing
// process.env values win (so the shell can still override). Silently
// ignored if .env doesn't exist.
try {
  // @ts-expect-error process.loadEnvFile is Node ≥ 20.6, not yet in @types/node universally
  process.loadEnvFile?.()
} catch {
  /* no .env in cwd — that's fine, env vars may come from the shell */
}

const program = new Command()
program
  .name('oauth-demo-record')
  .description('Record a Google OAuth verification demo video from a YAML flow.')
  .version('0.1.0')

program
  .command('auth')
  .description('Interactive first-run YouTube auth. Saves a refresh token under ~/.config/oauth-demo-recorder/.')
  .action(async () => {
    await authenticate()
  })

program
  .command('record <flow.yaml>', { isDefault: true })
  .description('Run the flow, mix narration, transcode to MP4, optionally upload.')
  .option('--headed', 'Run with a visible browser window (default: headless)', false)
  .option('--out <dir>', 'Working directory for artifacts (default: ./out)', './out')
  .option('--no-upload', 'Skip the YouTube upload step even if configured')
  .option('--keep-intermediate', 'Don\'t delete the WebM / audio clips after MP4 mux', false)
  .action(async (flowPath: string, opts) => {
    const flowSrc = await fs.readFile(flowPath, 'utf8')
    const parsed = Flow.safeParse(parseYaml(flowSrc))
    if (!parsed.success) {
      console.error('Flow YAML failed validation:')
      console.error(parsed.error.format())
      process.exit(2)
    }
    const flow = parsed.data
    const outDir = resolve(opts.out)
    await fs.mkdir(outDir, { recursive: true })

    // 1. Generate narration if enabled.
    const audioByStepIndex = new Map<number, { path: string; durationSec: number }>()
    if (flow.narration.enabled) {
      const narrationTexts = flow.steps
        .map((s, index) => ({ index, text: s.narration }))
        .filter((t): t is { index: number; text: string } => !!t.text)
      if (narrationTexts.length > 0) {
        process.stderr.write(`Generating TTS for ${narrationTexts.length} narration clips...\n`)
        const tts = new OpenAITTS({ voice: flow.narration.voice, model: flow.narration.model })
        const clips = await generateClips(narrationTexts, join(outDir, 'audio'), tts)
        for (const c of clips) audioByStepIndex.set(c.index, { path: c.path, durationSec: c.durationSec })
      }
    }

    // 2. Drive the browser and record video.
    process.stderr.write(`Running ${flow.steps.length} steps...\n`)
    const { videoPath, stepTimings, totalDurationMs } = await runFlow({
      flow,
      audioByStepIndex,
      outDir,
      headless: !opts.headed,
    })
    process.stderr.write(`Raw video: ${videoPath}  (${(totalDurationMs / 1000).toFixed(1)}s)\n`)

    // 3. Mix audio + transcode to MP4.
    const finalPath = resolve(flow.video.output)
    await encodeMixedMp4({
      videoPath,
      stepTimings,
      outputPath: finalPath,
      totalDurationMs,
    })
    process.stderr.write(`Final MP4: ${finalPath}\n`)

    // 4. Upload if configured.
    if (flow.youtube?.upload && opts.upload !== false) {
      const title = flow.youtube.title ?? `${flow.app.name} — OAuth Scope Demo`
      const url = await uploadToYouTube({
        videoPath: finalPath,
        title,
        description: flow.youtube.description,
        visibility: flow.youtube.visibility,
        tags: flow.youtube.tags,
      })
      process.stderr.write(`\nYouTube: ${url}\n`)
      console.log(url)
    } else {
      console.log(finalPath)
    }

    // 5. Cleanup unless --keep-intermediate.
    if (!opts.keepIntermediate) {
      await fs.rm(join(outDir, 'video'), { recursive: true, force: true })
      await fs.rm(join(outDir, 'audio'), { recursive: true, force: true })
    }
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
