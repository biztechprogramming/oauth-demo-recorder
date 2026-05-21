import { google } from 'googleapis'
import type { youtube_v3 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import * as readline from 'node:readline/promises'

const TOKEN_PATH = join(homedir(), '.config', 'oauth-demo-recorder', 'yt-token.json')
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload']

function getClient(): OAuth2Client {
  const id = process.env.YOUTUBE_CLIENT_ID
  const secret = process.env.YOUTUBE_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error(
      'YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET are not set. See README → "First-time YouTube setup".',
    )
  }
  // "Desktop app" / installed-application flow uses the OOB redirect.
  return new google.auth.OAuth2(id, secret, 'urn:ietf:wg:oauth:2.0:oob')
}

async function loadSavedToken(client: OAuth2Client): Promise<boolean> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf8')
    client.setCredentials(JSON.parse(raw))
    return true
  } catch {
    return false
  }
}

async function persistToken(client: OAuth2Client): Promise<void> {
  await fs.mkdir(dirname(TOKEN_PATH), { recursive: true })
  await fs.writeFile(TOKEN_PATH, JSON.stringify(client.credentials, null, 2), { mode: 0o600 })
}

/**
 * Interactive first-time auth. Opens a URL, asks the user to paste back the
 * code shown after consent. Persists the refresh token under ~/.config.
 */
export async function authenticate(): Promise<void> {
  const client = getClient()
  if (await loadSavedToken(client)) {
    console.log('Already authenticated. Token at ' + TOKEN_PATH)
    return
  }
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })
  console.log('\nOpen this URL in a browser and grant access to the YouTube channel you want to upload to:\n')
  console.log(url)
  console.log()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = (await rl.question('Paste the authorization code: ')).trim()
  rl.close()
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)
  await persistToken(client)
  console.log('Saved refresh token to ' + TOKEN_PATH)
}

/**
 * Upload an MP4 to YouTube. Returns the video URL.
 */
export async function uploadToYouTube(opts: {
  videoPath: string
  title: string
  description: string
  visibility: 'public' | 'unlisted' | 'private'
  tags?: string[]
}): Promise<string> {
  const client = getClient()
  const ok = await loadSavedToken(client)
  if (!ok) {
    throw new Error(
      `No saved YouTube token at ${TOKEN_PATH}. Run \`oauth-demo-record auth\` first.`,
    )
  }
  // Refresh if needed.
  if (client.isTokenExpiring()) {
    const { credentials } = await client.refreshAccessToken()
    client.setCredentials(credentials)
    await persistToken(client)
  }

  const youtube = google.youtube({ version: 'v3', auth: client })
  const stats = await fs.stat(opts.videoPath)
  process.stderr.write(`Uploading ${(stats.size / 1e6).toFixed(1)} MB to YouTube...\n`)

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: opts.title,
        description: opts.description,
        tags: opts.tags ?? [],
        categoryId: '28', // Science & Technology — neutral default for app demos.
      },
      status: {
        privacyStatus: opts.visibility,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(opts.videoPath),
    },
  } as youtube_v3.Params$Resource$Videos$Insert)

  const id = res.data.id
  if (!id) throw new Error('YouTube did not return a video ID')
  return `https://www.youtube.com/watch?v=${id}`
}
