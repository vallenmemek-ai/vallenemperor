import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { color, startupBox, refreshThemeColors } from './cli-ui.mjs'
import { THEMES, getThemeName, gradientText, saveTheme, setTheme, themeNames } from './cli-theme.mjs'

export function createLocalCommandHandler(context) {
  const { agent, core, state, output, printResponse, readHiddenToken, settleApproval, enqueue, out, refreshStatus, healthCheck, enterShell, runTurn, displayLine } = context
  async function localCommand(text) {
    const [cmd, ...args] = text.trim().split(/\s+/)
    const value = args.join(' ').trim()
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
    if (cmd === '/btw') {
      if (!value) { printResponse('Usage: /btw <question> — side question in a clean context; this conversation is untouched.'); return true }
      let side
      try {
        const createSideAgent = context.createSideAgent
          || (() => new core.AIAgent({ config: structuredClone(agent.config), lightweight: true, backgroundReview: false, isSubagent: true }))
        side = createSideAgent()
        const answer = await side.chat(value, {})
        printResponse(`[btw] ${String(answer?.response || '').trim() || '(empty answer)'}`)
      } catch (err) {
        printResponse(`[btw] failed: ${err?.message || err}`)
      } finally {
        try { side?.shutdown?.() } catch { }
      }
      return true
    }
    if (cmd === '/fork') {
      try {
        const forked = agent.forkSession()
        printResponse(`Forked into ${forked}. This conversation continues in the fork; the previous session is still resumable with /resume.`)
        refreshStatus()
      } catch (err) {
        printResponse(`Fork failed: ${err?.message || err}`)
      }
      return true
    }
    if (cmd === '/worktree') {
      const [sub, name] = value.split(/\s+/).filter(Boolean)
      const repo = agent.config?.terminal?.cwd || process.cwd()
      if (sub === 'list' || !sub) {
        const list = core.listWorktrees(repo)
        printResponse(list.length ? list.join('\n') : 'No worktrees for this repository.')
        return true
      }
      if (sub === 'new') {
        const id = `main-${(name || Date.now().toString(36)).replace(/[^A-Za-z0-9._-]/g, '-')}`
        try {
          const info = core.createSubagentWorktree({ repo, home: core.getVallenHome(), id })
          agent.config.terminal = { ...(agent.config.terminal || {}), cwd: info.path }
          try { agent.memoryStore?.setWorkingDir?.(info.path) } catch { }
          printResponse(`Worktree ready: ${info.path}\nBranch: ${info.branch}\nAgent cwd retargeted here.`)
        } catch (error) {
          printResponse(`Worktree failed: ${error?.message || error}`)
        }
        return true
      }
      printResponse('Usage: /worktree new [name] | /worktree list')
      return true
    }
    if (cmd === '/queue') {
      const queue = state.queuedPrompts || (state.queuedPrompts = [])
      const [sub, ...rest] = value.split(/\s+/).filter(Boolean)
      if (!sub || sub === 'list') {
        printResponse(queue.length ? queue.map((item, index) => `${index + 1}. ${item}`).join('\n') : 'Queue is empty. Add one with /queue add <prompt>.')
        return true
      }
      if (sub === 'clear') { queue.length = 0; printResponse('Queue cleared.'); return true }
      if (sub === 'rm') {
        const index = Number(rest[0]) - 1
        if (!Number.isInteger(index) || index < 0 || index >= queue.length) { printResponse('Usage: /queue rm <number> (see /queue list)'); return true }
        const [removed] = queue.splice(index, 1)
        printResponse(`Removed from queue: ${removed.slice(0, 80)}`)
        return true
      }
      const promptText = sub === 'add' ? rest.join(' ').trim() : [sub, ...rest].join(' ')
      if (!promptText) { printResponse('Usage: /queue add <prompt> | /queue list | /queue rm <n> | /queue clear'); return true }
      queue.push(promptText)
      printResponse(`Queued (${queue.length}): ${promptText.slice(0, 80)}`)
      return true
    }
    if (cmd === '/rewind') {
      const [first, second] = value.split(/\s+/).filter(Boolean)
      const prompts = agent.listUserPrompts ? agent.listUserPrompts() : []
      if (!prompts.length) { printResponse('No user prompts to rewind to.'); return true }
      if (!first) {
        printResponse(['Recent prompts (newest last):', ...prompts.slice(-10).map(item => `${item.index}. ${item.text}`), 'Use /rewind <n> to cut back to before prompt n, or /rewind fork <n> to branch first.'].join('\n'))
        return true
      }
      if (first === 'fork') {
        const result = agent.forkAtPrompt ? agent.forkAtPrompt(Number(second)) : null
        printResponse(result ? `Forked into ${result.sessionId} at prompt ${second}. Prompt:\n${result.prompt}` : `No prompt ${second || ''}.`)
        return true
      }
      const text = agent.rewindToPrompt ? agent.rewindToPrompt(Number(first)) : null
      printResponse(text ? `Rewound to before prompt ${first}. Re-send or edit it:\n${text}` : `No prompt ${first}.`)
      return true
    }
    if (cmd === '/goal') {
      const [sub, ...rest] = value.split(/\s+/).filter(Boolean)
      if (!sub || sub === 'status') { printResponse(core.formatGoal(agent.getGoal ? agent.getGoal() : null)); return true }
      if (sub === 'clear') { agent.clearGoal?.(); printResponse('Goal cleared.'); return true }
      if (sub === 'pause' || sub === 'resume') {
        agent.updateGoal?.({ status: sub === 'pause' ? 'paused' : 'active' })
        printResponse(`Goal ${sub === 'pause' ? 'paused' : 'resumed'}.`)
        return true
      }
      const objective = [sub, ...rest].join(' ').trim()
      const goal = agent.setGoal ? agent.setGoal(objective) : null
      printResponse(goal ? `Goal set (max ${goal.maxTurns} attempts):\n${goal.text}` : 'Could not set a goal.')
      return true
    }
    if (cmd === '/steer') {
      if (!value) { printResponse('Usage: /steer <note> — delivered after the next tool call, without interrupting the turn.'); return true }
      const queued = agent.steer ? agent.steer(value) : false
      printResponse(queued ? `Steer queued: ${value.slice(0, 100)}` : 'No active agent to steer.')
      return true
    }
    if (cmd === '/save') {
      const [formatArg, fileArg, redactArg] = value.split(/\s+/).filter(Boolean)
      const format = formatArg === 'json' ? 'json' : 'md'
      const redact = value.includes('redact') || redactArg === 'redact'
      const transcript = agent.exportTranscript ? agent.exportTranscript() : []
      if (!transcript.length) { printResponse('Nothing to save yet — no messages in this session.'); return true }
      const content = core.exportSession({
        messages: transcript,
        sessionId: agent.getSessionId(),
        model: agent.config?.providers?.[agent.config?.providers?.active]?.model,
        title: state.sessionTitle,
        format,
        redact
      })
      const target = fileArg && !fileArg.startsWith('-') && fileArg !== 'redact'
        ? resolve(agent.config?.terminal?.cwd || process.cwd(), fileArg)
        : join(core.getVallenHome(), 'sessions', 'saved', core.defaultExportName(agent.getSessionId(), format))
      try {
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, content, { mode: 0o600 })
        printResponse(`Saved ${format} transcript (${transcript.length} messages${redact ? ', secrets redacted' : ''}):\n${target}`)
      } catch (error) {
        printResponse(`Save failed: ${error?.message || error}`)
      }
      return true
    }
    if (cmd === '/title') {
      if (!value) { printResponse(`Session title: ${state.sessionTitle || '(untitled)'}`); return true }
      state.sessionTitle = value.slice(0, 120)
      printResponse(`Session title set: ${state.sessionTitle}`)
      return true
    }
    if (cmd === '/history') {
      const count = Math.max(1, Math.min(50, Number(value) || 10))
      const transcript = agent.exportTranscript ? agent.exportTranscript() : []
      if (!transcript.length) { printResponse('No messages yet.'); return true }
      const lines = transcript.slice(-count).map(message => `${message.role === 'user' ? '›' : '‹'} ${message.content.slice(0, 200).replace(/\n/g, ' ')}`)
      printResponse(lines.join('\n'))
      return true
    }
    if (cmd === '/prompt') {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
      const file = join(tmpdir(), `vallen-prompt-${Date.now()}.md`)
      try {
        writeFileSync(file, value || '', 'utf8')
        const runEditor = context.runEditor || ((command, path) => spawnSync(command, [path], { stdio: 'inherit' }).status === 0)
        if (!runEditor(editor, file)) { printResponse(`Editor ${editor} exited with an error; prompt not sent.`); return true }
        const text = readFileSync(file, 'utf8').trim()
        if (!text) { printResponse('Empty prompt; nothing sent.'); return true }
        await runTurn(text, text.slice(0, 80))
        return true
      } finally {
        try { rmSync(file, { force: true }) } catch { }
      }
    }
    if (cmd === '/commands') {
      const workspace = agent.config?.terminal?.cwd || process.cwd()
      const custom = core.discoverCustomCommands({ workspace, home: core.getVallenHome() })
      printResponse(core.formatCustomCommandList(custom))
      return true
    }
    if (cmd === '/copy') {
      const replies = state.lastReplies || []
      if (!replies.length) { printResponse('Nothing to copy yet — no assistant reply in this session.'); return true }
      const requested = Number(value)
      const index = Number.isFinite(requested) && requested > 0 ? replies.length - requested : replies.length - 1
      const text = replies[Math.max(0, Math.min(replies.length - 1, index))]
      const result = core.copyToClipboard(text)
      printResponse(core.formatCopyResult(result, text.length))
      return true
    }
    if (cmd === '/grill-me' || cmd === '/grill') {
      await runTurn(core.buildGrillPrompt(value), text)
      return true
    }
    if (cmd === '/learn') {
      const prompt = core.buildLearnPrompt(value)
      await runTurn(prompt, text)
      return true
    }
    if (cmd === '/browser') {
      if (!value) {
        printResponse('Usage: /browser <task> — unlocks browser tools for 30 minutes and runs the task. Use /browser off to lock them again.')
        return true
      }
      if (value === 'off' || value === 'lock') {
        core.lockBrowserTools(agent.getSessionId())
        printResponse('Browser tools locked. The agent can only use web_search / web_extract now.')
        return true
      }
      core.unlockBrowserTools(agent.getSessionId(), 30 * 60_000)
      await runTurn(`[browser task] ${value}\n\nBrowser tools are unlocked for this session. Prove what you saw with browser_screenshot and cite the saved PNG path.`, text)
      return true
    }
    if (cmd === '/plan') {
      const cwd = agent.config.terminal?.cwd || process.cwd()
      const [sub, ...rest] = value.split(/\s+/).filter(Boolean)
      const feedback = rest.join(' ').trim()

      const savePlanProgress = () => {
        if (!state.planRun) return
        try {
          core.writeArtifact({
            home: core.getVallenHome(),
            sessionId: agent.getSessionId(),
            turn: Math.max(1, agent.getContextStats().turns || 1),
            kind: 'note',
            name: 'plan-progress.md',
            content: core.formatPlanStatus(state.planRun)
          })
        } catch { }
      }

      const runPlanStep = async (stepFeedback) => {
        const step = core.currentStep(state.planRun)
        if (!step) { printResponse(core.formatPlanPause(state.planRun)); return }
        const prompt = core.buildStepPrompt({ run: state.planRun, step, feedback: stepFeedback })
        await runTurn(prompt, `[plan ${step.index}/${state.planRun.steps.length}] ${step.title}`)
        state.planRun = core.advancePlanRun(state.planRun)
        printResponse(core.formatPlanPause(state.planRun))
        savePlanProgress()
      }

      if (sub === 'status') {
        printResponse(state.planRun ? core.formatPlanStatus(state.planRun) : 'No plan run yet. Run /plan <task> to write one, then /plan go.')
        return true
      }
      if (sub === 'stop') {
        if (!state.planRun) { printResponse('No plan run to stop.'); return true }
        state.planRun = core.stopPlanRun(state.planRun)
        printResponse(core.formatPlanPause(state.planRun))
        savePlanProgress()
        return true
      }
      if (sub === 'skip') {
        if (!state.planRun || state.planRun.status !== 'running') { printResponse('No running plan. Use /plan go to start one.'); return true }
        const skipped = core.currentStep(state.planRun)
        state.planRun = core.skipCurrentStep(state.planRun)
        printResponse(`[plan] Skipped step ${skipped ? skipped.index : ''}: ${skipped ? skipped.title : ''}\n${core.formatPlanPause(state.planRun)}`)
        savePlanProgress()
        return true
      }
      if (sub === 'next') {
        if (!state.planRun || state.planRun.status !== 'running') { printResponse('No running plan. Use /plan go to start one.'); return true }
        await runPlanStep()
        return true
      }
      if (sub === 'edit') {
        if (!state.planRun || state.planRun.status !== 'running') { printResponse('No running plan. Use /plan go to start one.'); return true }
        if (!feedback) { printResponse('Usage: /plan edit <feedback> — re-runs the current step with your guidance.'); return true }
        state.planRun = core.addPlanFeedback(state.planRun, feedback)
        await runPlanStep(feedback)
        return true
      }
      if (sub === 'go' || sub === 'start') {
        const plans = core.listPlans(cwd)
        if (!plans.length) { printResponse('No plan file found. Run /plan <task> first.'); return true }
        let markdown = ''
        try { markdown = readFileSync(plans[0].path, 'utf8') } catch { }
        if (!markdown.trim()) { printResponse(`Could not read ${plans[0].path}.`); return true }
        state.planRun = core.createPlanRun({ planPath: plans[0].path, markdown })
        if (!state.planRun.steps.length) {
          printResponse(`Plan ${plans[0].filename} has no numbered steps, so there is nothing to execute step by step.`)
          return true
        }
        printResponse(core.formatPlanStatus(state.planRun))
        await runPlanStep()
        return true
      }

      const task = core.buildPlanPrompt(value)
      await runTurn(task, text)
      try {
        const plans = core.listPlans(cwd)
        const newest = plans[0]
        if (newest && Date.now() - newest.createdAt.getTime() < 10 * 60_000) {
          const slug = newest.filename.replace(/^\d{4}-\d{2}-\d{2}_\d{6}-/, '').replace(/\.md$/, '')
          core.writeArtifact({
            home: core.getVallenHome(),
            sessionId: agent.getSessionId(),
            turn: Math.max(1, agent.getContextStats().turns || 1),
            kind: 'plan',
            name: `plan-${slug}.md`.slice(0, 64),
            content: readFileSync(newest.path, 'utf8')
          })
          printResponse(`Plan saved: ${newest.path}\nExecute it step by step with /plan go.`)
        }
      } catch { }
      return true
    }
    if (cmd === '/plans') {
      const plans = core.listPlans(agent.config.terminal?.cwd || process.cwd())
      printResponse(plans.length ? plans.slice(0, 20).map(item => `${item.filename} · ${item.size} B`).join('\n') : 'No plans found. Use /plan <task>.')
      return true
    }
    if (cmd === '/search') {
      if (!value) { printResponse('Usage: /search <query>'); return true }
      printResponse(core.formatHits(core.searchSessions(value, { limit: 10 })))
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
    if (cmd === '/reasoning') {
      const block = state.reasoning || {}
      const action = (args[0] || '').toLowerCase()
      if (action === 'on' || action === 'off') {
        block.enabled = action === 'on'
        printResponse(`Reasoning display ${action}.`)
        return true
      }
      if (!block.last) {
        printResponse('No reasoning captured yet. Providers that do not send reasoning deltas leave this empty.')
        return true
      }
      const lines = String(block.last).trim().split('\n').filter(line => line.length > 0)
      const shown = action === 'full' ? lines : lines.slice(0, 10)
      const more = lines.length > shown.length ? `\n  … ${lines.length - shown.length} more line(s) — /reasoning full` : ''
      printResponse(`Reasoning (${lines.length} lines)\n${shown.join('\n')}${more}`)
      return true
    }
    if (cmd === '/journey') {
      return await localCommand('/skills journey')
    }
    if (cmd === '/skills') {
      const sub = (args[0] || '').toLowerCase()
      const name = args[1]
      const skills = agent.skillLoader.list()
      // Every skill helper comes from the core barrel (dist/index.js), not from
      // internal dist paths — the CLI must only depend on the public surface.
      if (!sub) {
        const byCategory = new Map()
        for (const skill of skills) { const category = skill.metadata?.category || 'general'; byCategory.set(category, [...(byCategory.get(category) || []), skill.name]) }
        printResponse(`${[...byCategory].sort(([a], [b]) => a.localeCompare(b)).map(([category, names]) => `${category}: ${names.join(', ')}`).join('\n') || 'No skills loaded.'}\n\nUse /skills help for subcommands.`)
        return true
      }
      if (sub === 'help') { printResponse('/skills search <query> · install <github-url|official/category/name> · uninstall|update <name> · installed · stats · history · journey · index · pending · approve <id> · reject <id> · undo <id> · enable|disable <name> · disabled · sync · reset <name>'); return true }
      // R26 — learning timeline: skill changes + review-log rows in one newest-first list.
      if (sub === 'journey') {
        const limit = Math.max(1, Math.min(50, Number(name) || 20))
        const rows = core.buildJourney(new core.SkillHistoryStore().list(100), new core.ReviewLogStore().list(100), limit)
        printResponse(rows.length ? rows.map(row => `${row.at} · ${row.kind} ${row.name} · ${row.action}\n  ${row.reason} (${row.source})`).join('\n') : 'Nothing learned yet — no skill changes or memory proposals recorded.')
        return true
      }
      // R28 — skill-index cost and how much it grew since the last check.
      if (sub === 'index') {
        const budget = core.skillIndexBudget(skills.map(skill => ({ name: skill.name, description: skill.metadata?.description || '' })), core.skillIndexFile(core.getVallenHome()))
        if (value.includes('store') || value.includes('reset')) core.writeSkillIndexSnapshot(core.skillIndexFile(core.getVallenHome()), { at: new Date().toISOString(), tokens: budget.tokens, skills: budget.skills, names: skills.map(skill => skill.name).sort() })
        printResponse(`${core.formatSkillIndexBudget(budget)}\nRe-measure baseline with /skills index store.`)
        return true
      }
      // P1b.10 — staged skill writes: review a skill_manage batch before it lands.
      if (sub === 'pending') {
        printResponse(core.formatPendingList(core.listPendingWrites(core.getVallenHome(), 'skills')))
        return true
      }
      if (sub === 'approve' || sub === 'reject') {
        if (!name) { printResponse(`Usage: /skills ${sub} <id>`); return true }
        const write = core.readPendingWrite(core.getVallenHome(), name)
        if (!write || write.subsystem !== 'skills') { printResponse(`No pending skill write ${name}.`); return true }
        if (sub === 'reject') { core.removePendingWrite(core.getVallenHome(), name); printResponse(`Pending ${name} rejected and removed.`); return true }
        const tool = core.registry.get('skill_manage')
        if (!tool) { printResponse('skill_manage tool unavailable.'); return true }
        const result = JSON.parse(await tool.handler({ operations: write.operations || [] }, { sessionId: agent.getSessionId(), workingDir: agent.config?.terminal?.cwd || process.cwd(), skipSkillStaging: true, stores: { skillLoader: agent.skillLoader } }))
        if (!result.success) { printResponse(`Failed to apply ${name}: ${result.error || 'operation failed'}`); return true }
        core.removePendingWrite(core.getVallenHome(), name)
        agent.skillLoader?.scanAll?.()
        printResponse(`Pending ${name} approved and applied (${(write.operations || []).length} operation(s)).`)
        return true
      }
      if (sub === 'stats') {
        const rows = new core.SkillStatsStore().list()
        printResponse(rows.length ? rows.map(row => `${row.name}: views=${row.view_count}, successes=${row.success_count}, changes=${row.manage_count}, corrections=${row.correction_count}`).join('\n') : 'No skill usage stats yet.')
        return true
      }
      if (sub === 'history') {
        const rows = new core.SkillHistoryStore().list(20)
        printResponse(rows.length ? rows.map(row => `${row.id} · ${row.at} · ${row.skill} ${row.action}${row.undone ? ' [undone]' : ''}\n  ${row.reason}`).join('\n') : 'No skill changes recorded yet.')
        return true
      }
      if (sub === 'undo') {
        if (!name) { printResponse('Usage: /skills undo <change-id>'); return true }
        const result = new core.SkillHistoryStore().undo(name, [...(agent.skillLoader.skillPaths || []), core.getSkillsDir()])
        if (result.success) agent.skillLoader.scanAll()
        printResponse(result.message)
        return true
      }
      if (sub === 'search') {
        const query = args.slice(1).join(' ').trim()
        if (!query) { printResponse('Usage: /skills search <query>'); return true }
        const results = await core.searchSkills({ query, limit: 10 })
        const catalogError = core.getCatalogError?.()
        const body = results.length ? results.map(item => `${item.name} · ${item.trust_level}\n  ${item.description}\n  ${item.install_command}`).join('\n\n') : `No skills found for: ${query}`
        printResponse(catalogError ? `${body}\n\n[catalog] ${catalogError}` : body)
        return true
      }
      if (sub === 'install') {
        const identifier = args.slice(1).join(' ').trim()
        if (!identifier) { printResponse('Usage: /skills install <github-url|official/category/name>'); return true }
        const parsed = core.parseSkillIdentifier(identifier)
        const bundle = parsed.source === 'github' && parsed.url ? await core.fetchGitHubSkill(parsed.url) : parsed.source === 'official' && parsed.category ? await core.fetchOfficialSkill(parsed.category, parsed.name) : null
        if (!bundle) { printResponse('Use a GitHub URL or official/category/name.'); return true }
        const quarantine = core.quarantineBundle(bundle)
        try {
          const result = core.installFromQuarantine(quarantine, bundle, { overwrite: false })
          if (result.success) agent.skillLoader.scanAll()
          printResponse(result.message)
        } finally { rmSync(quarantine, { recursive: true, force: true }) }
        return true
      }
      if (sub === 'uninstall' || sub === 'update' || sub === 'reset') {
        if (!name) { printResponse(`Usage: /skills ${sub} <name>`); return true }
        const result = sub === 'reset'
          ? await core.resetSkill(name)
          : sub === 'update' ? await core.updateSkill(name) : core.uninstallSkill(name)
        if (result.success) agent.skillLoader.scanAll()
        printResponse(result.message)
        return true
      }
      if (sub === 'installed') {
        const rows = core.listInstalledSkills()
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
        const result = core.syncBundledSkills({ force: false })
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
    // User-defined command from .vallenemperor/commands/*.md
    if (cmd.startsWith('/')) {
      const workspace = agent.config?.terminal?.cwd || process.cwd()
      const custom = core.findCustomCommand(cmd, core.discoverCustomCommands({ workspace, home: core.getVallenHome() }))
      if (custom) {
        const prompt = core.renderCustomCommand(custom, value)
        await runTurn(prompt, text)
        return true
      }
      // `/<skill-name>` runs a loaded skill directly.
      const wanted = cmd.slice(1).toLowerCase()
      const skills = agent.skillLoader?.list?.() || []
      const skill = skills.find(entry => String(entry.name || '').toLowerCase() === wanted)
      if (skill) {
        const body = String(skill.content || '').slice(0, 8000)
        await runTurn(`[skill: ${skill.name}]\n\n${body}\n\nTask: ${value || 'Apply this skill to the current work.'}`, text)
        return true
      }
    }
    return false
  }
  return localCommand
}
