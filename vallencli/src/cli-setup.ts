import { createInterface } from 'node:readline/promises'
import { fetchGatewayModels } from './cli-model-picker.js'

/**
 * `vallenemperor setup` — first-run wizard.
 *
 * Pure orchestration: every side effect (prompting, model fetch, config write, printing) is injected,
 * so the flow is testable without a terminal. The key is never printed and never logged; it is handed
 * straight to the config writer.
 */

export const SETUP_PRESETS = {
  openrouter: { label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4', env: 'OPENROUTER_API_KEY' },
  openai: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o', env: 'OPENAI_API_KEY' },
  anthropic: { label: 'Anthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4', env: 'ANTHROPIC_API_KEY' },
  deepseek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', env: 'DEEPSEEK_API_KEY' },
  '9router': { label: '9router (local)', base_url: 'http://127.0.0.1:20128/v1', model: 'ag/gemini-3.8-flash-medium', env: '' },
  ollama: { label: 'Ollama (local)', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder', env: '' }
}

export const APPROVAL_CHOICES = ['dangerous', 'all', 'off']

export async function runSetup(options) {
  const presets = options.presets || SETUP_PRESETS
  const names = Object.keys(presets)
  options.print('VallenEmperor setup — pick a provider, model, and approval mode.')

  const provider = await options.choose('Provider', names.map(name => `${name} (${presets[name].label})`))
    .then(choice => names.find(name => choice.startsWith(name)) || names[0])
  const preset = presets[provider]

  const baseUrlInput = await options.ask('Base URL', preset.base_url)
  const base_url = (baseUrlInput || preset.base_url).trim()

  let model = preset.model
  if (options.fetchModels) {
    try {
      const models = await options.fetchModels({ baseUrl: base_url })
      if (models.length) {
        const picked = await options.choose('Model', models.slice(0, 40))
        model = picked.trim()
      } else {
        options.print('No models returned by the endpoint; type the model id manually.')
        model = (await options.ask('Model id', preset.model)).trim() || preset.model
      }
    } catch (error) {
      options.print(`Could not list models (${error?.message || error}). Type the model id manually.`)
      model = (await options.ask('Model id', preset.model)).trim() || preset.model
    }
  } else {
    model = (await options.ask('Model id', preset.model)).trim() || preset.model
  }

  let apiKeySet = false
  if (preset.env) {
    const key = await options.ask(`API key (leave blank to read ${preset.env} from the environment)`, '')
    if (key.trim()) apiKeySet = true
  } else {
    options.print(`This preset does not need an API key${preset.env ? '' : ' (local endpoint)'}.`)
  }

  const approval = (await options.choose('Approval mode (dangerous = ask before risky tools)', APPROVAL_CHOICES)).trim()

  options.writeConfig({
    providers: {
      active: provider,
      [provider]: { base_url, model, enabled: true }
    },
    approval
  })

  options.print(`Saved. Provider: ${provider} · model: ${model} · approval: ${approval}`)
  options.print('Next: run `vallenemperor doctor`, then start a session and type /help.')
  return { provider, base_url, model, approval, apiKeySet }
}

/** Interactive wrapper used by the CLI. Refuses to run without a TTY. */
export async function runSetupCommand({ core, stdin = process.stdin, stdout = process.stdout }) {
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write('setup needs an interactive terminal.\n')
    stdout.write('Non-interactive alternative:\n')
    stdout.write('  vallenemperor config set provider <preset>\n')
    stdout.write('  vallenemperor config set model <model>\n')
    return 2
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const ask = async (question, fallback = '') => {
      const answer = await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)
      return answer.trim() || fallback
    }
    const choose = async (question, options) => {
      stdout.write(`\n${question}:\n`)
      options.forEach((option, index) => stdout.write(`  ${index + 1}. ${option}\n`))
      const answer = (await rl.question(`Choose 1-${options.length} [1]: `)).trim()
      const index = Number(answer || 1) - 1
      return options[index] || options[0]
    }
    const fetchModels = async ({ baseUrl }) => {
      const result = await fetchGatewayModels({ baseUrl, apiKey: '', timeoutMs: 15000 })
      if (!result.ok) throw new Error(result.error || 'request failed')
      return result.models.map(model => model.id).filter(Boolean)
    }
    await runSetup({
      ask,
      choose,
      print: line => stdout.write(`${line}\n`),
      fetchModels,
      writeConfig: patch => {
        const config = core.loadConfig()
        const merged = {
          ...config,
          ...patch,
          providers: { ...config.providers, ...patch.providers, active: patch.providers.active }
        }
        core.saveConfig(merged)
      }
    })
    return 0
  } finally {
    rl.close()
  }
}
