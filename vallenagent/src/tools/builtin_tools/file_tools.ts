import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, openSync, readSync, closeSync, unlinkSync, renameSync } from 'fs'
import { chmodSafe } from '../../core/platform'
import { resolve, join, dirname, relative, isAbsolute, basename } from 'path'
import { homedir } from 'os'
import { parse as parseYaml } from 'yaml'
import { fuzzyReplace, generateDiff } from '../../core/patch_engine'
import { captureTypeScriptDiagnostics, newTypeScriptDiagnostics } from '../../core/typescript_diagnostics'
import { snapshotBeforeWrite } from '../../session/checkpoint'
import { registry, ToolContext, ToolSchema } from '../tools'

function generateUnifiedFileDiff(oldText: string, newText: string, filePath: string): string {
  if (oldText === '') {
    const lines = newText.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const body = lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}` : ''
    return `--- a/${filePath}\n+++ b/${filePath}${body ? `\n${body}` : ''}`
  }
  return `--- a/${filePath}\n+++ b/${filePath}\n${generateDiff(oldText, newText)}`
}

function previewDiff(diff: string, maxChars = 20_000, maxLines = 120): { diff: string; omittedLines: number; lineTruncated: boolean } {
  const lines = diff.split('\n')
  const kept: string[] = []
  let chars = 0
  let lineTruncated = false
  for (const line of lines) {
    if (kept.length >= maxLines) break
    const separator = kept.length ? 1 : 0
    const remaining = maxChars - chars - separator
    if (line.length > remaining) {
      if (remaining > 0) {
        kept.push(line.slice(0, remaining))
        lineTruncated = true
      }
      break
    }
    kept.push(line)
    chars += line.length + separator
  }
  return { diff: kept.join('\n'), omittedLines: lines.length - kept.length + Number(lineTruncated), lineTruncated }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function recordFileRead(context: ToolContext, path: string, text: string, totalLines: number, offset: number, count: number): void {
  if (!context.fileReadCoverage || count < 1) return
  const key = realpathSync(path)
  const hash = hashText(text)
  const previous = context.fileReadCoverage.get(key)
  const coverage = previous?.hash === hash && previous.totalLines === totalLines
    ? previous
    : { hash, totalLines, ranges: [] }
  const ranges = [...coverage.ranges, [offset, Math.min(totalLines, offset + count - 1)] as [number, number]]
    .sort((a, b) => a[0] - b[0])
  coverage.ranges = []
  for (const range of ranges) {
    const last = coverage.ranges.at(-1)
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else coverage.ranges.push([...range])
  }
  if (!previous && context.fileReadCoverage.size >= 256) {
    const oldest = context.fileReadCoverage.keys().next().value
    if (oldest) context.fileReadCoverage.delete(oldest)
  }
  context.fileReadCoverage.set(key, coverage)
}

function fileReadStatus(context: ToolContext, path: string, text: string): 'unread' | 'stale' | 'partial' | 'ready' {
  if (!context.fileReadCoverage) return 'unread'
  const coverage = context.fileReadCoverage.get(realpathSync(path))
  if (!coverage) return 'unread'
  if (coverage.hash !== hashText(text) || coverage.totalLines !== text.split('\n').length) return 'stale'
  return coverage.ranges.some(([start, end]) => start <= 1 && end >= coverage.totalLines) ? 'ready' : 'partial'
}

export function recordWrittenFile(context: ToolContext, path: string, text: string): void {
  if (!context.fileReadCoverage) return
  const key = realpathSync(path)
  if (!context.fileReadCoverage.has(key) && context.fileReadCoverage.size >= 256) {
    const oldest = context.fileReadCoverage.keys().next().value
    if (oldest) context.fileReadCoverage.delete(oldest)
  }
  const totalLines = text.split('\n').length
  context.fileReadCoverage.set(key, { hash: hashText(text), totalLines, ranges: [[1, totalLines]] })
}

function validateStructuredFile(path: string, content: string): string | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  try {
    if (extension === 'json') JSON.parse(content)
    else if (extension === 'yaml' || extension === 'yml') parseYaml(content)
    else return null
  } catch (error: any) {
    return `Invalid ${extension.toUpperCase()} syntax: ${error.message}`
  }
  return null
}

export function isTruthy(val: any): boolean {
  if (val === true || val === 1) return true
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes' || s === 'y'
  }
  return false
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export function registerFileTools(): void {
  // 1. read_file
  const readFileSchema: ToolSchema = {
    name: 'read_file',
    description: "Read a text file with line numbers and pagination. Existing files must be fully read with read_file before write_file may overwrite them. Output format: 'LINE_NUM|CONTENT'. Use offset and limit for large files.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read (absolute, relative, or ~/path)' },
        offset: { type: 'integer', description: 'Line number to start reading from (1-indexed, default: 1)' },
        limit: { type: 'integer', description: 'Maximum number of lines to read (default: 2000, max: 2000)' }
      },
      required: ['path']
    }
  }

  registry.register({
    name: 'read_file',
    schema: readFileSchema,
    toolset: 'file',
    parallelSafe: true,
    handler: async (args, context) => {
      const basePath = context.workingDir || process.cwd()
      let rawPath = args.path as string
      if (rawPath.startsWith('~/')) {
        rawPath = join(homedir(), rawPath.slice(2))
      }
      const fullPath = isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath)

      if (!existsSync(fullPath)) {
        return JSON.stringify({ error: `File not found: ${rawPath}` })
      }

      // BUG-04: Check file type and size before reading
      try {
        const stats = statSync(fullPath)
      
        // Only read regular files
        if (!stats.isFile()) {
          return JSON.stringify({ error: `Not a regular file: ${rawPath}` })
        }
      
        // Reject files > 10 MB
        const maxSize = 10 * 1024 * 1024
        if (stats.size > maxSize) {
          return JSON.stringify({ 
            error: `File too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB (max 10 MB)`,
            hint: 'Use terminal with head/tail for large files'
          })
        }
      
        // Detect binary files
        const fd = openSync(fullPath, 'r')
        const buffer = Buffer.alloc(8192)
        let bytesRead: number
        try {
          bytesRead = readSync(fd, buffer, 0, 8192, 0)
        } finally {
          closeSync(fd)
        }
      
        if (buffer.slice(0, bytesRead).includes(0)) {
          const dotIdx = fullPath.lastIndexOf('.')
          const ext = dotIdx !== -1 ? fullPath.slice(dotIdx).toLowerCase() : ''
          const isImg = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp'].includes(ext)
          if (isImg) {
            return JSON.stringify({
              error: `Image file detected (${ext}): ${rawPath}. Cannot read image bytes with read_file.`,
              hint: `Use vision_analyze with image_url="${rawPath}" and question="..." to inspect this image.`
            })
          }
          return JSON.stringify({ error: `Binary file detected: ${rawPath}` })
        }
      } catch (err: any) {
        return JSON.stringify({ error: `Cannot stat file: ${err.message}` })
      }

      try {
        const fileContent = readFileSync(fullPath, 'utf-8')
        const allLines = fileContent.split('\n')
        const offset = Math.max(1, Number(args.offset) || 1)
        const limit = Math.max(0, Math.min(2000, Number(args.limit) || 2000))

        const startIdx = offset - 1
        const sliceLines = allLines.slice(startIdx, startIdx + limit)
        const maxChars = 100_000
        const maxLineChars = 50_000

        let charCount = 0
        let truncated = false
        const keptLines: string[] = []

        for (let i = 0; i < sliceLines.length; i++) {
          const lineNum = offset + i
          let lineContent = sliceLines[i]
          let lineTruncated = false
        
          if (lineContent.length > maxLineChars) {
            lineContent = lineContent.slice(0, maxLineChars) + '... [line truncated]'
            lineTruncated = true
          }
        
          const formattedLine = `${lineNum}|${lineContent}`
          if (charCount + formattedLine.length + 1 > maxChars) {
            truncated = true
            break
          }
          keptLines.push(formattedLine)
          charCount += formattedLine.length + 1
          if (lineTruncated) {
            truncated = true
          }
        }

        const result: Record<string, any> = {
          content: keptLines.join('\n'),
          total_lines: allLines.length,
          offset,
          limit,
          // Lets the agent pass expected_hash to patch and detect a concurrent edit.
          sha256: createHash('sha256').update(fileContent).digest('hex')
        }

        if (truncated) {
          result.truncated = true
          const nextOff = offset + Math.max(1, keptLines.length)
          result.next_offset = nextOff
          result.hint = `Output truncated at 100K char limit after ${keptLines.length} lines. Use offset=${nextOff} to continue.`
        } else {
          recordFileRead(context, fullPath, fileContent, allLines.length, offset, keptLines.length)
        }

        return JSON.stringify(result)
      } catch (err: any) {
        return JSON.stringify({ error: err.message || 'Failed to read file' })
      }
    }
  })

  // 2. write_file
  const writeFileSchema: ToolSchema = {
    name: 'write_file',
    description: "Write content to a file. Creates parent directories. Existing files require a complete prior read_file; use patch for targeted edits. Invalid JSON/YAML is rejected before writing. New TypeScript diagnostics are returned in lsp_diagnostics when a project tsconfig is available.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write (will be created if it does not exist)' },
        content: { type: 'string', description: 'Complete content to write to the file' }
      },
      required: ['path', 'content']
    }
  }

  registry.register({
    name: 'write_file',
    schema: writeFileSchema,
    toolset: 'file',
    handler: async (args, context) => {
      const basePath = context.workingDir || process.cwd()
      let rawPath = args.path as string
      if (rawPath.startsWith('~/')) {
        rawPath = join(homedir(), rawPath.slice(2))
      }
      const fullPath = isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath)
      const content = String(args.content ?? '')
      const syntaxError = validateStructuredFile(fullPath, content)
      if (syntaxError) return JSON.stringify({ error: syntaxError })
      const diagnosticsBefore = captureTypeScriptDiagnostics(fullPath, basePath)

      let destination = fullPath
      const createdFile = !existsSync(fullPath)
      let previousContent: string | null = ''
      let diffOmitted: string | undefined
      try {
        mkdirSync(dirname(fullPath), { recursive: true })
        if (existsSync(fullPath) && lstatSync(fullPath).isSymbolicLink()) destination = realpathSync(fullPath)
        if (existsSync(destination)) {
          const info = statSync(destination)
          if (!info.isFile()) return JSON.stringify({ error: 'Refusing to overwrite a non-regular file.' })
          if (info.size > 10 * 1024 * 1024) return JSON.stringify({ error: 'Refusing to overwrite a file over 10 MB; use a targeted patch or reduce it first.' })
          const previous = readFileSync(destination)
          if (previous.includes(0)) return JSON.stringify({ error: 'Refusing to overwrite binary file; read_file cannot verify its contents.' })
          const previousText = previous.toString('utf-8')
          const readStatus = fileReadStatus(context, destination, previousText)
          if (readStatus === 'unread') return JSON.stringify({ error: 'Refusing to overwrite existing file: read it with read_file first.' })
          if (readStatus === 'stale') return JSON.stringify({ error: 'File changed since read_file; read the current version again before writing.' })
          // A partial read still proves the content we hold matches disk (hash + line count), and an
          // overwrite replaces the whole file deliberately — no full read is required.
          if (info.size > 1_000_000) {
            diffOmitted = 'Diff omitted: existing file exceeds 1 MB.'
            previousContent = null
          } else previousContent = previousText
        } else {
          previousContent = ''
        }
      } catch (err: any) { return JSON.stringify({ error: err.message || 'Failed to resolve file path' }) }
      const tempPath = `${destination}.tmp-${process.pid}`
      try {
        snapshotBeforeWrite(context, destination)
        const mode = existsSync(destination) ? statSync(destination).mode : undefined
        writeFileSync(tempPath, content, { encoding: 'utf-8', mode })
        if (mode !== undefined) chmodSafe(tempPath, mode)
        renameSync(tempPath, destination)
        const verified = readFileSync(destination, 'utf-8') === content
        if (!verified) return JSON.stringify({ error: 'Write verification failed' })
        recordWrittenFile(context, destination, content)
        const lspDiagnostics = newTypeScriptDiagnostics(diagnosticsBefore, captureTypeScriptDiagnostics(fullPath, basePath))
        const fileDiff = previousContent !== null && previousContent !== content
          ? generateUnifiedFileDiff(previousContent, content, relative(basePath, fullPath) || basename(fullPath))
          : undefined
        const diffPreview = fileDiff ? previewDiff(fileDiff) : undefined
        return JSON.stringify({
          success: true,
          path: fullPath,
          created: createdFile,
          bytes_written: Buffer.byteLength(content, 'utf-8'),
          verified,
          ...(lspDiagnostics ? { lsp_diagnostics: lspDiagnostics } : {}),
          ...(diffPreview ? { diff: diffPreview.diff } : {}),
          ...(diffPreview?.omittedLines
            ? { diff_truncated: true, diff_omitted_lines: diffPreview.omittedLines }
            : previousContent === content
              ? { diff_omitted: 'Diff omitted: file content is unchanged.' }
              : diffOmitted ? { diff_omitted: diffOmitted } : {})
        })
      } catch (err: any) {
        try { unlinkSync(tempPath) } catch {}
        return JSON.stringify({ error: err.message || 'Failed to write file' })
      }
    }
  })

  // 3. patch
  const patchSchema: ToolSchema = {
    name: 'patch',
    description: "Targeted find-and-replace edits in files. Read the complete current file with read_file first; patch refuses unread, partial, or stale file state. Uses conservative exact/normalized matching, verifies the persisted result, and returns a file-context unified diff.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique unless replace_all=true.' },
        new_string: { type: 'string', description: 'Changed replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring a unique match (default: false)' },
        expected_hash: { type: 'string', description: 'Optional sha256 returned by read_file. When set, the patch is refused if the file changed since that read — use it when another agent may edit the same file.' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  }

  registry.register({
    name: 'patch',
    schema: patchSchema,
    toolset: 'file',
    handler: async (args, context) => {
      const basePath = context.workingDir || process.cwd()
      let rawPath = args.path as string
      if (rawPath.startsWith('~/')) {
        rawPath = join(homedir(), rawPath.slice(2))
      }
      const fullPath = isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath)

      if (!existsSync(fullPath)) {
        return JSON.stringify({ error: `File not found: ${rawPath}` })
      }

      try {
        const bytes = readFileSync(fullPath)
        if (bytes.includes(0)) return JSON.stringify({ error: 'Cannot patch binary file' })
        const content = bytes.toString('utf-8')
        const expectedHash = typeof args.expected_hash === 'string' ? args.expected_hash.trim().toLowerCase() : ''
        if (expectedHash) {
          const actualHash = createHash('sha256').update(content).digest('hex')
          if (actualHash !== expectedHash) {
            return JSON.stringify({
              error: 'File changed since read: expected_hash does not match. Read the file again and retry.',
              expected_hash: expectedHash,
              actual_hash: actualHash
            })
          }
        }
        const readStatus = fileReadStatus(context, fullPath, content)
        if (readStatus === 'unread') return JSON.stringify({ error: 'Refusing to patch existing file: read it with read_file first.' })
        if (readStatus === 'stale') return JSON.stringify({ error: 'File changed since read_file; read the current version again before patching.' })
        const diagnosticsBefore = captureTypeScriptDiagnostics(fullPath, basePath)
        const oldString = String(args.old_string ?? '')
        const newString = String(args.new_string ?? '')
        const replaceAll = isTruthy(args.replace_all)
        if (readStatus === 'partial') {
          // A partial read is enough when the hash still matches disk and the target is unambiguous:
          // the edit cannot land on text the model has not seen, and it can only match one place.
          const occurrences = oldString ? content.split(oldString).length - 1 : 0
          if (!oldString || (!replaceAll && occurrences !== 1)) {
            return JSON.stringify({ error: 'Refusing to patch: read the complete current file with read_file first (a partial read is accepted only when old_string matches exactly once).' })
          }
        }

        const result = fuzzyReplace(content, oldString, newString, replaceAll)
        const syntaxError = validateStructuredFile(fullPath, result.content)
        if (syntaxError) return JSON.stringify({ error: syntaxError })
        const tempPath = `${fullPath}.tmp-${process.pid}`
        const backupPath = `${fullPath}.backup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const originalMode = statSync(fullPath).mode
        try {
          snapshotBeforeWrite(context, fullPath)
          writeFileSync(tempPath, result.content, { encoding: 'utf-8', mode: originalMode })
          chmodSafe(tempPath, originalMode)
          renameSync(fullPath, backupPath)
          try {
            renameSync(tempPath, fullPath)
            if (readFileSync(fullPath, 'utf-8') !== result.content) throw new Error('Post-write verification failed: on-disk content differs from intended patch.')
            unlinkSync(backupPath)
          } catch (err) {
            try { unlinkSync(fullPath) } catch {}
            renameSync(backupPath, fullPath)
            throw err
          }
        } catch (err) {
          try { unlinkSync(tempPath) } catch {}
          throw err
        }
        recordWrittenFile(context, fullPath, result.content)
        const lspDiagnostics = newTypeScriptDiagnostics(diagnosticsBefore, captureTypeScriptDiagnostics(fullPath, basePath))
        const diff = generateUnifiedFileDiff(content, result.content, relative(basePath, fullPath) || basename(fullPath))

        return JSON.stringify({
          success: true,
          path: fullPath,
          verified: true,
          strategy: result.strategy,
          diff,
          ...(lspDiagnostics ? { lsp_diagnostics: lspDiagnostics } : {})
        })
      } catch (err: any) {
        return JSON.stringify({ error: err.message || 'Failed to patch file' })
      }
    }
  })

  // 4. search_files
  const searchFilesSchema: ToolSchema = {
    name: 'search_files',
    description: "Search file contents or find files by name. Use this instead of grep/find/ls in terminal.\nContent search (target='content'): Regex search inside files.\nFile search (target='files'): Find files by glob/name pattern.",
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Regex pattern for content search, or glob pattern (e.g., '*.py') for file search" },
        target: { type: 'string', enum: ['content', 'files'], description: "'content' searches inside file contents, 'files' searches for files by name", default: 'content' },
        path: { type: 'string', description: 'Directory or file to search in (default: current working directory)', default: '.' },
        file_glob: { type: 'string', description: "Filter files by pattern in grep mode (e.g., '*.py')" },
        limit: { type: 'integer', description: 'Maximum number of results to return (default: 50)', default: 50 },
        offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)', default: 0 }
      },
      required: ['pattern']
    }
  }

  registry.register({
    name: 'search_files',
    schema: searchFilesSchema,
    toolset: 'file',
    parallelSafe: true,
    handler: async (args, context) => {
      const basePath = context.workingDir || process.cwd()
      let searchDir = String(args.path || '.')
      if (searchDir.startsWith('~/')) {
        searchDir = join(homedir(), searchDir.slice(2))
      }
      const fullSearchDir = isAbsolute(searchDir) ? searchDir : resolve(basePath, searchDir)
      const target = (args.target || 'content') as 'content' | 'files'
      const pattern = String(args.pattern || '')
      const limit = Math.max(0, Math.min(200, Number(args.limit) || 50))
      const offset = Math.max(0, Number(args.offset) || 0)

      if (!existsSync(fullSearchDir)) {
        return JSON.stringify({ error: `Directory not found: ${searchDir}` })
      }

      // A single-file path must be searched directly: walking readdirSync on a file
      // throws and was silently swallowed, returning zero matches.
      if (statSync(fullSearchDir).isFile()) {
        const fileTarget = fullSearchDir
        if (target === 'files') {
          const globReg = globToRegex(pattern)
          const hit = globReg.test(basename(fileTarget)) || globReg.test(relative(dirname(fileTarget), fileTarget))
          return JSON.stringify({ files: hit ? [fileTarget] : [], total_count: hit ? 1 : 0, truncated: false })
        }
        let fileRegex: RegExp
        try {
          fileRegex = new RegExp(pattern, 'i')
        } catch {
          fileRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        }
        const fileMatches: Array<{ file: string; line: number; content: string }> = []
        try {
          for (const [idx, lineText] of readFileSync(fileTarget, 'utf-8').split('\n').entries()) {
            if (fileRegex.test(lineText)) {
              fileMatches.push({ file: fileTarget, line: idx + 1, content: lineText.slice(0, 300) })
              if (fileMatches.length >= offset + limit) break
            }
          }
        } catch {}
        return JSON.stringify({
          matches: fileMatches.slice(offset, offset + limit),
          total_count: fileMatches.length,
          truncated: fileMatches.length > offset + limit
        })
      }

      if (target === 'files') {
        const foundFiles: string[] = []
        const regex = globToRegex(pattern)

        function walk(dir: string) {
          if (foundFiles.length >= offset + limit + 1) return
          try {
            const entries = readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
              if (foundFiles.length >= offset + limit + 1) return
              const skipDirs = ['.git', 'node_modules', 'dist', 'build', '.next']
              if (entry.isDirectory() && skipDirs.includes(entry.name)) continue
            
              const subPath = join(dir, entry.name)
              if (entry.isDirectory()) {
                walk(subPath)
              } else if (entry.isFile()) {
                if (regex.test(entry.name) || regex.test(relative(fullSearchDir, subPath))) {
                  foundFiles.push(subPath)
                }
              }
            }
          } catch {}
        }

        walk(fullSearchDir)
        const paged = foundFiles.slice(offset, offset + limit)
        return JSON.stringify({
          files: paged,
          total_count: foundFiles.length,
          truncated: foundFiles.length > offset + limit
        })
      }

      const contentMatches: Array<{ file: string; line: number; content: string }> = []
      let regex: RegExp
      try {
        regex = new RegExp(pattern, 'i')
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }

      function searchDirContents(dir: string) {
        if (contentMatches.length >= offset + limit) return
        try {
          const entries = readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (contentMatches.length >= offset + limit) return
            const skipDirs = ['.git', 'node_modules', 'dist', 'build', '.next']
            if (entry.isDirectory() && skipDirs.includes(entry.name)) continue
          
            const subPath = join(dir, entry.name)
            if (entry.isDirectory()) {
              searchDirContents(subPath)
            } else if (entry.isFile()) {
              const skipExts = ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mkv', '.zip', '.tar', '.gz', '.bin', '.exe', '.so', '.dylib', '.iso', '.pdf', '.woff', '.woff2', '.ttf', '.pyc', '.wasm']
              const dotIdx = entry.name.lastIndexOf('.')
              const ext = dotIdx !== -1 ? entry.name.slice(dotIdx).toLowerCase() : ''
              if (skipExts.includes(ext)) continue

              if (args.file_glob) {
                const globReg = globToRegex(String(args.file_glob))
                if (!globReg.test(entry.name)) continue
              }
              try {
                const st = statSync(subPath)
                if (st.size > 2 * 1024 * 1024) continue // Skip files > 2MB in recursive content search
                const fileText = readFileSync(subPath, 'utf-8')
                const lines = fileText.split('\n')
                for (let idx = 0; idx < lines.length; idx++) {
                  if (regex.test(lines[idx])) {
                    contentMatches.push({
                      file: subPath,
                      line: idx + 1,
                      content: lines[idx].slice(0, 300)
                    })
                    if (contentMatches.length >= offset + limit) break
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }

      searchDirContents(fullSearchDir)
      const paged = contentMatches.slice(offset, offset + limit)
      return JSON.stringify({
        matches: paged,
        total_count: contentMatches.length,
        truncated: contentMatches.length > offset + limit
      })
    }
  })

}

export function registerPatchTools(): void {
  const patchBatchSchema: ToolSchema = {
    name: 'patch_batch', description: 'Atomically apply targeted fuzzy replacements across multiple files. Preflights every file before writing.',
    parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: {
      path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' }
    }, required: ['path', 'old_string', 'new_string'] } } }, required: ['files'] }
  }
  registry.register({ name: 'patch_batch', schema: patchBatchSchema, toolset: 'file', handler: async (args, context) =>
    JSON.stringify(applyPatchBatch(args.files, context.workingDir || process.cwd(), context))
  })

  const applyPatchSchema: ToolSchema = {
    name: 'apply_patch', description: 'Apply V4A multi-file patches with Update, Add, and Delete File sections; supports contextual @@ hunks.',
    parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] }
  }
  registry.register({ name: 'apply_patch', schema: applyPatchSchema, toolset: 'file', handler: async (args, context) =>
    JSON.stringify(applyV4APatch(String(args.patch || ''), context.workingDir || process.cwd(), context))
  })

}

