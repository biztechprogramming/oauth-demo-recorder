import { z } from 'zod'

// Duration like "2s", "500ms", "1.5s". Defaults: see schema below.
const Duration = z.string().regex(/^\d+(\.\d+)?(ms|s)$/, 'Use e.g. "2s" or "500ms"')

// Per-step actions. Each step optionally has a narration string; if set,
// the TTS audio for it is generated and the step's on-screen duration is
// extended to at least the audio length.
const StepBase = z.object({
  narration: z.string().optional(),
  // Hard floor on the visible-on-screen duration after the action completes.
  // Useful when narration is short but you want the reviewer to see the
  // result for longer.
  hold: Duration.default('1s'),
  // Optional human-readable label that ends up in the verbose log.
  label: z.string().optional(),
})

export const GotoStep = StepBase.extend({
  goto: z.string().describe('Absolute URL or path relative to app.base_url'),
})

export const ClickStep = StepBase.extend({
  click: z.string().describe('CSS selector or Playwright getByText() literal'),
  by: z.enum(['selector', 'text', 'role']).default('selector'),
})

export const FillStep = StepBase.extend({
  fill: z.string().describe('CSS selector of input'),
  // Coerce: YAML parses 123456 as a number, so unquoted PINs/passwords would
  // otherwise fail validation with an inscrutable error.
  value: z.coerce.string(),
  sensitive: z.boolean().default(false).describe('If true, redact value in logs'),
})

export const WaitStep = StepBase.extend({
  wait_for: z
    .union([
      z.object({ selector: z.string() }),
      z.object({ url: z.string().describe('Substring or regex match') }),
      z.object({ time: Duration }),
    ])
    .describe('Wait for a selector, URL change, or fixed time'),
})

export const HighlightStep = StepBase.extend({
  highlight: z.string().describe('CSS selector to outline briefly'),
  color: z.string().default('#22c55e'),
})

export const ScrollStep = StepBase.extend({
  scroll: z.union([z.literal('top'), z.literal('bottom'), z.string()]),
})

export const ScreenshotStep = StepBase.extend({
  screenshot: z.string().describe('Output filename for the screenshot'),
})

export const Step = z.union([
  GotoStep,
  ClickStep,
  FillStep,
  WaitStep,
  HighlightStep,
  ScrollStep,
  ScreenshotStep,
])

export const Flow = z.object({
  app: z.object({
    name: z.string(),
    base_url: z.string().url(),
  }),
  video: z
    .object({
      output: z.string().default('out/demo.mp4'),
      width: z.number().int().default(1280),
      height: z.number().int().default(720),
      fps: z.number().int().default(30),
    })
    .default({}),
  narration: z
    .object({
      enabled: z.boolean().default(true),
      voice: z.string().optional().describe('Override OPENAI_TTS_VOICE env'),
      model: z.string().optional().describe('Override OPENAI_TTS_MODEL env'),
    })
    .default({}),
  cursor: z
    .object({
      enabled: z.boolean().default(true),
      size: z.number().int().default(28),
      color: z.string().default('rgba(34,197,94,0.9)'),
    })
    .default({}),
  youtube: z
    .object({
      upload: z.boolean().default(false),
      title: z.string(),
      description: z.string().default(''),
      visibility: z.enum(['public', 'unlisted', 'private']).default('unlisted'),
      tags: z.array(z.string()).default([]),
    })
    .partial({ title: true })
    .optional(),
  steps: z.array(Step).min(1),
})

export type FlowConfig = z.infer<typeof Flow>
export type StepConfig = z.infer<typeof Step>

export function parseDuration(d: string): number {
  // Returns milliseconds.
  const m = d.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!m) throw new Error(`bad duration: ${d}`)
  const n = parseFloat(m[1])
  return m[2] === 'ms' ? n : n * 1000
}
