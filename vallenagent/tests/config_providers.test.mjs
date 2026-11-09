import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, PROVIDER_PRESETS, providerPresetConfig, validateProviderConfig, getActiveProvider } from '../dist/core/config.js'

const configWith = (providers) => ({ ...structuredClone(DEFAULT_CONFIG), providers })

test('every preset produces a valid provider configuration', () => {
  for (const name of Object.keys(PROVIDER_PRESETS)) {
    const provider = providerPresetConfig(name)
    assert.equal(provider.enabled, true)
    assert.ok(provider.model, `${name} needs a default model`)
    assert.match(provider.base_url, /^https?:\/\//, `${name} needs a real base_url`)

    const config = configWith({ active: name, [name]: provider })
    const report = validateProviderConfig(config)
    assert.equal(report.ok, true, `${name} preset must validate: ${report.errors.join('; ')}`)
  }
})

test('the api key comes from the environment, never from the preset itself', () => {
  const previous = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'sk-test-from-env'
  try {
    assert.equal(providerPresetConfig('deepseek').api_key, 'sk-test-from-env')
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previous
  }
})

test('an active provider that does not exist is a clear error', () => {
  const report = validateProviderConfig(configWith({ active: 'nope', deepseek: providerPresetConfig('deepseek') }))
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /providers\.active "nope" does not exist/)
  assert.match(report.errors.join('\n'), /deepseek/)
})

test('an empty or malformed base_url is a clear error', () => {
  const empty = validateProviderConfig(configWith({ active: 'x', x: { base_url: '', api_key: 'k', model: 'm', enabled: true } }))
  assert.equal(empty.ok, false)
  assert.match(empty.errors.join('\n'), /empty base_url/)

  const malformed = validateProviderConfig(configWith({ active: 'x', x: { base_url: 'not a url', api_key: 'k', model: 'm', enabled: true } }))
  assert.equal(malformed.ok, false)
  assert.match(malformed.errors.join('\n'), /not a valid URL/)

  assert.throws(
    () => getActiveProvider(configWith({ active: 'x', x: { base_url: '', api_key: 'k', model: 'm', enabled: true } })),
    /no valid base_url/
  )
})

test('a missing api_key points at the environment variable instead of failing silently', () => {
  const previous = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const report = validateProviderConfig(configWith({ active: 'openai', openai: { base_url: 'https://api.openai.com/v1', api_key: '', model: 'gpt-4o-mini', enabled: true } }))
    assert.equal(report.ok, true, 'a missing key is a warning, not a config error')
    assert.match(report.warnings.join('\n'), /OPENAI_API_KEY/)
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous
  }
})
