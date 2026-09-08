import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const configUrl = new URL('../src/config.js', import.meta.url).href
function environment(values = {}) {
  const env = { ...process.env }
  for (const key of ['NODE_ENV', 'TOKEN_SECRET', 'ADMIN_DIR', 'H5_DIR']) delete env[key]
  return { ...env, ...values }
}
function evaluate(source, values = {}) {
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { loadConfig } from ' + JSON.stringify(configUrl) + ';' + source],
    { env: environment(values), encoding: 'utf8' }).trim()
}

test('production refuses missing and short token signing keys', () => {
  for (const key of ['', randomBytes(4).toString('hex')]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { loadConfig } from ' + JSON.stringify(configUrl) + ';loadConfig()'],
      { env: environment({ NODE_ENV: 'production', TOKEN_SECRET: key }), encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /TOKEN_SECRET/)
  }
})

test('production uses the configured key; development keys change between processes', () => {
  const key = randomBytes(32).toString('hex')
  assert.equal(evaluate('console.log(loadConfig().tokenSecret)', { NODE_ENV: 'production', TOKEN_SECRET: key }), key)
  const first = evaluate('console.log(loadConfig().tokenSecret)')
  const second = evaluate('console.log(loadConfig().tokenSecret)')
  assert.notEqual(first, second)
  assert.ok(first.length >= 32)
})

test('repository paths can be configured independently of local folder names', () => {
  const paths = JSON.parse(evaluate('const c=loadConfig();console.log(JSON.stringify([c.adminDir,c.h5Dir]))',
    { ADMIN_DIR: '../xin-binlang-admin', H5_DIR: '../xin-binlang-app/dist/build/h5' }))
  const backendRoot = fileURLToPath(new URL('..', import.meta.url))
  assert.deepEqual(paths, [resolve(backendRoot, '../xin-binlang-admin'), resolve(backendRoot, '../xin-binlang-app/dist/build/h5')])
})
