/**
 * `/learn` — turn a source (a session, a directory, a URL, pasted notes) into a reusable skill.
 *
 * Same shape as `/plan`: no engine, no special tool. The live agent gathers sources with its normal
 * tools and authors the skill through `skill_manage`, following explicit authoring standards. That
 * keeps it working on every surface and backend.
 */

export const LEARN_AUTHORING_STANDARDS = `Skill authoring standards (follow exactly):
- name: lowercase-hyphenated, <= 64 chars, no spaces.
- description: ONE sentence, <= 60 characters, ends with a period. State the capability, not the
  implementation. No marketing words. Do not repeat the name. Count the characters before saving —
  the skill index truncates at 60 and anything past that never routes.
- Structure: '# <Skill> Skill' title, 2-3 sentence intro, '## When to Use', '## Prerequisites',
  '## Procedure' (ordered steps with the exact commands/tool calls and decision points),
  '## Pitfalls' (generalizable rule + one clause of why), '## Verification' (the command and the
  expected output).
- Capture the WORKFLOW and the pitfalls. Do not restate the codebase map or a tool's parameter list —
  those are already loaded context.
- One rule per lesson. If the rule already exists, strengthen the sentence instead of appending a
  second copy. Never write "UPDATE: actually ..." underneath an existing claim.
- No PR/issue numbers, dates, ticket IDs, or quoted user text as content. The rule must stand on its
  own.
- Never record environment failures as rules ("command not found", missing credentials). If a setup
  step was required, put the FIX in Prerequisites.`

export function buildLearnPrompt(source = ''): string {
  const target = String(source || '').trim()
  const sourceBlock = target
    ? `Source to learn from:\n${target}\n`
    : `No explicit source was given — use the current conversation (what we just did, including the
corrections the user made) as the source.\n`

  return `[/learn — author a skill]

${sourceBlock}
Process:
1. Gather the source with your normal tools (read_file, search_files, web_extract, session history).
   Read enough to describe the procedure precisely; do not guess steps.
2. Check whether a skill for this already exists with skills_list and skill_view. If it does, UPDATE
   that skill instead of creating a near-duplicate.
3. Author or update the skill with skill_manage. Put the always-on rules in SKILL.md; use a
   references/ file only for depth that is needed occasionally.
4. Verify the skill loads: skill_view it once and confirm the frontmatter parses.
5. Reply with: the skill name, the file path, and one line on what future sessions will do
   differently. Do not paste the whole skill back.

${LEARN_AUTHORING_STANDARDS}`
}
