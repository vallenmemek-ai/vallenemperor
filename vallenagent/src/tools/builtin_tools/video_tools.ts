import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { registry, ToolSchema } from '../tools'
import { getActiveProvider, loadConfig } from '../../core/config'
import { findOnPath } from '../../core/platform'

const MAX_VIDEO_BYTES = 500 * 1024 * 1024
const MAX_FRAMES = 12
const DEFAULT_FRAMES = 6

/**
 * `video_analyze` — VallenEmperor had no way to look at a video, so the agent could
 * only guess from a filename. This samples representative frames with ffmpeg and
 * sends them through the same vision path as `vision_analyze` (OpenAI-compatible
 * chat/completions with image_url parts). No new dependency: ffmpeg is detected.
 *
 * `video_generate` is intentionally not implemented — it needs a paid video API and
 * there is no honest local fallback.
 */
export function registerVideoTools(): void {
  const schema: ToolSchema = {
    name: 'video_analyze',
    description: 'Analyze a local video file by sampling representative frames with ffmpeg and asking the vision model about them. Use when the user references a video or screen recording. Requires ffmpeg on PATH.',
    parameters: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: 'Local video path (mp4, mkv, mov, webm, gif, …)' },
        question: { type: 'string', description: 'What to answer about the video (default: describe what happens)' },
        frames: { type: 'integer', description: `How many frames to sample (default ${DEFAULT_FRAMES}, max ${MAX_FRAMES})` }
      },
      required: ['video_path']
    }
  }

  registry.register({
    name: 'video_analyze',
    schema,
    toolset: 'vision',
    parallelSafe: true,
    checkFn: () => Boolean(findOnPath('ffmpeg')),
    handler: async (args, context) => {
      const rawPath = String(args.video_path || '').trim()
      const question = String(args.question || 'Describe what happens in this video and answer any user questions.').trim()
      const requested = Number(args.frames) || DEFAULT_FRAMES
      const frames = Math.max(1, Math.min(MAX_FRAMES, Math.round(requested)))

      if (!rawPath) return JSON.stringify({ error: 'video_path is required' })
      if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
        return JSON.stringify({ error: 'video_analyze takes a local file only; download it first (terminal: curl -L -o file.mp4 <url>).' })
      }

      const ffmpeg = findOnPath('ffmpeg')
      if (!ffmpeg) {
        return JSON.stringify({ error: 'ffmpeg not found on PATH. Install ffmpeg (apt install ffmpeg / brew install ffmpeg / pkg install ffmpeg) or analyze extracted frames with vision_analyze.' })
      }

      const expanded = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath
      const fullPath = isAbsolute(expanded) ? expanded : resolve(context?.workingDir || process.cwd(), expanded)
      if (!existsSync(fullPath)) return JSON.stringify({ error: `Video file not found: ${rawPath}` })
      const stat = statSync(fullPath)
      if (!stat.isFile()) return JSON.stringify({ error: `Not a regular file: ${rawPath}` })
      if (stat.size > MAX_VIDEO_BYTES) {
        return JSON.stringify({ error: `Video too large: ${(stat.size / 1024 / 1024).toFixed(0)} MB (max ${MAX_VIDEO_BYTES / 1024 / 1024} MB)` })
      }

      let tempDir: string | undefined
      try {
        tempDir = mkdtempSync(join(tmpdir(), 'vallen-video-'))
        // `thumbnail` keeps the most representative frame of each batch, so N frames
        // cover the whole clip instead of only the first N seconds.
        const extract = spawnSync(ffmpeg, [
          '-v', 'error',
          '-i', fullPath,
          '-vf', 'thumbnail,scale=640:-2',
          '-frames:v', String(frames),
          '-q:v', '4',
          join(tempDir, 'frame-%02d.jpg')
        ], { encoding: 'utf8', timeout: 120_000 })

        if (extract.error) return JSON.stringify({ error: `ffmpeg failed: ${extract.error.message}` })
        if (extract.status !== 0) {
          return JSON.stringify({ error: `ffmpeg could not decode the video: ${(extract.stderr || '').trim().slice(0, 300) || `exit ${extract.status}`}` })
        }

        const files = readdirSync(tempDir).filter(name => name.endsWith('.jpg')).sort()
        if (!files.length) return JSON.stringify({ error: 'ffmpeg produced no frames; is this a real video file?' })

        const images = files.map(name => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${readFileSync(join(tempDir!, name)).toString('base64')}` }
        }))

        let providerCfg: { base_url: string; api_key: string; model: string }
        try {
          providerCfg = (context?.providerConfig || getActiveProvider(loadConfig())) as any
        } catch {
          providerCfg = { base_url: 'http://127.0.0.1:20128/v1', api_key: '', model: 'ag/gemini-3.8-flash-medium' }
        }
        const baseURL = (providerCfg.base_url || 'http://127.0.0.1:20128/v1').replace('://localhost:', '://127.0.0.1:')
        const apiKey = providerCfg.api_key || ''

        const response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: providerCfg.model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: `${question}\n\n(${files.length} frames sampled evenly across the video.)` },
                ...images
              ]
            }],
            stream: false,
            max_tokens: 2048
          }),
          signal: AbortSignal.timeout(120_000)
        })

        if (!response.ok) {
          const body = await response.text()
          return JSON.stringify({ error: `Vision model HTTP ${response.status}: ${body.slice(0, 300)}` })
        }
        const payload: any = await response.json()
        const answer = String(payload?.choices?.[0]?.message?.content || '').trim()
        if (!answer) return JSON.stringify({ error: 'Vision model returned an empty answer.' })
        return JSON.stringify({ answer, frames: files.length, model: providerCfg.model })
      } catch (error: any) {
        return JSON.stringify({ error: `video_analyze failed: ${error?.message || String(error)}` })
      } finally {
        if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best effort */ } }
      }
    }
  })
}