function applyV4APatch(text: string, baseDir: string, context: ToolContext): Record<string, unknown> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return { error: 'Invalid V4A patch envelope' }
  type V4AEdit = { path: string; operation: 'update' | 'add' | 'delete'; original?: string; current?: string }
  const edits = new Map<string, V4AEdit>()
  let active: V4AEdit | null = null
  let hunk: string[] = []
  const applyHunk = () => {
    if (!active || !hunk.length) return
    if (active.operation !== 'update') throw new Error('Only Update File sections may contain @@ hunks')
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk) {
      if (line.startsWith(' ') || line.startsWith('-')) oldLines.push(line.slice(1))
      if (line.startsWith(' ') || line.startsWith('+')) newLines.push(line.slice(1))
    }
    const fileLines = (active.current || '').split('\n')
    let matches = -1
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      if (oldLines.every((line, j) => fileLines[i + j] === line)) {
        if (matches !== -1) throw new Error('Patch hunk matches more than once; add context lines')
        matches = i
      }
    }
    if (matches < 0) throw new Error('Patch hunk context not found')
    fileLines.splice(matches, oldLines.length, ...newLines)
    active.current = fileLines.join('\n')
    hunk = []
  }
  const finalize = () => { applyHunk(); active = null }
  try {
    for (let i = 1; i < lines.length - 1; i++) {
      const line = lines[i]
      const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line)
      if (header) {
        finalize()
        let rawPath = header[2]
        if (rawPath.startsWith('~/')) rawPath = join(homedir(), rawPath.slice(2))
        const path = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath)
        if (edits.has(path)) throw new Error(`Duplicate file section: ${rawPath}`)
        const operation = header[1].toLowerCase() as V4AEdit['operation']
        active = { path, operation }
        if (operation !== 'add') {
          const original = readFileSync(path, 'utf8')
          active.original = original
          if (operation === 'update') active.current = original
        }
        edits.set(path, active)
      } else if (line === '*** End of File') {
        continue
      } else if (line.startsWith('@@')) {
        if (!active || active.operation !== 'update') throw new Error('Unexpected @@ outside Update File section')
        applyHunk()
      } else {
        if (!active) throw new Error(`Unexpected patch line: ${line}`)
        if (active.operation === 'add') {
          if (!line.startsWith('+')) throw new Error('Add File contents must use + lines')
          active.current = active.current === undefined ? line.slice(1) : `${active.current}\n${line.slice(1)}`
        } else if (active.operation === 'update') {
          if (![' ', '+', '-'].includes(line[0])) throw new Error(`Invalid hunk line: ${line}`)
          hunk.push(line)
        } else {
          throw new Error('Delete File section cannot contain content')
        }
      }
    }
    finalize()
    if (!edits.size) return { error: 'Patch contains no file operations' }
    const files = [...edits.values()].map(edit => ({ path: edit.path, operation: edit.operation, old_string: edit.original, new_string: edit.current }))
    const result = applyPatchBatch(files, baseDir, context)
    if (!result.success) return result
    const diffs = [...edits.values()].map(edit => {
      const path = relative(baseDir, edit.path) || basename(edit.path)
      if (edit.operation === 'delete') return generateUnifiedFileDiff(edit.original || '', '', path)
      if (edit.operation === 'add') return generateUnifiedFileDiff('', edit.current || '', path)
      return generateUnifiedFileDiff(edit.original || '', edit.current || '', path)
    })
    const diff = diffs.join('\n')
    const maxChars = 20_000
    if (diff.length > maxChars) return { ...result, diff: `${diff.slice(0, maxChars)}\n... diff truncated`, diff_truncated: true }
    return { ...result, diff }
  } catch (err: any) {
    return { error: err.message || 'V4A patch failed; no files were changed.' }
  }
}

