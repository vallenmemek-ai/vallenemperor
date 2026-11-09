import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HELP, color, startupBox, refreshThemeColors } from './cli-ui.mjs'
import { THEMES, getThemeName, gradientText, saveTheme, setTheme, themeNames } from './cli-theme.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function createLocalCommandHandler(context) {
  const { agent, core, state, output, printResponse, readHiddenToken, settleApproval, enqueue, out, refreshStatus, healthCheck, enterShell, runTurn, displayLine } = context
  async function localCommand(text) {
    const [cmd, ...args] = text.trim().split(/\s+/)
    const value = args.join(' ').trim()
    if (cmd === '/help') { printResponse(HELP); return true }
    // /model, /status, /stats, /sessions, /resume, /new, /reset and /memory live in
    // core.handleCommand so every surface behaves the same. Returning false lets
    // runCli fall through to the shared handler.
    if (cmd === '/token') {
      const provider = agent.config.providers['9router']
      if (value === 'status') { printResponse(`9router token: ${provider?.api_key ? 'configured (value hidden)' : 'not set'}`); return true }
      if (value) { printResponse('Token rejected. Use /token with no argument to enter it without echo.'); return true }
      const result = await readHiddenToken()
      if (result.error) { printResponse(result.error); return true }
      if (!result.value) { printResponse('Empty token not saved.'); return true }
      agent.setToken(result.value, '9router')
      printResponse('9router token saved; value hidden.')
      return true
    }
    if (cmd === '/stop') { const stopped = agent.interrupt(); if (state.pendingApproval) settleApproval(false); printResponse(stopped ? 'Stopping agent turn…' : 'No agent turn is running.'); return true }
    if (cmd === '/exit' || cmd === '/quit') {
      state.closing = true
      if (state.pendingApproval) settleApproval(false)
      if (state.busy) agent.interrupt()
      state.rl?.close()
      state.ended = true
      enqueue({ eof: true })
      return true
    }
    if (cmd === '/clear') { out('\x1b[2J\x1b[H'); printResponse('VallenEmperor CLI screen cleared.'); refreshStatus(); return true }
    if (cmd === '/health') { printResponse(startupBox(agent, '', await healthCheck(agent, state.mcpServers), output.isTTY ? Math.min(output.columns || 80, 76) : output.columns || 80)); return true }
    if (cmd === '/tools') {
      const tools = core.registry.list().filter(tool => !tool.checkFn || tool.checkFn())
      const groups = new Map()
      for (const tool of tools) { const group = tool.toolset || 'other'; groups.set(group, [...(groups.get(group) || []), tool.name]) }
      printResponse([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, names]) => `${group}: ${names.join(', ')}`).join('\n'))
      return true
    }
    if (cmd === '/session') {
      if (value !== 'clearall confirm') { printResponse(value === 'clearall' ? 'This permanently deletes saved session history. Confirm with /session clearall confirm.' : 'Usage: /session clearall'); return true }
      await agent.resetSession()
      printResponse(`Deleted ${agent.sessionManager.clearAllSessions()} saved sessions; active session reset.`)
      return true
    }
    if (cmd === '/todos') { printResponse(agent.todoStore.formatForInjection() || 'No active todos.'); return true }
    if (cmd === '/output') { printResponse(state.lastTerminalOutput ? `Last terminal output:\n\n${state.lastTerminalOutput}` : 'No terminal output captured yet.'); return true }
    if (cmd === '/auto') {
      const envLocked = process.env.VALLENEMPEROR_APPROVAL || process.env.VALLENEMPEROR_APPROVAL_MODE
      const current = core.approvalMode(agent.config.agentApproval)
      if (!value || value === 'status') { printResponse(`Approval mode: ${current}. /auto on disables all approval gates; /auto safe gates risky tools; /auto off asks for every tool.`); return true }
      if (!['on', 'safe', 'off'].includes(value)) { printResponse('Usage: /auto [on|safe|off|status]'); return true }
      if (envLocked) { printResponse('Approval mode locked by VALLENEMPEROR_APPROVAL environment setting.'); return true }
      const mode = value === 'on' ? 'off' : value === 'safe' ? 'dangerous' : 'all'
      core.saveConfig({ agentApproval: mode })
      agent.config.agentApproval = mode
      printResponse(`Approval mode set: ${value}.`)
      refreshStatus()
      return true
    }
    if (cmd === '/cd') {
      if (!value) { printResponse(`Working directory: ${agent.config.terminal?.cwd || process.cwd()}\nUsage: /cd <path>`); return true }
      const target = resolve(agent.config.terminal?.cwd || process.cwd(), value.replace(/^~(?=$|[/\\])/, homedir()))
      try { if (! (await import('node:fs')).statSync(target).isDirectory()) throw new Error('not directory') } catch { printResponse(`Directory not found: ${target}`); return true }
      agent.config.terminal = { ...(agent.config.terminal || {}), cwd: target }
      agent.memoryStore.setWorkingDir(target)
      printResponse(`Working directory: ${target}`)
      refreshStatus()
      return true
    }
    if (cmd === '/sh' || cmd === '/pty') { await enterShell(); return true }
    if (cmd === '/plan') {
      const task = core.buildPlanPrompt(value)
      await runTurn(task, text)
      return true
    }
    if (cmd === '/plans') {
      const plans = core.listPlans(agent.config.terminal?.cwd || process.cwd())
      printResponse(plans.length ? plans.slice(0, 20).map(item => `${item.filename} · ${item.size} B`).join('\n') : 'No plans found. Use /plan <task>.')
      return true
    }
    if (cmd === '/search') {
      if (!value) { printResponse('Usage: /search <query>'); return true }
      const { searchSessions, formatHits } = await import(pathToFileURL(join(ROOT, 'vallenagent/dist/session_search.js')).href)
      printResponse(formatHits(searchSessions(value, { limit: 10 })))
      return true
    }
    if (cmd === '/gamedev') {
      const enable = value !== 'off'
      const skills = agent.skillLoader.list().filter(skill => /game|godot|unity|unreal|roblox|blender/i.test(skill.metadata?.category || ''))
      if (enable && !skills.length) { printResponse('No game-development skills found.'); return true }
      agent.setGameDevMode(enable)
      printResponse(enable ? `Game Dev Mode activated · ${skills.length} skills` : 'Game Dev Mode deactivated.')
      return true
    }
    if (cmd === '/perf') {
      const before = process.cpuUsage(); const started = process.hrtime.bigint(); const rss = process.memoryUsage().rss
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1000))
      const cpu = process.cpuUsage(before); const elapsed = Number(process.hrtime.bigint() - started) / 1e9
      printResponse(`Process CPU: ${((cpu.user + cpu.system) / 1e6 / elapsed * 100).toFixed(1)}%\nRSS: ${(rss / 1048576).toFixed(1)} MiB`)
      return true
    }
    if (cmd === '/review') {
      if (args[0]?.toLowerCase() === 'log') {
        const { ReviewLogStore } = await import(pathToFileURL(join(ROOT, 'vallenagent/dist/skill_history.js')).href)
        const rows = new ReviewLogStore().list(20)
        printResponse(rows.length ? rows.map(row => `${row.at} ${row.kind} ${row.name}: ${row.change}`).join('\n') : 'No review history.')
        return true
      }
      const focus = value.trim()
      const started = agent.requestBackgroundReview({ onReviewComplete: message => displayLine(message), onReviewError: error => displayLine(`Review error: ${error}`) }, focus)
      printResponse(started ? `Background review started${focus ? ` (focus: ${focus.slice(0, 120)})` : ''}.` : 'Background review already running.')
      return true
    }
    if (cmd === '/skills') {
      const sub = (args[0] || '').toLowerCase()
      const name = args[1]
      const skills = agent.skillLoader.list()
      const historyModule = () => import(pathToFileURL(join(ROOT, 'vallenagent/dist/skill_history.js')).href)
      const hubInstall = () => import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_hub_install.js')).href)
      if (!sub) {
        const byCategory = new Map()
        for (const skill of skills) { const category = skill.metadata?.category || 'general'; byCategory.set(category, [...(byCategory.get(category) || []), skill.name]) }
        printResponse(`${[...byCategory].sort(([a], [b]) => a.localeCompare(b)).map(([category, names]) => `${category}: ${names.join(', ')}`).join('\n') || 'No skills loaded.'}\n\nUse /skills help for subcommands.`)
        return true
      }
      if (sub === 'help') { printResponse('/skills search <query> · install <github-url|official/category/name> · uninstall|update <name> · installed · stats · history · undo <id> · enable|disable <name> · disabled · sync · reset <name>'); return true }
      if (sub === 'stats') {
        const { SkillStatsStore } = await import(pathToFileURL(join(ROOT, 'vallenagent/dist/skill_stats.js')).href)
        const rows = new SkillStatsStore().list()
        printResponse(rows.length ? rows.map(row => `${row.name}: views=${row.view_count}, successes=${row.success_count}, changes=${row.manage_count}, corrections=${row.correction_count}`).join('\n') : 'No skill usage stats yet.')
        return true
      }
      if (sub === 'history') {
        const { SkillHistoryStore } = await historyModule(); const rows = new SkillHistoryStore().list(20)
        printResponse(rows.length ? rows.map(row => `${row.id} · ${row.at} · ${row.skill} ${row.action}${row.undone ? ' [undone]' : ''}\n  ${row.reason}`).join('\n') : 'No skill changes recorded yet.')
        return true
      }
      if (sub === 'undo') {
        if (!name) { printResponse('Usage: /skills undo <change-id>'); return true }
        const [{ SkillHistoryStore }, { getSkillsDir }] = await Promise.all([historyModule(), import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_hub_models.js')).href)])
        const result = new SkillHistoryStore().undo(name, [...(agent.skillLoader.skillPaths || []), getSkillsDir()])
        if (result.success) agent.skillLoader.scanAll()
        printResponse(result.message)
        return true
      }
      if (sub === 'search') {
        const query = args.slice(1).join(' ').trim()
        if (!query) { printResponse('Usage: /skills search <query>'); return true }
        const { searchSkills, getCatalogError } = await import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_hub_search.js')).href)
        const results = await searchSkills({ query, limit: 10 })
        const catalogError = getCatalogError?.()
        const body = results.length ? results.map(item => `${item.name} · ${item.trust_level}\n  ${item.description}\n  ${item.install_command}`).join('\n\n') : `No skills found for: ${query}`
        printResponse(catalogError ? `${body}\n\n[catalog] ${catalogError}` : body)
        return true
      }
      if (sub === 'install') {
        const identifier = args.slice(1).join(' ').trim()
        if (!identifier) { printResponse('Usage: /skills install <github-url|official/category/name>'); return true }
        const [{ parseSkillIdentifier }, search, install] = await Promise.all([import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_hub_models.js')).href), import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_hub_search.js')).href), hubInstall()])
        const parsed = parseSkillIdentifier(identifier)
        const bundle = parsed.source === 'github' && parsed.url ? await search.fetchGitHubSkill(parsed.url) : parsed.source === 'official' && parsed.category ? await search.fetchOfficialSkill(parsed.category, parsed.name) : null
        if (!bundle) { printResponse('Use a GitHub URL or official/category/name.'); return true }
        const quarantine = install.quarantineBundle(bundle)
        try {
          const result = install.installFromQuarantine(quarantine, bundle, { overwrite: false })
          if (result.success) agent.skillLoader.scanAll()
          printResponse(result.message)
        } finally { rmSync(quarantine, { recursive: true, force: true }) }
        return true
      }
      if (sub === 'uninstall' || sub === 'update' || sub === 'reset') {
        if (!name) { printResponse(`Usage: /skills ${sub} <name>`); return true }
        const result = sub === 'reset'
          ? await (async () => (await import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_sync.js')).href)).resetSkill(name))()
          : sub === 'update' ? await (await hubInstall()).updateSkill(name) : (await hubInstall()).uninstallSkill(name)
        if (result.success) agent.skillLoader.scanAll()
        printResponse(result.message)
        return true
      }
      if (sub === 'installed') {
        const rows = (await hubInstall()).listInstalledSkills()
        printResponse(rows.length ? rows.map(row => `${row.source} · ${row.name} · ${row.install_path} · ${row.installed_at}`).join('\n') : 'No skills installed via hub yet.')
        return true
      }
      if (sub === 'disable' || sub === 'enable') {
        if (!name) { printResponse(`Usage: /skills ${sub} <name>`); return true }
        const changed = agent.skillLoader[sub](name)
        if (changed) {
          const disabled = new Set(agent.config.skills?.disabled || [])
          if (sub === 'disable') disabled.add(name); else disabled.delete(name)
          agent.config.skills = { ...(agent.config.skills || {}), disabled: [...disabled] }
          core.saveConfig({ skills: agent.config.skills })
        }
        printResponse(changed ? `Skill ${name} ${sub}d.` : `Skill ${name} unchanged or not found.`)
        return true
      }
      if (sub === 'disabled') { printResponse(agent.skillLoader.getDisabled().join('\n') || 'No disabled skills.'); return true }
      if (sub === 'sync') {
        const result = (await import(pathToFileURL(join(ROOT, 'vallenagent/dist/skills_sync.js')).href)).syncBundledSkills({ force: false })
        agent.skillLoader.scanAll()
        printResponse(`Added ${result.added.length} · updated ${result.updated.length} · skipped ${result.skipped.length} · errors ${result.errors.length}`)
        return true
      }
      printResponse(`Unknown /skills subcommand: ${sub}. Use /skills help.`)
      return true
    }
    if (cmd === '/theme' || cmd === '/themes') {
      const names = themeNames()
      if (!value) {
        const rows = names.map(name => `${name === getThemeName() ? '❯' : ' '} ${name.padEnd(9)} ${gradientText('██████████', THEMES[name].gradient)}`)
        printResponse(`Current theme: ${getThemeName()}\n${rows.join('\n')}\nUse /theme <name> to switch.`)
        return true
      }
      if (!setTheme(value)) { printResponse(`Unknown theme: ${value}. Available: ${names.join(', ')}`); return true }
      saveTheme(process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor'), getThemeName())
      refreshThemeColors()
      printResponse(`Theme set: ${getThemeName()}`)
      refreshStatus()
      return true
    }
    if (cmd === '/settings') { printResponse(`${cmd} is UI-only and unavailable in VallenCLI.`); return true }
    return false
  }
  return localCommand
}
