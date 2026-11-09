// --- Fuzzy match and patch logic (9 strategies) ---
const UNICODE_MAP: Record<string, string> = {
  '\u201c': '"', '\u201d': '"',
  '\u2018': "'", '\u2019': "'",
  '\u2014': '--', '\u2013': '-',
  '\u2026': '...', '\u00a0': ' ',
  '\u2212': '-'
}

function normalizeUnicode(text: string): string {
  let res = text
  for (const [k, v] of Object.entries(UNICODE_MAP)) {
    res = res.replaceAll(k, v)
  }
  return res
}

function countOccurrences(content: string, searchStr: string): number {
  if (!searchStr) return 0
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(searchStr, pos)) !== -1) {
    count++
    pos += searchStr.length
  }
  return count
}

function applyReplace(content: string, block: string, newString: string, replaceAll: boolean): string {
  const sourceIndent = block.split('\n').find(line => line.trim())?.match(/^\s*/)?.[0] || ''
  const replacementIndent = newString.split('\n').find(line => line.trim())?.match(/^\s*/)?.[0] || ''
  const indentDelta = sourceIndent.length - replacementIndent.length
  const replacement = indentDelta > 0
    ? newString.split('\n').map(line => line.trim() ? ' '.repeat(indentDelta) + line : line).join('\n')
    : newString
  if (replaceAll) return content.split(block).join(replacement)
  const idx = content.indexOf(block)
  if (idx === -1) return content
  return content.slice(0, idx) + replacement + content.slice(idx + block.length)
}