function applyPatchBatch(files: any, baseDir: string, context: ToolContext): Record<string, unknown> {
  if (!Array.isArray(files) || files.length < 1 || files.length > 20) return { error: 'files must contain 1–20 edits' }
  type StagedEdit = { path: string; temp: string; backup: string; operation: 'update' | 'add' | 'delete'; before: Buffer | null; after: string | null; mode: number; diff: string; originalMoved: boolean; newInstalled: boolean }
  const seen = new Set<string>()
  const staged: StagedEdit[] = []
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    for (let i = 0; i < files.length; i++) {
      const edit = files[i]
      let rawPath = String(edit.path || '')
      if (rawPath.startsWith('~/')) rawPath = join(homedir(), rawPath.slice(2))
      const path = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath)
      if (seen.has(path)) throw new Error(`Duplicate path in batch: ${rawPath}`)
      seen.add(path)
      const operation = (edit.operation || 'update') as StagedEdit['operation']
      if (!['update', 'add', 'delete'].includes(operation)) throw new Error(`Unsupported file operation: ${operation}`)
      const temp = `${path}.batch-${suffix}-${i}.tmp`
      const backup = `${path}.batch-${suffix}-${i}.original`
      if (operation === 'add') {
        try { lstatSync(path); throw new Error(`Add File target already exists: ${rawPath}`) }
        catch (err: any) { if (err.code !== 'ENOENT') throw err }
        if (!statSync(dirname(path)).isDirectory()) throw new Error(`Parent directory is not a directory: ${dirname(path)}`)
        const after = String(edit.new_string ?? '')
        const syntaxError = validateStructuredFile(path, after)
        if (syntaxError) throw new Error(syntaxError)
        staged.push({ path, temp, backup, operation, before: null, after, mode: 0o666 & ~process.umask(), diff: `+++ ${rawPath}\n${after}`, originalMoved: false, newInstalled: false })
        continue
      }
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-regular file: ${rawPath}`)
      if (info.size > 10 * 1024 * 1024) throw new Error(`Refusing file over 10 MB: ${rawPath}`)
      const before = readFileSync(path)
      if (before.includes(0)) throw new Error(`Cannot patch binary file: ${rawPath}`)
      const oldText = before.toString('utf8')
      if (operation === 'delete') {
        staged.push({ path, temp, backup, operation, before, after: null, mode: info.mode & 0o7777, diff: `--- ${rawPath}\n(deleted)`, originalMoved: false, newInstalled: false })
      } else {
        const result = fuzzyReplace(oldText, String(edit.old_string ?? ''), String(edit.new_string ?? ''), isTruthy(edit.replace_all))
        const syntaxError = validateStructuredFile(path, result.content)
        if (syntaxError) throw new Error(syntaxError)
        staged.push({ path, temp, backup, operation, before, after: result.content, mode: info.mode & 0o7777, diff: result.diff, originalMoved: false, newInstalled: false })
      }
    }
    for (const item of staged) {
      if (item.after === null) continue
      writeFileSync(item.temp, item.after, { encoding: 'utf8', mode: item.mode })
      chmodSafe(item.temp, item.mode)
    }
    for (const item of staged) snapshotBeforeWrite(context, item.path)
    try {
      for (const item of staged) {
        if (item.before !== null) { renameSync(item.path, item.backup); item.originalMoved = true }
        if (item.after !== null) { renameSync(item.temp, item.path); item.newInstalled = true }
      }
      for (const item of staged) {
        if (item.after !== null && readFileSync(item.path, 'utf8') !== item.after) throw new Error(`Post-write verification failed for ${item.path}`)
      }
    } catch (err) {
      for (const item of [...staged].reverse()) {
        if (item.newInstalled) try { unlinkSync(item.path) } catch {}
        if (item.originalMoved) try { renameSync(item.backup, item.path) } catch {}
      }
      throw err
    }
    for (const item of staged) {
      if (item.originalMoved) try { unlinkSync(item.backup) } catch {}
      if (item.after !== null) recordWrittenFile(context, item.path, item.after)
    }
    return { success: true, verified: true, files: staged.map(item => ({ path: item.path, operation: item.operation })) }
  } catch (err: any) {
    for (const item of staged) {
      try { unlinkSync(item.temp) } catch {}
      if (item.originalMoved && existsSync(item.backup) && !existsSync(item.path)) try { renameSync(item.backup, item.path) } catch {}
    }
    return { error: err.message || 'Batch patch failed; no files were changed.' }
  }
}

/**
 * `list_dir` — structured directory listing so the agent does not have to shell out
 * to `ls`/`find` just to orient itself. Read-only and parallel-safe.
 */
export function registerListTools(): void {
  const schema: ToolSchema = {
    name: 'list_dir',
    description: "List a directory (directories first, then files) without a shell. Optional glob filter, optional recursion with a depth cap. Hidden entries are included unless include_hidden=false.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (or single file) to list (default: current working directory)', default: '.' },
        pattern: { type: 'string', description: "Glob filter applied to entry names, e.g. '*.ts'" },
        recursive: { type: 'boolean', description: 'Walk subdirectories (default: false)', default: false },
        depth: { type: 'integer', description: 'Maximum recursion depth (default: 2)', default: 2 },
        include_hidden: { type: 'boolean', description: 'Include entries starting with a dot (default: true)', default: true },
        limit: { type: 'integer', description: 'Maximum entries to return (default: 200)', default: 200 }
      },
      required: []
    }
  }

  registry.register({
    name: 'list_dir',
    schema,
    toolset: 'file',
    parallelSafe: true,
    handler: async (args, context) => {
      const basePath = context.workingDir || process.cwd()
      let rawPath = String(args.path || '.')
      if (rawPath.startsWith('~/')) rawPath = join(homedir(), rawPath.slice(2))
      const target = isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath)
      const limit = Math.max(1, Math.min(1000, Number(args.limit) || 200))
      const maxDepth = Math.max(0, Math.min(8, Number(args.depth) || 2))
      const includeHidden = args.include_hidden !== false
      const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? globToRegex(args.pattern.trim()) : null
      const skipDirs = ['.git', 'node_modules', 'dist', 'build', '.next']

      let stats
      try { stats = statSync(target) } catch { return JSON.stringify({ error: `Path not found: ${rawPath}` }) }

      type Entry = { name: string; path: string; type: 'file' | 'dir'; size?: number }
      const entries: Entry[] = []
      let truncated = false

      const accept = (name: string) => (includeHidden || !name.startsWith('.')) && (!pattern || pattern.test(name))
      const push = (full: string, name: string, type: 'file' | 'dir', size?: number) => {
        if (entries.length >= limit) { truncated = true; return }
        entries.push({ name, path: full, type, ...(size === undefined ? {} : { size }) })
      }

      const walk = (dir: string, depth: number) => {
        if (entries.length >= limit) { truncated = true; return }
        let names: string[]
        try { names = readdirSync(dir) } catch { return }
        for (const name of names.sort()) {
          if (entries.length >= limit) { truncated = true; return }
          const full = join(dir, name)
          let info
          try { info = lstatSync(full) } catch { continue }
          const isDir = info.isDirectory()
          if (isDir && skipDirs.includes(name)) continue
          if (!accept(name)) continue
          push(full, name, isDir ? 'dir' : 'file', isDir ? undefined : info.size)
          if (isDir && args.recursive === true && depth < maxDepth) walk(full, depth + 1)
        }
      }

      if (stats.isFile()) {
        const name = basename(target)
        if (accept(name)) push(target, name, 'file', stats.size)
      } else {
        walk(target, 0)
      }

      // Directories first, then files, each alphabetically — stable for diffing.
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      return JSON.stringify({ path: target, entries, total: entries.length, truncated })
    }
  })
}

