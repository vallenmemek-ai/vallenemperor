import { getVallenHome } from '../../core/config'
import { subagentRegistry } from '../../agent/subagent_registry'
import { createSubagentWorktree } from '../../agent/worktree'
import { buildAgentInstructions, discoverCustomAgents, selectAgentForTask } from '../../agent/custom_agents'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { registry, ToolSchema, ToolContext } from '../tools'
import { deferredToolHealth } from '../tool_health'

export function registerIntegrationTools(isSubagent: boolean, delegateAgentFactory?: (task: { taskId: string; goal: string; context?: string; max_iterations?: number; max_output_tokens?: number; model?: string }, onProgress?: (event: { status: 'thinking' | 'tool_start' | 'tool_end'; message?: string }) => void) => Promise<string>): void {
  // 14. manage_connections
  const manageConnectionsSchema: ToolSchema = {
    name: 'manage_connections',
    description: 'Check status of external connectors and services (9router API, local git repo, working tree).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list'], default: 'status' }
      }
    }
  }

  registry.register({
    name: 'manage_connections',
    schema: manageConnectionsSchema,
    toolset: 'connections',
    handler: async (_args, context) => {
      const workdir = context?.workingDir || process.cwd()
      return JSON.stringify({
        supported: false,
        error: 'Hosted connectors are not integrated in this runtime.',
        local_environment: {
          home: homedir(),
          working_directory: workdir,
          git_repository: existsSync(join(workdir, '.git'))
        }
      })
    }
  })

  // 15. delegate_task (skip for subagents)
  if (!isSubagent) {
    const delegateTaskSchema: ToolSchema = {
      name: 'delegate_task',
      description: 'Spawn subagent in isolated context to complete focused subtasks. Returns summary.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string', description: 'Goal for subagent' },
                context: { type: 'string', description: 'Background context for subagent' },
                max_iterations: { type: 'integer', description: 'Optional iteration limit (1-30)' },
                max_output_tokens: { type: 'integer', description: 'Optional output token budget (1-20000)' },
                model: { type: 'string', description: 'Optional configured provider model for lightweight work' },
                workspace: { type: 'string', enum: ['inherit', 'branch', 'share'], description: 'inherit = same tree (default), branch = isolated git worktree, share = same directory as the parent' },
                background: { type: 'boolean', description: 'Run after this tool call returns; track with /agents' },
                agent: { type: 'string', description: 'Custom agent name from .agents/agents/*.md; omit to let the planner route by description' }
              },
              required: ['goal']
            },
            description: 'Subagent tasks to execute'
          }
        },
        required: ['tasks']
      }
    }

    registry.register({
      name: 'delegate_task',
      schema: delegateTaskSchema,
      toolset: 'delegation',
      handler: async (args, context) => {
        if (context?.isSubagent) {
          return JSON.stringify({ error: 'Subagents cannot call delegate_task (delegation depth limit reached).' })
        }
        const tasks = Array.isArray(args.tasks) ? args.tasks : []
        const summaries: Array<Record<string, any>> = []
        const delegateFn = context?.delegateAgentFactory || delegateAgentFactory
        const repo = context?.workingDir || process.cwd()
        const customAgents = discoverCustomAgents({ workspace: repo, home: getVallenHome() })

        const resolveAgent = (task: any) => {
          const requested = String(task.agent || '').trim().toLowerCase()
          if (requested) return customAgents.find(agent => agent.name.toLowerCase() === requested) || null
          const routed = selectAgentForTask(String(task.goal || ''), customAgents)
          return routed && routed.score >= 3 ? routed.agent : null
        }

        const normalize = (task: any) => ({
          ...task,
          max_iterations: Math.min(30, Math.max(1, Number(task.max_iterations) || 10)),
          max_output_tokens: Math.min(20_000, Math.max(1, Number(task.max_output_tokens) || 4000))
        })

        const foreground: any[] = []
        const background: any[] = []
        for (const task of tasks) (task?.background ? background : foreground).push(task)

        // Foreground: unchanged behaviour, three at a time.
        for (let start = 0; start < foreground.length; start += 3) {
          const batch = foreground.slice(start, start + 3)
          const results = await Promise.all(batch.map(async (t, index) => {
            if (!delegateFn) return { goal: t.goal, summary: `Subagent delegated task completed with goal: ${t.goal}` }
            const taskId = `${context?.toolCallId || 'delegate'}:${start + index + 1}`
            const report = (status: 'started' | 'thinking' | 'tool_start' | 'tool_end' | 'completed' | 'failed', message?: string) => {
              try { context?.onSubagentProgress?.({ taskId, goal: String(t.goal || ''), status, message }) } catch { }
            }
            report('started')
            try {
              const task = normalize(t)
              const agent = resolveAgent(t)
              if (agent) {
                task.agentInstructions = buildAgentInstructions(agent)
                if (agent.tools.length) task.tools = agent.tools
                if (agent.model) task.model = agent.model
              }
              const summary = await delegateFn(task, event => report(event.status, event.message))
              report('completed')
              return { goal: t.goal, summary, ...(agent ? { agent: agent.name } : {}) }
            } catch (err: any) {
              const message = String(err?.message || err || 'Unknown subagent error').slice(0, 500)
              report('failed', message)
              return { goal: t.goal, summary: `Subagent failed: ${message}` }
            }
          }))
          summaries.push(...results)
        }

        // Background: queue in the registry and return immediately so the turn can continue.
        for (const t of background) {
          const goal = String(t.goal || '').trim()
          const workspace = ['inherit', 'branch', 'share'].includes(t.workspace) ? t.workspace : 'inherit'
          if (!goal) { summaries.push({ goal: '', error: 'goal is required' }); continue }
          if (!delegateFn) { summaries.push({ goal, error: 'Subagent factory unavailable in this context.' }); continue }
          if (!subagentRegistry.canStart()) {
            summaries.push({ goal, error: `Subagent limit reached (${subagentRegistry.activeCount()} active). Wait or stop one with /agents stop <id>.` })
            continue
          }

          const agent = resolveAgent(t)
          const run = subagentRegistry.create({ goal, workspace, agent: agent?.name })
          let worktree: { repo: string; path: string; branch: string } | undefined
          if (workspace === 'branch') {
            try {
              const created = createSubagentWorktree({ repo, home: getVallenHome(), id: run.id })
              worktree = { repo: created.repo, path: created.path, branch: created.branch }
              subagentRegistry.setWorktree(run.id, worktree)
            } catch (err: any) {
              const message = String(err?.message || err || 'Could not create a worktree').slice(0, 500)
              subagentRegistry.fail(run.id, message)
              summaries.push({ goal, id: run.id, error: message })
              continue
            }
          }

          subagentRegistry.markRunning(run.id)
          const task = normalize(t)
          if (agent) {
            task.agentInstructions = buildAgentInstructions(agent)
            if (agent.tools.length) task.tools = agent.tools
            if (agent.model) task.model = agent.model
          }
          void (async () => {
            try {
              const summary = await delegateFn(
                { ...task, goal, taskId: run.id, cwd: worktree?.path },
                event => subagentRegistry.update(run.id, event.status, event.message),
                handle => {
                  const current = subagentRegistry.get(run.id)
                  if (current) current.cancel = handle.interrupt
                }
              )
              subagentRegistry.complete(run.id, summary)
            } catch (err: any) {
              subagentRegistry.fail(run.id, String(err?.message || err || 'Unknown subagent error'))
            }
          })()

          summaries.push({
            id: run.id,
            goal,
            workspace,
            agent: agent?.name,
            worktree: worktree?.path,
            status: 'running',
            hint: 'Track with /agents, stop with /agents stop <id>.'
          })
        }

        return JSON.stringify({ results: summaries })
      }
    })
  }

}

