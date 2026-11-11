/**
 * Shell completion scripts: `vallenemperor completion bash|zsh|fish`.
 * Kept static and dependency-free so it works in every shell without a generator.
 */

const COMMANDS = ['setup', 'doctor', 'update', 'config', 'completion', '--help', '--version', '-p', '--resume', '--model', '--approval', '--json', '--quiet']

const BASH = `# vallenemperor bash completion
_vallenemperor() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local opts="${COMMANDS.join(' ')}"
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _vallenemperor vallenemperor
`

const ZSH = `# vallenemperor zsh completion
#compdef vallenemperor
_vallenemperor() {
  local -a opts
  opts=(${COMMANDS.map(command => `'${command}'`).join(' ')})
  _describe 'command' opts
}
_vallenemperor "$@"
`

const FISH = `# vallenemperor fish completion
${COMMANDS.map(command => `complete -c vallenemperor -a '${command}'`).join('\n')}
`

export function completionScript(shell) {
  const name = String(shell || '').toLowerCase()
  if (name === 'bash') return BASH
  if (name === 'zsh') return ZSH
  if (name === 'fish') return FISH
  return null
}

export function runCompletionCommand({ shell, stdout = process.stdout }) {
  const script = completionScript(shell)
  if (!script) {
    stdout.write('Usage: vallenemperor completion bash|zsh|fish\n')
    return 2
  }
  stdout.write(script)
  return 0
}
