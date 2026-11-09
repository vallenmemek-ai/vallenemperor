import { registry, ToolSchema } from '../tools'
import { MemoryStore } from '../../memory/memory'
import { TodoStore } from '../../session/todo'
import { DeepMemoryStore } from '../../memory/deep_memory'
import { isTruthy } from './file_tools'
import { evaluateClarifyRequest, formatClarifyOutcome, MAX_CLARIFY_CHOICES, MAX_CLARIFY_QUESTIONS } from '../../agent/clarify_policy'

export function registerStateTools(memory: MemoryStore, todo: TodoStore): void {
  // 9. clarify
  const clarifySchema: ToolSchema = {
    name: 'clarify',
    description: 'Ask the user one blocking decision before proceeding. Use only when the answer changes what you build/run AND it cannot be resolved from the repo, the conversation, or a convention, AND guessing wrong is costly (destructive/irreversible, money, external side effects). Never ask for style, naming, layout, equivalent library choice, permission to continue, or anything a quick file read answers — pick the default, state it, and continue.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          maxItems: MAX_CLARIFY_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'One blocking decision, stated in one sentence' },
              choices: { type: 'array', maxItems: MAX_CLARIFY_CHOICES, items: { type: 'string' }, description: 'Predefined choices (recommended first)' },
              multi_select: { type: 'boolean', description: 'Allow multiple selections' }
            },
            required: ['question']
          },
          description: 'Questions to ask the user (only blocking decisions)'
        }
      },
      required: ['questions']
    }
  }

  registry.register({
    name: 'clarify',
    schema: clarifySchema,
    toolset: 'clarify',
    handler: async (args) => {
      // Policy gate: a preference poll or a "may I continue?" is not worth stopping the turn.
      return formatClarifyOutcome(evaluateClarifyRequest(args?.questions))
    }
  })

  // 10. memory
  const memorySchema: ToolSchema = {
    name: 'memory',
    description: 'Save durable facts to persistent memory (MEMORY.md = notes/lessons, USER.md = user profile) that survive across sessions.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'Action to perform' },
        target: { type: 'string', enum: ['memory', 'user'], description: 'Which store: memory for personal notes, user for user profile' },
        content: { type: 'string', description: 'Entry content for add/replace' },
        old_text: { type: 'string', description: 'Unique substring identifying existing entry to replace/remove' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'replace', 'remove'] },
              target: { type: 'string', enum: ['memory', 'user'] },
              content: { type: 'string' },
              new_text: { type: 'string' },
              old_text: { type: 'string' }
            },
            required: ['action']
          },
          description: 'Batch operations array'
        }
      },
      required: ['target']
    }
  }

  registry.register({
    name: 'memory',
    schema: memorySchema,
    toolset: 'memory',
    handler: async (args, context) => {
      const mem = context?.stores?.memory || memory
      const target = (args.target || 'memory') as 'memory' | 'user'
      const action = String(args.action || 'add')
      const content = String(args.content || args.new_text || '')
      const oldText = String(args.old_text || '')
      if (context?.reviewMode) {
        if (Array.isArray(args.operations)) return JSON.stringify({ error: 'Review mode cannot batch memory writes.' })
        if (action !== 'add') return JSON.stringify({ error: `Review mode cannot perform memory action '${action}'; replacement/removal needs user approval.` })
        if (!context.reviewUserMessages?.some(message => message.includes(content.trim()))) return JSON.stringify({ error: 'Review mode memory additions must be exact user quotes from this review.' })
      }

      if (Array.isArray(args.operations) && args.operations.length > 0) {
        const res = await mem.batch(args.operations, target)
        return JSON.stringify(res)
      }

      if (action === 'add') {
        return JSON.stringify(await mem.add(target, content))
      } else if (action === 'replace') {
        return JSON.stringify(await mem.replace(target, oldText, content))
      } else if (action === 'remove') {
        return JSON.stringify(await mem.remove(target, oldText))
      }

      return JSON.stringify({ error: `Unknown memory action: ${action}` })
    }
  })

  registry.register({
    name: 'deep_memory', toolset: 'memory',
    schema: { name: 'deep_memory', description: 'Search or add longer-term user facts, kept outside the automatic system prompt. Add only an exact quote from a user message and include source_session.', parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'add', 'replace', 'forget', 'list', 'history'] },
      query: { type: 'string' },
      fact: { type: 'string', description: 'Exact user-stated fact quote, max 500 chars' },
      old_fact: { type: 'string', description: 'Exact existing fact to replace or forget' },
      source_session: { type: 'string', description: 'Session ID containing exact quote in a user message' },
      expires_at: { type: 'string', description: 'Optional ISO date when this fact stops being recalled' },
      limit: { type: 'integer' }
    }, required: ['action'] } },
    handler: async (args, context) => {
      const store = new DeepMemoryStore()
      const action = String(args.action)
      const fact = String(args.fact || '')
      if (context?.reviewMode && (action === 'replace' || action === 'forget')) return JSON.stringify({ error: `Review mode cannot perform deep-memory action '${action}'; user approval required.` })
      if (context?.reviewMode && action === 'add' && !context.reviewUserMessages?.some(message => message.includes(fact.trim()))) return JSON.stringify({ error: 'Review mode deep-memory additions must be exact user quotes from this review.' })
      if (action === 'add') return JSON.stringify(store.add(fact, String(args.source_session || ''), args.expires_at ? String(args.expires_at) : undefined))
      if (action === 'replace') return JSON.stringify(store.replace(String(args.old_fact || ''), fact, String(args.source_session || ''), args.expires_at ? String(args.expires_at) : undefined))
      if (action === 'forget') return JSON.stringify(store.forget(String(args.old_fact || fact)))
      if (action === 'list') return JSON.stringify({ data: 'untrusted memory facts', entries: store.list() })
      if (action === 'history') return JSON.stringify({ data: 'untrusted memory history', entries: store.history().slice(-Math.max(1, Math.min(50, Number(args.limit) || 20))) })
      if (action === 'search') return JSON.stringify({ data: 'untrusted memory facts', entries: store.search(String(args.query || ''), Number(args.limit) || 10) })
      return JSON.stringify({ error: `Unknown deep_memory action: ${action}` })
    }
  })

  // 11. todo_list
  const todoListSchema: ToolSchema = {
    name: 'todo_list',
    description: 'Track and manage task list for multi-step work. Pass todos to update/merge; omit to read active todos.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Task ID' },
              content: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
            },
            required: ['id']
          },
          description: 'Task entries to write or merge'
        },
        merge: { type: 'boolean', description: 'Merge with existing items instead of replacing (default: false)' }
      }
    }
  }

  registry.register({
    name: 'todo_list',
    schema: todoListSchema,
    toolset: 'todo',
    handler: async (args, context) => {
      const td = context?.stores?.todo || todo
      if (Array.isArray(args.todos)) {
        const updated = td.write(args.todos, isTruthy(args.merge))
        return JSON.stringify({ todos: updated, active_count: updated.filter((t: any) => t.status !== 'completed' && t.status !== 'cancelled').length })
      }
      return JSON.stringify({ todos: td.read() })
    }
  })

}
