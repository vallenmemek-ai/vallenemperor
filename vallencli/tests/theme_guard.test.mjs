import test from 'node:test'
import assert from 'node:assert/strict'

import { themeNames } from '../dist/cli-theme.js'
import { THEME_NAMES } from '../../vallenagent/dist/core/theme_store.js'

// The agent's set_theme tool validates against core's list while the CLI paints with
// its own table. If they drift, the tool accepts a name the CLI cannot render.
test('core theme names match the CLI theme table', () => {
  assert.deepEqual([...THEME_NAMES], themeNames())
})
