import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { resolve, join, dirname, isAbsolute } from 'path'
import { homedir } from 'os'
import { registry, ToolSchema } from '../tools'
import { getVallenHome, loadConfig, getActiveProvider } from '../../core/config'
import { fetchSafeUrl } from '../../core/network_safety'

export function registerMediaTools(): void {
  // 12. image_generate
  const imageGenerateSchema: ToolSchema = {
    name: 'image_generate',
    description: 'Generate images from visual text prompt. Saves generated image to disk and returns path.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image description prompt' },
        aspect_ratio: { type: 'string', description: "Aspect ratio (e.g. '1:1', '16:9', '9:16', '4:3')" },
        output_path: { type: 'string', description: 'Optional local destination path' }
      },
      required: ['prompt']
    }
  }

  registry.register({
    name: 'image_generate',
    schema: imageGenerateSchema,
    toolset: 'image_gen',
    handler: async (args, context, signal) => {
      const prompt = String(args.prompt || '').trim()
      if (!prompt) return JSON.stringify({ error: 'Prompt is required' })

      const outDir = join(getVallenHome(), 'images')
      mkdirSync(outDir, { recursive: true })
      let requestedPath = String(args.output_path || '')
      if (requestedPath.startsWith('~/')) requestedPath = join(homedir(), requestedPath.slice(2))
      let targetFile = requestedPath
        ? resolve(context.workingDir || process.cwd(), requestedPath)
        : join(outDir, `img_${Date.now()}`)

      try {
        let width = 1024
        let height = 1024
        if (args.aspect_ratio === '16:9') { width = 1280; height = 720 }
        else if (args.aspect_ratio === '9:16') { width = 720; height = 1280 }
        else if (args.aspect_ratio === '4:3') { width = 1024; height = 768 }

        const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`
        const controller = new AbortController()
        const abort = () => controller.abort()
        const timer = setTimeout(abort, 120_000)
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
        let res: Response
        let buf: Buffer
        try {
          res = await fetch(pollUrl, { signal: controller.signal })
          if (!res.ok) throw new Error(`Pollinations HTTP error: ${res.status}`)
          buf = Buffer.from(await res.arrayBuffer())
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }

        // Detect real image format from magic bytes; reject non-image error pages.
        let realExt: string | undefined
        if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
          realExt = 'jpg'
        } else if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
          realExt = 'png'
        } else if (buf.length >= 4 && buf.slice(0, 4).toString() === 'RIFF') {
          realExt = 'webp'
        }
        if (!realExt) throw new Error(`Pollinations response is not a supported image (content-type: ${res.headers.get('content-type') || 'unknown'})`)

        let finalPath = targetFile
        const ext = realExt === 'jpg' ? '.jpg' : `.${realExt}`
        if (!/\.(?:png|jpe?g|webp)$/i.test(finalPath)) finalPath += ext
        else if (!finalPath.toLowerCase().endsWith(ext)) finalPath = finalPath.replace(/\.(?:png|jpe?g|webp)$/i, ext)

        mkdirSync(dirname(finalPath), { recursive: true })
        writeFileSync(finalPath, buf)

        return JSON.stringify({
          success: true,
          path: finalPath,
          bytes: buf.length,
          url: pollUrl,
          message: `Image generated and saved to ${finalPath}`
        })
      } catch (err: any) {
        return JSON.stringify({ error: err.message || 'Image generation failed' })
      }
    }
  })

  // 13. vision_analyze
  const visionAnalyzeSchema: ToolSchema = {
    name: 'vision_analyze',
    description: 'Analyze images and photos using AI vision. Supports local image paths (PNG, JPEG, WebP, GIF) or web URLs. Call it any time the user references an image or photo — then answer from what you see.',
    parameters: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'Image URL (http/https), local file path, or data: URL to analyze' },
        question: { type: 'string', description: 'Your question or request about the image (e.g. describe contents, read text, identify errors)' }
      },
      required: ['image_url', 'question']
    }
  }

  registry.register({
    name: 'vision_analyze',
    schema: visionAnalyzeSchema,
    toolset: 'vision',
    parallelSafe: true,
    handler: async (args, context) => {
      const rawInput = String(args.image_url || '').trim()
      const question = String(args.question || 'Describe this image in detail and answer any user questions.').trim()

      if (!rawInput) {
        return JSON.stringify({ error: 'image_url parameter is required' })
      }

      let dataUrl = ''

      if (rawInput.startsWith('data:image/')) {
        dataUrl = rawInput
      } else if (rawInput.startsWith('http://') || rawInput.startsWith('https://')) {
        try {
          let currentUrl = rawInput
          let res: any
          for (let redirects = 0; ; redirects++) {
            const parsed = new URL(currentUrl)
            res = await fetchSafeUrl(currentUrl, { signal: AbortSignal.timeout(20000), timeoutMs: 20000, maxBytes: 10 * 1024 * 1024, requester: context?.httpRequester })
            if (![301, 302, 303, 307, 308].includes(res.status)) break
            if (redirects >= 5) throw new Error('Too many redirects')
            const location = res.headers?.get?.('location')
            if (!location) throw new Error('Redirect with no Location header')
            res.body?.resume?.()
            currentUrl = new URL(location, parsed).toString()
          }
          if (!res.ok) {
            return JSON.stringify({ error: `Failed to fetch image URL: HTTP ${res.status} ${res.statusText}` })
          }
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of res.body as any) {
            const part = Buffer.from(chunk)
            size += part.length
            if (size > 10 * 1024 * 1024) { res.body?.destroy?.(); res.body?.cancel?.(); throw new Error('Image exceeds 10MB limit') }
            chunks.push(part)
          }
          const buf = Buffer.concat(chunks)
          let mime = res.headers.get('content-type') || 'image/png'
          if (buf[0] === 0xFF && buf[1] === 0xD8) mime = 'image/jpeg'
          else if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png'
          else if (buf.slice(0, 4).toString() === 'RIFF') mime = 'image/webp'
          dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        } catch (err: any) {
          return JSON.stringify({ error: `Cannot fetch image URL: ${err.message}` })
        }
      } else {
        // Local file
        let filePath = rawInput
        if (filePath.startsWith('~/')) {
          filePath = join(homedir(), filePath.slice(2))
        }
        const fullPath = isAbsolute(filePath) ? filePath : resolve(context?.workingDir || process.cwd(), filePath)

        if (!existsSync(fullPath)) {
          return JSON.stringify({ error: `Image file not found: ${filePath}` })
        }

        try {
          const st = statSync(fullPath)
          if (!st.isFile()) {
            return JSON.stringify({ error: `Not a regular file: ${filePath}` })
          }
          if (st.size > 20 * 1024 * 1024) {
            return JSON.stringify({ error: `Image file too large: ${(st.size / 1024 / 1024).toFixed(1)} MB (max 20 MB)` })
          }

          const buf = readFileSync(fullPath)
          let mime = 'image/png'
          if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
            mime = 'image/jpeg'
          } else if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
            mime = 'image/png'
          } else if (buf.length >= 4 && buf.slice(0, 4).toString() === 'RIFF') {
            mime = 'image/webp'
          } else if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
            mime = 'image/gif'
          } else if (fullPath.toLowerCase().endsWith('.svg')) {
            mime = 'image/svg+xml'
          }

          dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        } catch (err: any) {
          return JSON.stringify({ error: `Cannot read image file: ${err.message}` })
        }
      }

      // Query vision model via active provider
      try {
        let providerCfg: { name?: string; base_url: string; api_key: string; model: string }
        try {
          providerCfg = context?.providerConfig || getActiveProvider(loadConfig()) as any
        } catch {
          providerCfg = {
            name: '9router',
            base_url: 'http://127.0.0.1:20128/v1',
            api_key: '',
            model: 'ag/gemini-3.8-flash-medium'
          }
        }
        const baseURL = (providerCfg.base_url || 'http://127.0.0.1:20128/v1').replace('://localhost:', '://127.0.0.1:')
        const model = providerCfg.model || 'ag/gemini-3.8-flash-medium'
        const apiKey = providerCfg.api_key || ''

        const visionResponse = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: question },
                  { type: 'image_url', image_url: { url: dataUrl } }
                ]
              }
            ],
            stream: false,
            max_tokens: 2048
          }),
          signal: AbortSignal.timeout(60000)
        })

        if (!visionResponse.ok) {
          const errBody = await visionResponse.text()
          return JSON.stringify({
            error: `Vision model HTTP error ${visionResponse.status}: ${errBody.slice(0, 300)}`
          })
        }

        const rawText = await visionResponse.text()
        let textAnswer = ''
        if (rawText.trim().startsWith('data:')) {
          for (const line of rawText.split('\n')) {
            const trimmed = line.trim()
            if (trimmed.startsWith('data:') && trimmed !== 'data: [DONE]') {
              try {
                const chunk = JSON.parse(trimmed.slice(5).trim())
                const delta = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || ''
                textAnswer += delta
              } catch {}
            }
          }
        } else {
          try {
            const data = JSON.parse(rawText)
            textAnswer = data.choices?.[0]?.message?.content || '(Vision model returned empty answer)'
          } catch {
            textAnswer = rawText
          }
        }

        return JSON.stringify({
          analysis: textAnswer.trim() || '(Vision model returned empty answer)',
          image: rawInput
        })
      } catch (err: any) {
        return JSON.stringify({
          error: `Vision analysis request failed: ${err.message}`
        })
      }
    }
  })

}
