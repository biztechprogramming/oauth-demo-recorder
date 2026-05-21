# oauth-demo-recorder

Generates Google OAuth verification demo videos by driving a browser
through a YAML-defined flow, mixing in TTS narration, drawing an animated
cursor, and uploading the result to YouTube as Unlisted.

Designed to be reused: each app gets its own YAML flow in its own repo;
this tool is generic.

## Pipeline

```
YAML flow ─► OpenAI TTS ─► narration clips ─┐
            │                                ▼
            └────► Playwright ──► WebM ──► ffmpeg ──► MP4 ──► YouTube ──► URL
                       │                       ▲
                       └► cursor + ripples ────┘
```

1. **TTS** — for each step that has a `narration`, OpenAI's TTS API
   generates an MP3; ffprobe measures its duration.
2. **Record** — Playwright launches Chromium, executes each step, and
   pauses after each one for `max(narration_duration + 0.25s, hold)`.
   An on-screen cursor follows the mouse and emits a ripple on click.
3. **Encode** — ffmpeg places each narration clip at its step's start
   offset, mixes them, pads with silence, and transcodes to MP4
   (h.264 + aac, `+faststart` for YouTube).
4. **Upload** — googleapis YouTube Data API v3 uploads the MP4 as
   Unlisted and prints the share URL.

## Prerequisites

- **Node ≥ 22** (uses `--experimental-strip-types` so no build step).
- **ffmpeg** and **ffprobe** in PATH (`apt install ffmpeg` /
  `brew install ffmpeg`).
- **OpenAI API key** in `OPENAI_API_KEY`.
- **YouTube OAuth client** (see below) if you want auto-upload.

## Install

```bash
cd /srv/environments/dev/oauth-demo-recorder
npm install
npx playwright install chromium
cp .env.example .env  # then fill in
```

## First-time YouTube setup

YouTube uploads require a Google OAuth client that identifies *you* as
the channel owner. This is one-time:

1. Open <https://console.cloud.google.com/apis/credentials> in any GCP
   project (a personal one is fine — this client doesn't talk to your
   app's project).
2. Enable the YouTube Data API v3 for that project.
3. **Create credentials → OAuth client ID → Application type: Desktop app**.
4. Copy the Client ID + Secret into `.env`:
   ```env
   YOUTUBE_CLIENT_ID=...apps.googleusercontent.com
   YOUTUBE_CLIENT_SECRET=GOCSPX-...
   ```
5. Run the interactive auth once:
   ```bash
   ./bin/oauth-demo-record auth
   ```
   It prints a URL; open it, grant access to the YouTube channel you
   want videos uploaded to, paste the code back. The refresh token is
   stored at `~/.config/oauth-demo-recorder/yt-token.json` (mode 600).

Subsequent recordings upload silently and print the resulting URL.

## Usage

```bash
# From this directory:
./bin/oauth-demo-record examples/emailpipeline.yaml

# Headed (visible browser, useful for debugging the selectors):
./bin/oauth-demo-record --headed examples/emailpipeline.yaml

# Skip the YouTube upload even though the YAML configures it:
./bin/oauth-demo-record --no-upload examples/emailpipeline.yaml

# Keep the intermediate WebM and narration clips for debugging:
./bin/oauth-demo-record --keep-intermediate examples/emailpipeline.yaml
```

For another app, write its own YAML using `examples/emailpipeline.yaml`
as a template. The tool itself doesn't know anything about EmailPipeline.

## YAML schema

```yaml
app:
  name: <string>              # shown in default YouTube title
  base_url: <https url>       # relative `goto` steps are resolved against this

video:
  output: out/demo.mp4        # final MP4 path (relative to cwd or absolute)
  width: 1280
  height: 720
  fps: 30

narration:
  enabled: true               # false to skip TTS entirely (silent video)
  voice: onyx                 # or alloy, echo, fable, nova, shimmer, ...
  model: tts-1-hd             # or tts-1 (faster, cheaper)

cursor:
  enabled: true
  size: 28                    # pixels
  color: "rgba(34,197,94,0.9)"

youtube:
  upload: true
  title: My App — OAuth Scope Demo
  description: |
    Multi-line description shown on the YouTube page.
  visibility: unlisted        # public | unlisted | private
  tags: [oauth, verification]

steps:
  # Each step has optional `narration`, `hold`, and `label`.
  # Step types (exactly one action key per step):

  - goto: /                                    # navigate (relative to base_url, or absolute)
    narration: "..."
    hold: 3s

  - click: 'button.signin'                     # CSS selector
    by: selector                               # or text, role
    narration: "..."

  - fill: 'input[type=email]'
    value: test@example.com
    sensitive: false

  - wait_for:
      selector: '.dashboard'                   # or { url: "substring" } or { time: "2s" }

  - highlight: 'a[href="/legal/privacy-policy"]'
    color: '#22c55e'
    narration: "..."

  - scroll: bottom                             # or top, or a selector
  - screenshot: out/step5.png
```

## Where to put per-app flows

The flow YAML lives in each app's repo (typically under
`docs/legal/oauth-demo.yaml` next to the privacy policy and ToS
scaffolds). The tool stays generic.

For EmailPipeline specifically, the flow is in
`/srv/environments/dev/EmailPipeline/docs/legal/oauth-demo.yaml` once
you copy `examples/emailpipeline.yaml` there and replace the test
credentials.

## What it doesn't do

- Doesn't handle Google's actual OAuth consent screen
  (`accounts.google.com`) — that page is Google's own, can't be
  highlighted/animated, and may show 2FA challenges that need a human.
  The flow walks up to the consent screen and waits for it; record
  the consent click on a separate take if needed.
- Doesn't auto-detect 2FA. If the test account has 2FA, run with
  `--headed` and complete the challenge interactively.
- Doesn't validate that the resulting video meets Google's
  verification checklist — that's still a human judgement call.

## License

UNLICENSED / personal infra.