export function unescapeString(text: string): string {
  return text
    .replace(/(?<!\\)\\n/g, '\n')
    .replace(/(?<!\\)\\r/g, '\r')
    .replace(/(?<!\\)\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
}

export function fuzzyReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
): { content: string; diff: string; strategy: string } {
  // BUG-03: Reject empty old_string
  if (!oldString) {
    throw new Error('old_string must not be empty')
  }
  
  if (oldString === newString) {
    throw new Error('No edit applied: old_string and new_string are identical.')
  }

  // Strategy 1: Exact match
  if (content.includes(oldString)) {
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count > 1) {
        throw new Error(`Found ${count} exact matches. Add more context to old_string or use replace_all=true`)
      }
    }
    const updated = applyReplace(content, oldString, newString, replaceAll)
    return { content: updated, diff: generateDiff(oldString, newString), strategy: 'exact' }
  }

  // Strategy 2: Line trimmed match
  const contentLines = content.split('\n')
  const oldLines = oldString.split('\n')
  const oldTrimmed = oldLines.map(l => l.trim()).join('\n')

  const matches2: string[] = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const windowTrimmed = contentLines.slice(i, i + oldLines.length).map(l => l.trim()).join('\n')
    if (windowTrimmed === oldTrimmed) {
      matches2.push(contentLines.slice(i, i + oldLines.length).join('\n'))
    }
  }
  if (matches2.length > 0) {
    if (!replaceAll && matches2.length > 1) {
      throw new Error(`Found ${matches2.length} line-trimmed matches. Add more context to old_string or use replace_all=true`)
    }
    const matchedBlock = matches2[0]
    const updated = applyReplace(content, matchedBlock, newString, replaceAll)
    return { content: updated, diff: generateDiff(matchedBlock, newString), strategy: 'line_trimmed' }
  }

  // Strategy 3: Whitespace normalized
  const collapseWs = (s: string) => s.replace(/[ \t]+/g, ' ')
  const oldWs = collapseWs(oldString)
  const matches3: string[] = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const windowLines = contentLines.slice(i, i + oldLines.length)
    const windowWs = collapseWs(windowLines.join('\n'))
    if (windowWs === oldWs) {
      matches3.push(windowLines.join('\n'))
    }
  }
  if (matches3.length > 0) {
    if (!replaceAll && matches3.length > 1) {
      throw new Error(`Found ${matches3.length} whitespace-normalized matches. Add more context to old_string or use replace_all=true`)
    }
    const matchedBlock = matches3[0]
    const updated = applyReplace(content, matchedBlock, newString, replaceAll)
    return { content: updated, diff: generateDiff(matchedBlock, newString), strategy: 'whitespace_normalized' }
  }

  // Strategy 4: Indentation flexible
  const stripIndent = (lines: string[]) => {
    const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)?.[0].length || 0))
    return lines.map(l => l.slice(minIndent)).join('\n')
  }
  const oldDedented = stripIndent(oldLines)
  const matches4: string[] = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const windowLines = contentLines.slice(i, i + oldLines.length)
    if (stripIndent(windowLines) === oldDedented) {
      matches4.push(windowLines.join('\n'))
    }
  }
  if (matches4.length > 0) {
    if (!replaceAll && matches4.length > 1) {
      throw new Error(`Found ${matches4.length} indentation-flexible matches. Add more context to old_string or use replace_all=true`)
    }
    const matchedBlock = matches4[0]
    const sourceIndent = matchedBlock.split('\n').find(l => l.trim())?.match(/^\s*/)?.[0] || ''
    const replacement = newString.split('\n').map((line, i) => i === 0 || !line.trim() ? line : sourceIndent + line).join('\n')
    const updated = applyReplace(content, matchedBlock, replacement, replaceAll)
    return { content: updated, diff: generateDiff(matchedBlock, replacement), strategy: 'indentation_flexible' }
  }

  // Strategy 5: Escape normalized
  const oldUnescaped = unescapeString(oldString)
  if (content.includes(oldUnescaped)) {
    if (!replaceAll) {
      const count = countOccurrences(content, oldUnescaped)
      if (count > 1) {
        throw new Error(`Found ${count} escape-normalized matches. Add more context to old_string or use replace_all=true`)
      }
    }
    const updated = applyReplace(content, oldUnescaped, newString, replaceAll)
    return { content: updated, diff: generateDiff(oldUnescaped, newString), strategy: 'escape_normalized' }
  }

  // Strategy 6: Trimmed boundary
  if (oldLines.length > 2) {
    const boundaryTrimmedOld = [
      oldLines[0].trim(),
      ...oldLines.slice(1, -1),
      oldLines[oldLines.length - 1].trim()
    ].join('\n')
    const matches6: string[] = []
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const windowLines = contentLines.slice(i, i + oldLines.length)
      const windowTrimmed = [
        windowLines[0].trim(),
        ...windowLines.slice(1, -1),
        windowLines[windowLines.length - 1].trim()
      ].join('\n')
      if (windowTrimmed === boundaryTrimmedOld) {
        matches6.push(windowLines.join('\n'))
      }
    }
    if (matches6.length > 0) {
      if (!replaceAll && matches6.length > 1) {
        throw new Error(`Found ${matches6.length} trimmed-boundary matches. Add more context to old_string or use replace_all=true`)
      }
      const matchedBlock = matches6[0]
      const updated = applyReplace(content, matchedBlock, newString, replaceAll)
      return { content: updated, diff: generateDiff(matchedBlock, newString), strategy: 'trimmed_boundary' }
    }
  }

  // Strategy 7: Unicode normalized
  const normOldUnicode = normalizeUnicode(oldString)
  const normContentUnicode = normalizeUnicode(content)
  if (normContentUnicode.includes(normOldUnicode)) {
    if (!replaceAll) {
      const count = countOccurrences(normContentUnicode, normOldUnicode)
      if (count > 1) {
        throw new Error(`Found ${count} unicode-normalized matches. Add more context to old_string or use replace_all=true`)
      }
    }
    
    const ranges: Array<{ start: number; end: number }> = []
    let normalized = ''
    const boundaries = [0]
    for (let i = 0; i < content.length; i++) {
      normalized += normalizeUnicode(content[i])
      boundaries.push(normalized.length)
    }
    let from = 0
    while (from <= normalized.length - normOldUnicode.length) {
      const idx = normalized.indexOf(normOldUnicode, from)
      if (idx < 0) break
      const start = boundaries.findIndex((n, i) => n <= idx && boundaries[i + 1] > idx)
      let end = boundaries.findIndex(n => n >= idx + normOldUnicode.length)
      if (start >= 0 && end > start) ranges.push({ start, end })
      from = idx + Math.max(1, normOldUnicode.length)
    }
    const selected = replaceAll ? ranges : ranges.slice(0, 1)
    let updated = content
    for (const range of selected.reverse()) updated = updated.slice(0, range.start) + newString + updated.slice(range.end)
    const matchedBlock = content.slice(ranges[0].start, ranges[0].end)
    return { content: updated, diff: generateDiff(matchedBlock, newString), strategy: 'unicode_normalized' }
  }

  // Ponytail: reject ambiguous fuzzy blocks; exact/normalized matches remain supported.
  /*
  // Strategy 8: Block anchor
  if (oldLines.length >= 3) {
    const firstLine = oldLines[0].trim()
    const lastLine = oldLines[oldLines.length - 1].trim()
    const matches8: string[] = []
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      if (contentLines[i].trim() === firstLine && contentLines[i + oldLines.length - 1].trim() === lastLine) {
        matches8.push(contentLines.slice(i, i + oldLines.length).join('\n'))
      }
    }
    if (matches8.length > 0) {
      if (!replaceAll && matches8.length > 1) {
        throw new Error(`Found ${matches8.length} block-anchor matches. Add more context to old_string or use replace_all=true`)
      }
      const matchedBlock = matches8[0]
      const updated = applyReplace(content, matchedBlock, newString, replaceAll)
      return { content: updated, diff: generateDiff(matchedBlock, newString), strategy: 'block_anchor' }
    }
  }

  // Strategy 9: Context-aware similarity match
  let bestMatches: Array<{idx: number, score: number, block: string}> = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let matchedLines = 0
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() === oldLines[j].trim()) {
        matchedLines++
      }
    }
    const score = matchedLines / oldLines.length
    if (score >= 0.9) {
      bestMatches.push({
        idx: i,
        score,
        block: contentLines.slice(i, i + oldLines.length).join('\n')
      })
    }
  }

  if (bestMatches.length > 0) {
    if (!replaceAll && bestMatches.length > 1) {
      throw new Error(`Found ${bestMatches.length} similarity matches (≥90%). Add more context to old_string or use replace_all=true`)
    }
    const matchedBlock = bestMatches[0].block
    const updated = applyReplace(content, matchedBlock, newString, replaceAll)
    const warning = `Fuzzy match with ${Math.round(bestMatches[0].score * 100)}% similarity`
    return { 
      content: updated, 
      diff: generateDiff(matchedBlock, newString) + `\n\n[WARNING: ${warning}]`, 
      strategy: 'similarity_match' 
    }
  }
  */

  throw new Error(`Failed to find unique match for replacement after trying 9 matching strategies. Verify old_string exists in file.`)
}

export function generateDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const rows: string[] = []
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++
  const contextBefore = Math.min(3, prefix)
  const contextAfter = Math.min(3, suffix)
  const start = prefix - contextBefore
  const oldCount = contextBefore + (oldLines.length - prefix - suffix) + contextAfter
  const newCount = contextBefore + (newLines.length - prefix - suffix) + contextAfter
  rows.push(`@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`)
  rows.push(...oldLines.slice(start, prefix).map(line => ` ${line}`))
  rows.push(...oldLines.slice(prefix, oldLines.length - suffix).map(line => `-${line}`))
  rows.push(...newLines.slice(prefix, newLines.length - suffix).map(line => `+${line}`))
  rows.push(...oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + contextAfter).map(line => ` ${line}`))
  return rows.join('\n')
}

