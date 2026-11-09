import type { Message } from '../providers/providers'
import type { SkillLoader } from '../skills/skills'
import type { DeepMemoryFact } from '../memory/deep_memory'
import { buildPlanPrompt } from '../core/plan_prompt'
import { isTaskExecutionRequest, previousTaskGoal } from './agent_task_intent'
import { buildDeepMemoryBlock, buildSkillPreloadText, selectSkillToPreload, type PreloadableSkill } from './turn_setup'

/**
 * Turn stage 1 — setup, before any provider call.
 *
 * Everything that shapes the request but never touches the provider lives here:
 * `/plan` rewriting, appending the user message, the auto-checklist item, skill
 * preloading and deep-memory injection. Extracted from agent.ts so the loop only
 * orchestrates.
 */

export interface TurnSetupDeps {
  isSubagent: boolean
  userMessage: string
  conversationHistory: Message[]
  skillLoader: Pick<SkillLoader, 'getRelevantSkills'>
  /** Skill loaded explicitly by the user/model; sticky, unlike auto-matches. */
  activeSkill: PreloadableSkill | null
  contextWindow: number
  todoStore: {
    read(): Array<{ id: string; status: string }>
    write(todos: Array<{ id: string; content: string; status: 'in_progress' }>, persist?: boolean): void
  }
  saveCurrentSession: () => void
  deepMemoryFacts: (query: string, limit: number) => DeepMemoryFact[]
  onPreloadToolStart?: (info: { id: string; name: string; args: Record<string, unknown>; preview: string }) => void
}

export interface TurnSetup {
  effectiveUserMessage: string
  trimmedUserMsg: string
  currentUserMessage: Message
  skillToPreload: PreloadableSkill | null
  preloadedSkillText: string
  preloadedDeepMemoryText: string
  /** true when the runtime created the `request-*` checklist item for this message. */
  createdAutoGoal: boolean
}

export function prepareTurnSetup(deps: TurnSetupDeps): TurnSetup {
  const trimmedUserMsg = deps.userMessage.trim()

  // /plan built-in: rewrite turn to plan-mode prompt (Hermes pattern)
  let effectiveUserMessage = deps.userMessage
  const isPlanCommand = /^\/plan(?:\s|$)/.test(trimmedUserMsg)
  if (isPlanCommand) {
    const task = trimmedUserMsg.length > 5 ? trimmedUserMsg.slice(5).trim() : ''
    effectiveUserMessage = buildPlanPrompt(task)
  }

  const currentUserMessage: Message = { role: 'user', content: effectiveUserMessage }
  deps.conversationHistory.push(currentUserMessage)

  const hasOpenTask = deps.todoStore.read().some(todo => todo.status === 'pending' || todo.status === 'in_progress')
  let createdAutoGoal = false
  if (!deps.isSubagent && !hasOpenTask && !isPlanCommand && isTaskExecutionRequest(trimmedUserMsg)) {
    const goal = previousTaskGoal(deps.conversationHistory.slice(0, -1), trimmedUserMsg).replace(/\s+/g, ' ').trim().slice(0, 800)
    deps.todoStore.write([{ id: `request-${Date.now()}`, content: goal, status: 'in_progress' }], true)
    try { deps.saveCurrentSession() } catch {}
    createdAutoGoal = true
  }

  // Auto-matched skills apply to this turn only: they must not linger after the topic changes.
  // Only an explicit skill_view (handled when the tool result lands) becomes sticky.
  const skillToPreload = selectSkillToPreload(deps.skillLoader, effectiveUserMessage, deps.activeSkill)

  let preloadedDeepMemoryText = ''
  if (!deps.isSubagent) {
    preloadedDeepMemoryText = buildDeepMemoryBlock(deps.deepMemoryFacts(trimmedUserMsg, 3))
  }

  let preloadedSkillText = ''
  if (skillToPreload) {
    try {
      deps.onPreloadToolStart?.({
        id: `preload-${skillToPreload.name}`,
        name: 'skill_view',
        args: { name: skillToPreload.name },
        preview: `preparing skill_view ${skillToPreload.name}`
      })
    } catch {}
    preloadedSkillText = buildSkillPreloadText(skillToPreload, deps.contextWindow)
  }

  return {
    effectiveUserMessage,
    trimmedUserMsg,
    currentUserMessage,
    skillToPreload,
    preloadedSkillText,
    preloadedDeepMemoryText,
    createdAutoGoal
  }
}
