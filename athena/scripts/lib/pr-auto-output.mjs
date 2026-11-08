// @ts-check
// 현황판이 띄운 명령과 그 명령이 띄운 처리기의 출력까지 수집한다.
// 줄을 다 받은 뒤 가려서 청크 경계로 비밀값이 새지 않게 한다. 너무 긴 줄은 저장하지 않는다.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { paths } from './config.mjs'
import { maskText } from './mask.mjs'
import { isMainModule } from './is-main.mjs'
import { withPlanLock } from './plan-update.mjs'

export const MAX_LOG_BYTES = 1024 * 1024
const MAX_LINE = 16 * 1024
/** @param {string} root */
export const outputFile = (root) => join(paths(root).state, 'pr-auto-output.jsonl')

/** @param {string} file @param {string} source @param {string} run */
export const outputSink = (file, source, run) => {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let dropping = false
  let privateKey = false
  /** @param {string} line */
  const save = (line) => {
    line = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey = true
    if (privateKey) {
      if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey = false
      line = '[비밀키 내용 생략]'
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const record = `${JSON.stringify({ at: new Date().toISOString(), run, source, text: maskText(line) })}\n`
      // kick · enqueue · watch 의 수집기가 같은 파일에 쓴다. 기존 원자적 디렉터리
      // 잠금을 재사용해 추가부터 축소까지 묶고, 축소 중 다른 기록이 덮이지 않게 한다.
      withPlanLock(file, () => {
        appendFileSync(file, record, { mode: 0o600 })
        if (statSync(file).size > MAX_LOG_BYTES) {
          const tail = readFileSync(file).subarray(-MAX_LOG_BYTES)
          // 잘린 JSON · UTF-8 문자는 첫 줄과 함께 버린다.
          writeFileSync(file, tail.subarray(tail.indexOf(10) + 1), { mode: 0o600 })
        }
      })
    } catch { /* 로그 저장 실패로 처리기를 중단하지 않는다 */ }
  }
  return {
    /** @param {Buffer} chunk */
    write(chunk) {
      for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
        const ended = part.endsWith('\n')
        if (!dropping) pending += part
        if (pending.length > MAX_LINE) { pending = ''; dropping = true }
        if (ended) {
          save(dropping ? '[긴 출력 줄 생략]' : pending.trimEnd())
          pending = ''
          dropping = false
        }
      }
    },
    end() {
      pending += decoder.end()
      if (dropping) save('[긴 출력 줄 생략]')
      else if (pending) save(pending)
    },
  }
}

if (isMainModule(import.meta.url)) {
  const [root, ...args] = process.argv.slice(2)
  if (!root) throw new Error('본체 경로가 필요하다')
  const file = outputFile(root)
  const run = `${process.pid}:${args.includes('--watch') ? 'watch' : args[0]}`
  const stdout = outputSink(file, 'stdout', run)
  const stderr = outputSink(file, 'stderr', run)
  outputSink(file, 'start', run).write(Buffer.from(`${JSON.stringify(args)}\n`))
  const child = spawn(process.execPath, [join(root, 'scripts/pr-auto.mjs'), ...args], {
    cwd: root, env: { ...process.env, ATHENA_PR_AUTO_CAPTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', stdout.write)
  child.stderr.on('data', stderr.write)
  child.on('error', (error) => stderr.write(Buffer.from(error.message)))
  // stdout/stderr 를 모두 읽은 뒤 종료 코드까지 남긴다.
  child.on('close', (code, signal) => {
    stdout.end()
    stderr.end()
    outputSink(file, 'exit', run).write(Buffer.from(`code=${code} signal=${signal}\n`))
    process.exitCode = code ?? 1
  })
}
