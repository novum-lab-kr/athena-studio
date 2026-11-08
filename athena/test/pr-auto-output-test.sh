#!/usr/bin/env bash
# 현황판 scripts/board/server.mjs → scripts/lib/pr-auto-output.mjs → pr-auto.mjs 의 출력 보존.
. "$(dirname "$0")/_lib.sh"
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { outputSink, outputFile, MAX_LOG_BYTES } from './scripts/lib/pr-auto-output.mjs'
const root = mkdtempSync('/tmp/athena-pr-output-')
try {
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts/pr-auto.mjs'), `
    import { spawn } from 'node:child_process'
    if (process.argv.includes('--fail')) { console.error('startup failure'); process.exit(7) }
    if (process.argv.includes('--watch')) {
      setTimeout(() => { console.log('worker stdout'); console.error('worker stderr') }, 100)
    } else {
      console.log('enqueue stdout'); console.error('enqueue stderr')
      spawn(process.execPath, [import.meta.filename, '--watch'], { detached: true, stdio: ['ignore', 1, 2] }).unref()
    }
  `)
  const run = spawnSync(process.execPath, [resolve('scripts/lib/pr-auto-output.mjs'), root, '--enqueue'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(run.status, 0, run.stderr)
  const file = outputFile(root)
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  for (const text of ['enqueue stdout', 'enqueue stderr', 'worker stdout', 'worker stderr']) assert.ok(records.some(record => record.text === text), text)
  assert.ok(records.some(record => record.source === 'stderr'))
  const failed = spawnSync(process.execPath, [resolve('scripts/lib/pr-auto-output.mjs'), root, '--fail'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(failed.status, 7)
  assert.ok(readFileSync(file, 'utf8').includes('code=7'))
  const sink = outputSink(file, 'stderr', 'test')
  const fakeSecret = 'synthetic-value-for-masking'
  sink.write(Buffer.from('API_TOKEN=' + fakeSecret.slice(0, 5)))
  sink.write(Buffer.from(fakeSecret.slice(5) + '\nAuthorization: Basic ' + Buffer.from(fakeSecret).toString('base64') + '\n'))
  const keyHeader = ['-----', 'BEGIN PRIVATE KEY', '-----'].join('')
  const keyFooter = ['-----', 'END PRIVATE KEY', '-----'].join('')
  sink.write(Buffer.from(`${keyHeader}\n${fakeSecret}\n${keyFooter}\n`))
  sink.write(Buffer.from('x'.repeat(20000)))
  sink.write(Buffer.from('TOKEN=' + fakeSecret + '\n'))
  sink.end()
  const masked = readFileSync(file, 'utf8')
  assert.ok(!masked.includes(fakeSecret))
  assert.ok(!masked.includes(Buffer.from(fakeSecret).toString('base64')))
  assert.ok(masked.includes('[긴 출력 줄 생략]'))
  for (let index = 0; index < 150; index++) sink.write(Buffer.from('한글'.repeat(2000) + '\n'))
  assert.ok(statSync(file).size <= MAX_LOG_BYTES)
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) assert.ok(JSON.parse(line).source)
  // 상한에 닿은 파일에 여러 프로세스가 기록해도 새 기록은 전부 남아야 한다.
  // 새 기록 합계는 상한보다 작으므로 축소가 제거할 수 있는 것은 앞의 seed 뿐이다.
  const concurrentFile = join(root, 'concurrent.jsonl')
  const seed = `${JSON.stringify({ source: 'seed', text: 's'.repeat(1024) })}\n`
  writeFileSync(concurrentFile, seed.repeat(Math.floor((MAX_LOG_BYTES - 4096) / Buffer.byteLength(seed))))
  const writers = 8
  const perWriter = 20
  const writerCode = `
    import { outputSink } from ${JSON.stringify('file://' + resolve('scripts/lib/pr-auto-output.mjs'))}
    const [file, writer, start] = process.argv.slice(1)
    const sink = outputSink(file, 'stdout', writer)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(start) - Date.now()))
    for (let index = 0; index < ${perWriter}; index++) sink.write(Buffer.from(writer + ':' + index + ':' + 'x'.repeat(4000) + '\\n'))
    sink.end()
  `
  const start = String(Date.now() + 500)
  await Promise.all(Array.from({ length: writers }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', writerCode, concurrentFile, String(index), start], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errorText = ''
    child.stderr.on('data', chunk => { errorText += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errorText)))
  })))
  const concurrent = readFileSync(concurrentFile, 'utf8').trim().split('\n').map(JSON.parse).filter(record => record.source !== 'seed')
  assert.equal(concurrent.length, writers * perWriter, '축소와 경쟁한 새 기록 유실')
  assert.equal(new Set(concurrent.map(record => record.text.split(':').slice(0, 2).join(':'))).size, writers * perWriter)
  assert.ok(statSync(concurrentFile).size <= MAX_LOG_BYTES)
  const board = readFileSync('scripts/board/server.mjs', 'utf8')
  assert.equal((board.match(/join\(ROOT, 'scripts\/lib\/pr-auto-output.mjs'\)/g) || []).length, 2)
  assert.match(readFileSync('scripts/pr-auto.mjs', 'utf8'), /ATHENA_PR_AUTO_CAPTURE === '1'/)
  const html = readFileSync('scripts/board/index.html', 'utf8')
  assert.ok(!html.includes('hermes main 에'))
  assert.ok(html.includes("t('action.selfIssueStart', { id: card.id })"))
  for (const lang of ['ko', 'en', 'ja', 'zh']) {
    const text = JSON.parse(readFileSync(`scripts/board/i18n/${lang}.json`, 'utf8'))['action.selfIssueStart']
    assert.ok(text.includes('{id}') && text.includes('prBase') && text.includes('draft PR'))
  }
  console.log('✔ 현황판·백그라운드 처리기 stdout/stderr 보존 · 청크 경계 마스킹 · 비밀키 · 크기 상한 · 작업 시작 4개 언어')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