export function registerDeferredToolTools(): void {
  const deferredTools = (context?: ToolContext) => registry.getDeferredTools(context?.toolWhitelist, context?.mcpToolNames)
  registry.register({
    name: 'tool_search', toolset: 'core',
    schema: { name: 'tool_search', description: 'Find deferred tools by name or capability. Returns each tool with its full parameter schema, so tool_call can be used directly (tool_describe is only needed for extra detail).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    handler: async (args, context) => {
      const query = String(args.query || '').toLowerCase().trim()
      if (!query) return JSON.stringify({ error: 'query is required' })
      const stopwords = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to', 'with', 'tool', 'tools'])
      const words = [...new Set(query.match(/[a-z0-9_-]+/g) || [])].filter(word => word.length > 1 && !stopwords.has(word))
      if (!words.length) return JSON.stringify({ results: [] })
      const results = deferredTools(context).map(tool => {
        const name = tool.name.toLowerCase()
        const description = tool.schema.description.toLowerCase()
        const text = `${name.replace(/[_-]/g, ' ')} ${description}`
        const score = words.reduce((total, word) => total + (name.includes(word) ? 4 : 0) + (text.includes(word) ? 1 : 0), 0)
          + (text.includes(query) ? 3 : 0)
        return { name: tool.name, description: tool.schema.description, parameters: tool.schema.parameters, health: deferredToolHealth(tool.name, context), score }
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 10)
      return JSON.stringify({ results: results.map(({ score: _score, ...item }) => item) })
    }
  })
  registry.register({
    name: 'tool_describe', toolset: 'core',
    schema: { name: 'tool_describe', description: 'Return full schema for one deferred tool.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    handler: async (args, context) => {
      const tool = deferredTools(context).find(item => item.name === args.name)
      return tool ? JSON.stringify(tool.schema) : JSON.stringify({ error: 'Deferred tool not found or unavailable' })
    }
  })
  registry.register({
    name: 'tool_call', toolset: 'core',
    schema: { name: 'tool_call', description: 'Execute a deferred tool found with tool_search (tool_describe is optional).', parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'] } },
    handler: async () => JSON.stringify({ error: 'tool_call must be dispatched by the agent runtime' })
  })}
