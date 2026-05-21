import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseDuration } from './schema.ts'
import type { FlowConfig, StepConfig } from './schema.ts'
import { buildCursorInitScript, moveCursorTo, rippleAt } from './cursor.ts'

export interface StepTiming {
  index: number
  label: string
  startMs: number  // offset from start of recording, in ms
  durationMs: number
  narrationPath?: string
}

export interface RunResult {
  videoPath: string         // path to the raw WebM Playwright produced
  stepTimings: StepTiming[]
  totalDurationMs: number
}

interface RunnerOpts {
  flow: FlowConfig
  audioByStepIndex: Map<number, { path: string; durationSec: number }>
  outDir: string
  headless: boolean
}

export async function runFlow(opts: RunnerOpts): Promise<RunResult> {
  const { flow, audioByStepIndex, outDir, headless } = opts
  const videoDir = join(outDir, 'video')
  await fs.mkdir(videoDir, { recursive: true })

  const browser: Browser = await chromium.launch({ headless })
  const context: BrowserContext = await browser.newContext({
    viewport: { width: flow.video.width, height: flow.video.height },
    recordVideo: {
      dir: videoDir,
      size: { width: flow.video.width, height: flow.video.height },
    },
  })

  if (flow.cursor.enabled) {
    await context.addInitScript(
      buildCursorInitScript({ size: flow.cursor.size, color: flow.cursor.color }),
    )
  }

  const page: Page = await context.newPage()

  const start = Date.now()
  const timings: StepTiming[] = []

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    const stepStart = Date.now() - start
    const label = stepLabel(step, i)

    await executeStep(page, step, flow, i)

    // Hold on screen so the reviewer can absorb the result and narration plays out.
    const holdMs = parseDuration(step.hold)
    const narration = audioByStepIndex.get(i)
    const narrationMs = narration ? Math.ceil(narration.durationSec * 1000) : 0
    // Add 250ms breathing room after the narration ends.
    const onScreenMs = Math.max(holdMs, narrationMs + 250)
    await page.waitForTimeout(onScreenMs)

    timings.push({
      index: i,
      label,
      startMs: stepStart,
      durationMs: Date.now() - start - stepStart,
      narrationPath: narration?.path,
    })
    process.stderr.write(`  step ${i + 1}/${flow.steps.length}  ${label}  (${(Date.now() - start - stepStart)}ms)\n`)
  }

  const totalDurationMs = Date.now() - start

  await page.close()
  await context.close() // flushes video to disk
  await browser.close()

  // Find the produced WebM (Playwright names it with a random suffix).
  const videos = await fs.readdir(videoDir)
  const webm = videos.find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error('Playwright did not produce a .webm in ' + videoDir)
  const videoPath = join(videoDir, webm)

  return { videoPath, stepTimings: timings, totalDurationMs }
}

function stepLabel(step: StepConfig, i: number): string {
  if (step.label) return step.label
  if ('goto' in step) return `goto ${step.goto}`
  if ('click' in step) return `click ${step.click}`
  if ('fill' in step) return `fill ${step.fill}`
  if ('wait_for' in step) return `wait_for ${JSON.stringify(step.wait_for)}`
  if ('highlight' in step) return `highlight ${step.highlight}`
  if ('scroll' in step) return `scroll ${step.scroll}`
  if ('screenshot' in step) return `screenshot ${step.screenshot}`
  return `step-${i}`
}

async function executeStep(page: Page, step: StepConfig, flow: FlowConfig, _i: number): Promise<void> {
  // goto
  if ('goto' in step) {
    const url = step.goto.startsWith('http')
      ? step.goto
      : new URL(step.goto, flow.app.base_url).toString()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return
  }
  // click
  if ('click' in step) {
    const locator =
      step.by === 'text' ? page.getByText(step.click, { exact: false }) :
      step.by === 'role' ? page.getByRole('button', { name: step.click }) :
      page.locator(step.click)
    await locator.first().scrollIntoViewIfNeeded()
    const box = await locator.first().boundingBox()
    if (box) {
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      // Move the visible cursor first, then click + ripple at the target.
      await page.mouse.move(cx, cy, { steps: 12 })
      await page.evaluate(moveCursorTo(cx, cy))
      await page.waitForTimeout(150)
      await page.evaluate(rippleAt(cx, cy))
    }
    await locator.first().click()
    return
  }
  // fill
  if ('fill' in step) {
    await page.locator(step.fill).first().fill(step.value)
    return
  }
  // wait_for
  if ('wait_for' in step) {
    const w = step.wait_for
    if ('selector' in w) await page.waitForSelector(w.selector)
    else if ('url' in w) await page.waitForURL((u) => u.toString().includes(w.url))
    else await page.waitForTimeout(parseDuration(w.time))
    return
  }
  // highlight
  if ('highlight' in step) {
    await page.evaluate(
      ({ sel, color }) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (!el) return
        const prev = el.style.outline
        el.style.outline = `3px solid ${color}`
        el.style.outlineOffset = '3px'
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        setTimeout(() => {
          el.style.outline = prev
        }, 2500)
      },
      { sel: step.highlight, color: step.color },
    )
    return
  }
  // scroll
  if ('scroll' in step) {
    if (step.scroll === 'top') await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
    else if (step.scroll === 'bottom')
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }))
    else
      await page.evaluate(
        (sel) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        step.scroll,
      )
    return
  }
  // screenshot
  if ('screenshot' in step) {
    await page.screenshot({ path: step.screenshot, fullPage: false })
    return
  }
}
