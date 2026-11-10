// Config types mirroring Hermes structure
export interface ProviderConfig {
  base_url: string
  api_key: string
  model: string
  enabled: boolean
  api_mode?: 'openai_chat_completions' | 'anthropic_messages'
  fallback_models?: string[]
}

import type { McpServerConfig } from '../mcp/types'

export interface AgentConfig {
  mcpServers?: Record<string, McpServerConfig>
  /** Tool-approval mode: dangerous (gate risky ops, default), all, off. */
  approval?: 'dangerous' | 'all' | 'off'
  /** Filesystem sandbox. 'workspace' confines main-agent writes to the working directory (subagents are always confined). */
  security?: {
    filesystem?: 'workspace' | 'unrestricted'
  }
  /** Run the project's formatter on files the agent edits. `{file}` is substituted. */
  formatter?: {
    command?: string
    extensions?: string[]
  }
  /** Inject a compact symbol map of the workspace into the system prompt (Aider-style). */
  repo_map?: {
    enabled?: boolean
    budget_chars?: number
  }
  /** Lifecycle hooks: shell commands with JSON stdin/stdout; pre_tool and user_prompt can block. */
  hooks?: Partial<Record<'session_start' | 'user_prompt' | 'pre_tool' | 'post_tool' | 'turn_end' | 'session_end', Array<{ command: string; matcher?: string; timeout_ms?: number }>>>
  /** Stage cross-session writes for review instead of committing them immediately. */
  write_approval?: {
    memory?: boolean
    skills?: boolean
  }
  providers: {
    active: string
    [key: string]: string | ProviderConfig
  }
  max_iterations?: number
  /** Budget of OUTPUT (completion) tokens per user turn. Prompt tokens are not counted. */
  max_tokens_per_turn?: number
  /** Cap for max_tokens on a single provider request (default 16384). */
  max_output_tokens?: number
  /** Sampling temperature sent to the provider. Unset = provider/router default. 0-0.3 is recommended for coding. */
  temperature?: number
  /** Reasoning effort for models that support it (low | medium | high). Sent as reasoning_effort. */
  reasoning_effort?: 'low' | 'medium' | 'high'
  context_windows?: Record<string, number>
  /** Context window assumed for models missing from context_windows (default 128000). */
  default_context_window?: number
  skills?: {
    paths?: string[]
    disabled?: string[]
    enabled?: string[]
  }
  terminal?: {
    cwd?: string
  }
  gateway?: {
    background_review?: boolean
    /** true (default) = compaction boleh memakai satu panggilan model untuk ringkasan yang lebih kaya. */
    llm_compaction?: boolean
    background_review_interval?: number
    telegram?: {
      approval?: 'dangerous' | 'all' | 'off'
      max_iterations?: number
      turn_timeout_ms?: number
    }
  }
}

export interface ThemeColors {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
  foreground: string
  background: string
}
