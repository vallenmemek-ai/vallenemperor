import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync, realpathSync, unlinkSync, mkdtempSync, rmdirSync, renameSync, rmSync } from 'fs'
import { chmodSafe } from '../../core/platform'
import { resolve, join, dirname, relative, isAbsolute, sep, basename } from 'path'
import { registry, ToolSchema } from '../tools'
import { SkillLoader } from '../../skills/skills'
import { SkillStatsStore } from '../../skills/skill_stats'
import { ReviewLogStore, SkillHistoryStore } from '../../skills/skill_history'
import { getVallenHome } from '../../core/config'
import { validateSkillName, validateCategory } from '../../skills_hub'
import { fuzzyReplace } from '../../core/patch_engine'

export function registerSkillsTools(skillLoader?: SkillLoader): void {
  // 17. skills_list
  const skillsListSchema: ToolSchema = {
    name: 'skills_list',
    description: 'List available modular skills with their name, category, and description. Use skill_view(name) to load full content.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter to narrow results' }
      }
    }
  }

  registry.register({
    name: 'skills_list',
    schema: skillsListSchema,
    toolset: 'skills',
    parallelSafe: true,
    handler: async (args, context) => {
      const loader = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
      if (!loader) {
        return JSON.stringify([])
      }
      const category = args.category ? String(args.category).trim() : undefined
      const skills = category ? loader.listByCategory(category) : loader.list()
      const list = skills.map((s: any) => ({
        name: s.name,
        description: s.metadata?.description || '',
        category: s.metadata?.category || 'general'
      }))
      return JSON.stringify(list)
    }
  })

  // 18. skill_view
  const skillViewSchema: ToolSchema = {
    name: 'skill_view',
    description: 'Load full instructions and content of a skill, or access its linked files (references, templates, scripts). First call returns SKILL.md content plus linked_files list. To access linked file, call with file_path parameter.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name (see skills_list to browse available skills)' },
        file_path: { type: 'string', description: 'Optional relative path to a linked file within the skill (e.g., references/api.md)' }
      },
      required: ['name']
    }
  }

  registry.register({
    name: 'skill_view',
    schema: skillViewSchema,
    toolset: 'skills',
    parallelSafe: true,
    handler: async (args, context) => {
      const loader = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
      const name = String(args.name || '').trim()
      if (!name) {
        return JSON.stringify({ error: 'Skill name is required' })
      }
      if (!loader) {
        return JSON.stringify({ error: 'Skill loader not available' })
      }
      const skill = loader.get(name)
      if (!skill) {
        return JSON.stringify({ error: `Skill '${name}' not found. Use skills_list to see available skills.` })
      }
      try { new SkillStatsStore().recordView(skill.name, context?.sessionId) } catch {}

      const filePath = args.file_path ? String(args.file_path).trim() : ''
      if (context?.reviewMode && !filePath) context.reviewSkillsRead?.add(skill.name)
      if (filePath) {
        const skillBaseDir = realpathSync(dirname(skill.path))
        const linkedFullPath = resolve(skillBaseDir, filePath)
        const relPath = relative(skillBaseDir, linkedFullPath)
        if (!relPath || relPath.startsWith(`..${sep}`) || relPath === '..' || isAbsolute(relPath)) {
          return JSON.stringify({ error: `Linked file '${filePath}' escapes skill directory` })
        }
        let cursor = skillBaseDir
        for (const part of relPath.split(sep)) {
          cursor = join(cursor, part)
          if (!existsSync(cursor)) break
          if (lstatSync(cursor).isSymbolicLink()) return JSON.stringify({ error: `Linked file '${filePath}' cannot traverse symlinks` })
        }
        if (!existsSync(linkedFullPath)) {
          return JSON.stringify({ error: `Linked file '${filePath}' not found in skill '${name}'` })
        }
        try {
          const content = readFileSync(linkedFullPath, 'utf-8')
          return JSON.stringify({ name: skill.name, file_path: filePath, content })
        } catch (err: any) {
          return JSON.stringify({ error: `Failed to read linked file: ${err.message}` })
        }
      }

      return JSON.stringify({
        name: skill.name,
        description: skill.metadata?.description || '',
        category: skill.metadata?.category || 'general',
        content: skill.content,
        linked_files: skill.linkedFiles || {}
      })
    }
  })

  // 19. skill_manage - Install/uninstall/update skills from hub
  const skillManageSchema: ToolSchema = {
    name: 'skill_manage',
    description: 'Manage skills: search hub, install from GitHub/official sources, uninstall, or update. User approval required for install operations.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'install', 'uninstall', 'update', 'list_installed', 'stats', 'history', 'review_log', 'undo'],
          description: 'Action: search, install, uninstall, update, list_installed, stats, history, review_log, or undo a saved skill change'
        },
        query: {
          type: 'string',
          description: 'Search query (for action=search)'
        },
        identifier: {
          type: 'string',
          description: 'Skill identifier: GitHub URL, "official/category/name", or skill name'
        },
        name: {
          type: 'string',
          description: 'Skill name (for install override or uninstall/update)'
        },
        category: {
          type: 'string',
          description: 'Category for install (optional, e.g., "devops", "research")'
        },
        source: {
          type: 'string',
          description: 'Source filter for search: "official" or "github"'
        },
        entry_id: { type: 'string', description: 'Change ID to restore (action=undo)' },
        limit: { type: 'integer', description: 'Maximum records for history/log/stats views (1-100)' },
        operations: {
          type: 'array',
          description: 'Atomic batch operations: create, patch, delete, write_file, or remove_file',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'patch', 'delete', 'write_file', 'remove_file'] },
              name: { type: 'string' },
              category: { type: 'string' },
              content: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              file_path: { type: 'string' }
            },
            required: ['action', 'name']
          }
        }
      },
    }
  }

  registry.register({
    name: 'skill_manage',
    schema: skillManageSchema,
    toolset: 'skills',
    handler: async (args, context) => {
      if (context?.reviewMode) {
        if (Array.isArray(args.operations)) {
          for (const op of args.operations) {
            const action = String(op.action || '')
            const name = String(op.name || '')
            if (action === 'delete' || action === 'remove_file') return JSON.stringify({ error: `Review mode cannot perform destructive skill operation '${action}'.` })
            if (action !== 'create' && !context.reviewSkillsRead?.has(name)) return JSON.stringify({ error: `Read skill '${name}' with skill_view before review-mode write.` })
          }
        } else if (!['search', 'list_installed', 'stats', 'history', 'review_log'].includes(String(args.action || ''))) {
          return JSON.stringify({ error: `Review mode cannot perform skill action '${String(args.action || '')}'.` })
        }
      }
      // Hermes-style atomic batch operations
      if (args.operations && Array.isArray(args.operations)) {
        const ops = args.operations
        const loader = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
        const targetBaseDir = (loader as any)?.skillPaths?.[0] || join(getVallenHome(), 'skills')

        const results: any[] = []
        const undo: Array<() => void> = []
        const cleanupOnCommit: string[] = []
        const history = new SkillHistoryStore()
        const historyIds: string[] = []
        const stageHistory = (name: string, target: string, action: string, reason: string) => historyIds.push(history.stage(name, target, action, reason))
        const root = resolve(targetBaseDir)
        let failed: any = null
        for (let opIndex = 0; opIndex < ops.length; opIndex++) {
          const op = ops[opIndex]
          try {
          const opAction = String(op.action || '')
          const name = String(op.name || '').trim()
          if (!['create', 'patch', 'delete', 'write_file', 'remove_file'].includes(opAction)) throw new Error(`Unsupported operation '${opAction}'`)
          if (!name) throw new Error('Skill name is required for operation')

          if (opAction === 'create') {
            const category = validateCategory(op.category ? String(op.category).trim() : 'custom')
            const safeName = validateSkillName(name)
            const skillDir = resolve(root, category, safeName)
            stageHistory(safeName, skillDir, opAction, 'Created skill; undo removes it')
            const rel = relative(root, skillDir)
            if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Skill path escapes skills directory')
            if (existsSync(skillDir)) throw new Error('Skill already exists; refusing to overwrite')
            const parent = dirname(skillDir)
            if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('Skill category cannot be a symlink')
            const dirsToRemove: string[] = []
            for (let dir = skillDir; dir !== root && !existsSync(dir); dir = dirname(dir)) dirsToRemove.push(dir)
            const skillPath = join(skillDir, 'SKILL.md')
            undo.push(() => { if (existsSync(skillPath)) unlinkSync(skillPath); for (const dir of dirsToRemove) { try { rmdirSync(dir) } catch {} } })
            mkdirSync(skillDir, { recursive: true })
            const content = String(op.content || `---\nname: ${safeName}\ndescription: Custom skill\ncategory: ${category}\n---\n# ${safeName}\n`)
            writeFileSync(skillPath, content, 'utf-8')
            results.push({ action: 'create', name: safeName, path: skillPath, status: 'created' })
          } else if (opAction === 'patch') {
            const skill = loader?.get(name)
            if (!skill) throw new Error(`Skill '${name}' not found for patch`)
            stageHistory(name, dirname(skill.path), opAction, `Before ${opAction} operation`)
            const before = readFileSync(skill.path)
            const mode = statSync(skill.path).mode & 0o7777
            const patched = fuzzyReplace(before.toString('utf-8'), op.old_string || '', op.new_string || '', false)
            undo.push(() => { writeFileSync(skill.path, before); chmodSafe(skill.path, mode) })
            writeFileSync(skill.path, patched.content, 'utf-8')
            results.push({ action: 'patch', name, strategy: patched.strategy, status: 'patched' })
          } else if (opAction === 'delete') {
            const skill = loader?.get(name)
            if (!skill) throw new Error(`Skill '${name}' not found for delete`)
            const skillDir = resolve(dirname(skill.path))
            stageHistory(name, skillDir, opAction, `Before ${opAction} operation`)
            const rel = relative(root, skillDir)
            if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Skill path escapes skills directory')
            if (basename(skillDir) === 'skills' || lstatSync(skillDir).isSymbolicLink()) throw new Error('Refusing to delete invalid skill directory')
            const backupDir = mkdtempSync(join(root, '.skill-batch-'))
            const backupPath = join(backupDir, basename(skillDir))
            undo.push(() => { if (existsSync(backupPath)) renameSync(backupPath, skillDir) })
            cleanupOnCommit.push(backupDir)
            renameSync(skillDir, backupPath)
            results.push({ action: 'delete', name, status: 'deleted' })
          } else if (opAction === 'write_file') {
            const skill = loader?.get(name)
            if (!skill) throw new Error(`Skill '${name}' not found`)
            const skillDir = realpathSync(dirname(skill.path))
            stageHistory(name, skillDir, opAction, `Before ${opAction} operation`)
            const filePath = resolve(skillDir, String(op.file_path || ''))
            const rel = relative(skillDir, filePath)
            if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Skill file path escapes skill directory')
            let cursor = skillDir
            for (const part of rel.split(sep)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Skill file path cannot traverse symlinks') }
            if (existsSync(filePath) && !lstatSync(filePath).isFile()) throw new Error('Skill file target must be a regular file')
            const existed = existsSync(filePath)
            const before = existed ? readFileSync(filePath) : null
            const mode = existed ? statSync(filePath).mode & 0o7777 : 0o600
            const dirsToRemove: string[] = []
            for (let dir = dirname(filePath); dir !== skillDir && !existsSync(dir); dir = dirname(dir)) dirsToRemove.push(dir)
            undo.push(() => {
              if (existed) { writeFileSync(filePath, before!); chmodSafe(filePath, mode) }
              else if (existsSync(filePath)) unlinkSync(filePath)
              for (const dir of dirsToRemove) { try { rmdirSync(dir) } catch {} }
            })
            mkdirSync(dirname(filePath), { recursive: true })
            writeFileSync(filePath, String(op.content || ''), 'utf-8')
            results.push({ action: 'write_file', name, file_path: op.file_path, status: 'written' })
          } else if (opAction === 'remove_file') {
            const skill = loader?.get(name)
            if (!skill) throw new Error(`Skill '${name}' not found`)
            const skillDir = realpathSync(dirname(skill.path))
            stageHistory(name, skillDir, opAction, `Before ${opAction} operation`)
            const filePath = resolve(skillDir, String(op.file_path || ''))
            const rel = relative(skillDir, filePath)
            if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Skill file path escapes skill directory')
            let cursor = skillDir
            for (const part of rel.split(sep)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Skill file path cannot traverse symlinks') }
            if (existsSync(filePath)) {
              if (!lstatSync(filePath).isFile()) throw new Error('Skill file target must be a regular file')
              const before = readFileSync(filePath)
              const mode = statSync(filePath).mode & 0o7777
              undo.push(() => { writeFileSync(filePath, before); chmodSafe(filePath, mode) })
              unlinkSync(filePath)
            }
            results.push({ action: 'remove_file', name, file_path: op.file_path, status: 'removed' })
          }
          } catch (err: any) {
            failed = { action: op.action, name: op.name, status: 'error', error: err.message || String(err) }
            results.push(failed)
            break
          }
        }

        if (!failed) {
          try { loader?.load?.() }
          catch (err: any) { failed = { action: 'reload', status: 'error', error: err.message || String(err) }; results.push(failed) }
        }
        if (!failed) for (const id of historyIds) {
          try { history.commit(id) } catch (err: any) { failed = { action: 'history', status: 'error', error: err.message || String(err) }; results.push(failed); break }
        }
        if (!failed) for (const result of results) {
          if (['created', 'patched', 'deleted', 'written', 'removed'].includes(result.status)) {
            try { new SkillStatsStore().recordManage(String(result.name)) } catch {}
          }
        }
        const rollbackErrors: string[] = []
        if (failed) {
          for (const rollback of undo.reverse()) {
            try { rollback() } catch (err: any) { rollbackErrors.push(err.message || String(err)) }
          }
          for (const result of results) if (result.status !== 'error') result.status = 'rolled_back'
          for (let i = results.length; i < ops.length; i++) results.push({ action: ops[i].action, name: ops[i].name, status: 'skipped' })
          try { loader?.load?.() } catch (err: any) { rollbackErrors.push(`Skill reload failed: ${err.message || String(err)}`) }
          for (const id of historyIds) { try { history.abort(id) } catch (err: any) { rollbackErrors.push(`History cleanup failed: ${err.message || String(err)}`) } }
        } else {
          for (const dir of cleanupOnCommit) rmSync(dir, { recursive: true, force: true })
        }
        return JSON.stringify({ success: !failed, ...(failed ? { error: failed.error } : {}), ...(rollbackErrors.length ? { rollback_errors: rollbackErrors } : {}), message: `${failed ? 'Rolled back' : 'Applied'} ${ops.length} skill operations`, results })
      }

      const action = String(args.action || 'search')
      const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20
      if (action === 'stats') return JSON.stringify({ action, stats: new SkillStatsStore().list().slice(0, limit) })
      if (action === 'history') return JSON.stringify({ action, changes: new SkillHistoryStore().list(limit) })
      if (action === 'review_log') return JSON.stringify({ action, reviews: new ReviewLogStore().list(limit) })
      if (action === 'undo') {
        const entryId = String(args.entry_id || '').trim()
        if (!entryId) return JSON.stringify({ error: 'Missing required field: entry_id' })
        const loader = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
        const { getSkillsDir } = require('../../skills_hub')
        const allowedRoots = [...((loader as any)?.skillPaths || []), getSkillsDir()]
        return JSON.stringify({ action, ...new SkillHistoryStore().undo(entryId, allowedRoots) })
      }

      try {
        if (action === 'search') {
          const { searchSkills } = require('../../skills_hub')
          const query = String(args.query || '')
          const source = args.source ? String(args.source) : undefined
          const results = await searchSkills({ query, source, limit: 20 })
        
          return JSON.stringify({
            action: 'search',
            query,
            results: results.map((r: any) => ({
              name: r.name,
              identifier: r.identifier,
              description: r.description,
              source: r.source,
              trust_level: r.trust_level,
              install_command: r.install_command
            }))
          })
        }

        if (action === 'list_installed') {
          const { listInstalledSkills } = require('../../skills_hub')
          const installed = listInstalledSkills()
        
          return JSON.stringify({
            action: 'list_installed',
            skills: installed.map((s: any) => ({
              name: s.name,
              source: s.source,
              identifier: s.identifier,
              installed_at: s.installed_at,
              install_path: s.install_path
            }))
          })
        }

        if (action === 'install') {
          const identifier = String(args.identifier || '')
          if (!identifier) {
            return JSON.stringify({ error: 'Missing required field: identifier' })
          }

          // Parse identifier
          const { parseSkillIdentifier } = require('../../skills_hub')
          const parsed = parseSkillIdentifier(identifier)

          // Fetch bundle
          const { fetchGitHubSkill, fetchOfficialSkill } = require('../../skills_hub')
          let bundle

          if (parsed.source === 'github' && parsed.url) {
            bundle = await fetchGitHubSkill(parsed.url)
          } else if (parsed.source === 'official' && parsed.category) {
            bundle = await fetchOfficialSkill(parsed.category, parsed.name)
          } else {
            return JSON.stringify({ 
              error: `Unsupported identifier format: ${identifier}. Use GitHub URL or official/category/name` 
            })
          }

          // Quarantine
          const { quarantineBundle, installFromQuarantine } = require('../../skills_hub')
          const quarantinePath = quarantineBundle(bundle)

          // Install with approval check
          const installOptions = {
            name: args.name ? String(args.name) : undefined,
            category: args.category ? String(args.category) : bundle.category,
            overwrite: false,
            skipScan: false
          }

          const { getSkillsDir } = require('../../skills_hub')
          const skillName = String(args.name || bundle.name || parsed.name)
          const target = join(getSkillsDir(), installOptions.category || '', skillName)
          const history = new SkillHistoryStore()
          const historyId = history.stage(skillName, target, 'install', 'Before skill install')
          const result = installFromQuarantine(quarantinePath, bundle, installOptions)
          if (result.success) {
            history.commit(historyId)
            try { new SkillStatsStore().recordManage(result.name) } catch {}
          } else history.abort(historyId)

          // Cleanup quarantine
          const { rmSync } = require('fs')
          rmSync(quarantinePath, { recursive: true, force: true })

          if (result.success) {
            // Reload skills
            const l = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
            l?.scanAll ? l.scanAll() : l?.load?.()
          }

          return JSON.stringify(result)
        }

        if (action === 'uninstall') {
          const name = String(args.name || '')
          if (!name) {
            return JSON.stringify({ error: 'Missing required field: name' })
          }

          const { uninstallSkill } = require('../../skills_hub')
          const { HubLock } = require('../../skills_hub')
          const { getSkillsDir } = require('../../skills_hub')
          const entry = new HubLock().get(name)
          const target = entry ? resolve(getSkillsDir(), entry.install_path) : join(getSkillsDir(), name)
          const history = new SkillHistoryStore()
          const historyId = history.stage(name, target, 'uninstall', 'Before skill uninstall')
          const result = uninstallSkill(name)

          if (result.success) {
            history.commit(historyId)
            try { new SkillStatsStore().recordManage(name) } catch {}
            // Reload skills
            const l = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
            l?.scanAll ? l.scanAll() : l?.load?.()
          } else history.abort(historyId)

          return JSON.stringify(result)
        }

        if (action === 'update') {
          const name = String(args.name || '')
          if (!name) {
            return JSON.stringify({ error: 'Missing required field: name' })
          }

          const { updateSkill } = require('../../skills_hub')
          const { HubLock } = require('../../skills_hub')
          const { getSkillsDir } = require('../../skills_hub')
          const entry = new HubLock().get(name)
          const target = entry ? resolve(getSkillsDir(), entry.install_path) : join(getSkillsDir(), name)
          const history = new SkillHistoryStore()
          const historyId = history.stage(name, target, 'update', 'Before skill update')
          const result = await updateSkill(name)

          if (result.success && !result.message.toLowerCase().includes('already up to date')) {
            history.commit(historyId)
            try { new SkillStatsStore().recordManage(name) } catch {}
            // Reload skills
            const l = context?.stores?.skillLoader || (context as any)?.agent?.skillLoader || skillLoader
            l?.scanAll ? l.scanAll() : l?.load?.()
          } else history.abort(historyId)

          return JSON.stringify(result)
        }

        return JSON.stringify({ error: `Unknown action: ${action}` })
      } catch (err: any) {
        return JSON.stringify({ 
          error: err.message || 'Skill management operation failed',
          stack: err.stack
        })
      }
    }
  })

}
