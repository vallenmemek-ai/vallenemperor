/**
 * `/grill-me` — interview before building.
 *
 * For an underspecified task, the cheapest bug is the one prevented by one good question. The agent
 * interviews the user one question at a time (with a recommended answer for each), then produces the
 * plan. Same shape as `/plan` and `/learn`: a prompt, not an engine.
 */

export function buildGrillPrompt(task = ''): string {
  const target = String(task || '').trim()
  const taskBlock = target
    ? `Task to clarify:\n${target}\n`
    : 'No task was given — clarify the thing we have been discussing.\n'

  return `[/grill-me — interview before building]

${taskBlock}
Rules for this turn:
1. Ask ONE question at a time. Never bundle questions.
2. Every question must offer your recommended answer first, with a one-line reason.
3. Ask only about decisions that change what gets built: scope boundaries, data sources, target
   platform, failure behaviour, what "done" means. Do not ask about style, naming, or file layout —
   pick the convention and state it.
4. Stop asking after at most 5 questions, or as soon as the remaining unknowns are cheap to change.
5. Do not write code or edit files in this turn.
6. Finish with a short summary: the decisions locked in, the assumptions you made, and the plan you
   would execute. Then ask for approval to start.

If the task is already fully specified, say so in one line, list the assumptions you would make, and
skip straight to the summary.`
}
