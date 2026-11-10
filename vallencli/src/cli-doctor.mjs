import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchGatewayModels } from './cli-model-picker.mjs'

/**
 * `vallenemperor doctor` — one screen that says what is broken and how to fix it.
 * Every probe is injectable so the whole matrix is testable without a network or a real home.
 */

export const OK = 'OK'
export const WARN = 'WARN'
export const FAIL = 'FAIL'

function check(name, status, detail, fix) {
  return { name, status, detail, fix }
}

export async function runDoctor({ home, config, probes = {} }) {
  const checks = []

  const nodeVersion = probes.nodeVersion || process.version
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0])
  checks.push(check('node', major >= 20 ? OK : FAIL, nodeVersion,
    major >= 20 ? '' : 'Install Node 20 or newer from nodejs.org.'))

  const active = config?.providers?.active
  const provider = active ? config.providers[active] : null
  checks.push(check('provider', active && provider ? OK : FAIL,
    active && provider ? `${active} · ${provider.base_url || 'no base_url'} · ${provider.model || 'no model'}` : 'no active provider',
    active && provider ? '' : 'Run `vallenemperor setup` or `vallenemperor config set provider <preset>`.'))

  if (provider) {
    const key = provider.api_key || (provider.env ? process.env[provider.env] : '')
    const local = /(127\.0\.0\.1|localhost)/.test(String(provider.base_url || ''))
    const keyOk = Boolean(key) || local
    checks.push(check('api key', keyOk ? OK : WARN,
      key ? 'configured (value hidden)' : local ? 'not needed (local endpoint)' : 'not set',
      keyOk ? '' : 'Set the key with /token, or export the provider env var before starting.'))
  }

  if (provider?.base_url && probes.fetchModels) {
    const started = Date.now()
    try {
      const models = await probes.fetchModels({ baseUrl: provider.base_url, apiKey: provider.api_key || '' })
      const elapsed = Date.now() - started
      checks.push(check('endpoint', models.length ? OK : WARN, `${models.length} models in ${elapsed}ms`,
        models.length ? '' : 'The endpoint answered but returned no models; check the base URL path (/v1).'))
    } catch (error) {
      checks.push(check('endpoint', WARN, String(error?.message || error).slice(0, 160),
        'Check the base URL, that the local router is running, and your network.'))
    }
  }

  const homeOk = probes.canWrite ? probes.canWrite(home) : (() => {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      const probe = join(home, `.doctor-${process.pid}`)
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
      return true
    } catch { return false }
  })()
  checks.push(check('data dir', homeOk ? OK : FAIL, home, homeOk ? '' : 'Fix permissions on the VallenEmperor home directory.'))

  const skillsDir = join(home, 'skills')
  const skillsOk = probes.skillsReadable ? probes.skillsReadable(skillsDir) : (() => {
    try { accessSync(skillsDir, constants.R_OK); return true } catch { return existsSync(skillsDir) }
  })()
  checks.push(check('skills', skillsOk ? OK : WARN, skillsOk ? skillsDir : 'directory missing',
    skillsOk ? '' : 'Run any session once; bundled skills are copied on first run.'))

  const gitOk = probes.isGit ? probes.isGit() : (() => {
    try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true } catch { return false }
  })()
  checks.push(check('git', gitOk ? OK : WARN, gitOk ? 'available' : 'not found',
    gitOk ? '' : 'Install git for checkpoints, worktrees, and `/diff working`.'))

  return checks
}

export function doctorExitCode(checks) {
  return checks.some(item => item.status === FAIL) ? 1 : 0
}

export function formatDoctor(checks, { json = false } = {}) {
  if (json) return JSON.stringify({ ok: !checks.some(c => c.status === FAIL), checks }, null, 2)
  const lines = ['VallenEmperor doctor', '']
  for (const item of checks) {
    const mark = item.status === OK ? '✔' : item.status === WARN ? '▲' : '✖'
    lines.push(`${mark} ${item.status.padEnd(4)} ${item.name.padEnd(10)} ${item.detail}`)
    if (item.fix) lines.push(`         ↳ ${item.fix}`)
  }
  const failed = checks.filter(c => c.status === FAIL).length
  const warned = checks.filter(c => c.status === WARN).length
  lines.push('', failed ? `${failed} check(s) failed.` : warned ? `${warned} warning(s).` : 'All checks passed.')
  return lines.join('\n')
}

export async function runDoctorCommand({ core, json = false, stdout = process.stdout }) {
  const checks = await runDoctor({
    home: core.getVallenHome(),
    config: core.loadConfig(),
    probes: {
      fetchModels: async ({ baseUrl, apiKey }) => {
        const result = await fetchGatewayModels({ baseUrl, apiKey, timeoutMs: 8000 })
        if (!result.ok) throw new Error(result.error || 'request failed')
        return result.models.map(model => model.id)
      }
    }
  })
  stdout.write(`${formatDoctor(checks, { json })}\n`)
  return doctorExitCode(checks)
}
