import { registerWebTools } from './builtin_tools/web_tools'
export { fuzzyReplace, unescapeString } from '../core/patch_engine'
export { fetchSafeUrl, isPrivateAddress, validateSafeUrl } from '../core/network_safety'
import { SkillLoader } from '../skills/skills'
import { MemoryStore } from '../memory/memory'
import { TodoStore } from '../session/todo'
import { registerStateTools } from './builtin_tools/state_tools'
import { registerSessionTools } from './builtin_tools/session_tools'
import { registerFileTools, registerPatchTools, registerListTools } from './builtin_tools/file_tools'
import { registerDiagnosticsTools } from './builtin_tools/diagnostics_tools'
import { registerCheckpointTools } from './builtin_tools/checkpoint_tools'
import { registerScheduleTools } from './builtin_tools/schedule_tools'
import { registerThemeTools } from './builtin_tools/theme_tools'
import { registerTtsTools } from './builtin_tools/tts_tools'
import { registerVideoTools } from './builtin_tools/video_tools'
import { registerTerminalTools } from './builtin_tools/terminal_tools'
import { registerSkillsTools } from './builtin_tools/skills_tools'
import { registerMediaTools } from './builtin_tools/media_tools'
export { isTruthy } from './builtin_tools/file_tools'
import { registerBrowserTools } from './builtin_tools/browser_tools'
import { registerIntegrationTools, registerDeferredToolTools } from './builtin_tools/integration_tools'

export { truncateOutput } from './builtin_tools/tool_output'

let builtinToolsRegistered = false

// --- Tools Implementation ---

export function registerBuiltinTools(
  skillLoader?: SkillLoader,
  memoryStore?: MemoryStore,
  todoStore?: TodoStore,
  delegateAgentFactory?: (task: { taskId: string; goal: string; context?: string; max_iterations?: number; max_output_tokens?: number; model?: string; cwd?: string; agentInstructions?: string; tools?: string[] }, onProgress?: (event: { status: 'thinking' | 'tool_start' | 'tool_end'; message?: string }) => void, onHandle?: (handle: { interrupt: () => void }) => void) => Promise<string>,
  isSubagent: boolean = false,
  force: boolean = false,
  delegation: { depth?: number; maxDepth?: number } = {}
): void {
  if (builtinToolsRegistered && !force) return
  const memory = memoryStore || new MemoryStore()
  const todo = todoStore || new TodoStore()

  registerFileTools()

  registerListTools()

  registerDiagnosticsTools()

  registerCheckpointTools()

  registerScheduleTools()
  registerThemeTools()
  registerTtsTools()
  registerVideoTools()

  registerSessionTools()

  registerTerminalTools()

  registerWebTools()

  registerStateTools(memory, todo)

  registerMediaTools()

  registerBrowserTools()

  registerIntegrationTools(isSubagent, delegateAgentFactory, delegation)

  registerSkillsTools(skillLoader)

  registerPatchTools()

  registerDeferredToolTools()
  builtinToolsRegistered = true
}
