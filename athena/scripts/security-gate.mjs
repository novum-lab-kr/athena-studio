#!/usr/bin/env node
// @ts-check
// 보안 검토 문 — ship.sh · delegate.sh 가 부른다(판정은 scripts/lib/pr-auto.mjs securityGate · securityRiskVerdict 하나)
//
// 사용: node scripts/security-gate.mjs check --plan <계획서 절대 경로> --repo <레포> --branch <브랜치>
//         계획서의 이 레포 · 브랜치 마지막 "- Security result:" 줄에 높음이 남았으면 이유를 찍고 3 으로 끝난다(아니면 0 · 기록이 없어도 0)
//       node scripts/security-gate.mjs risk --dir <워크트리> --base <기준 ref>
//         <기준 ref>...HEAD 와 커밋 전 변경을 보고 위험한 수정(명령 실행 · 파일 쓰기 · 로그인/권한 · 비밀값 · 외부 입력 · 서버 접속)이면 이유를 찍고 0, 아니면 1
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { securityDiffParts, securityGate, securityRiskVerdict } from './lib/pr-auto.mjs'

/** @param {string[]} argv */
const options = (argv) => {
  /** @type {Record<string, string>} */
  const found = {}
  for (let index = 0; index < argv.length; index += 2) found[String(argv[index]).replace(/^--/, '')] = argv[index + 1] ?? ''
  return found
}
/** @param {string} dir @param {string[]} args */
const git = (dir, args) => {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return run.status === 0 ? run.stdout : ''
}
const [command, ...rest] = process.argv.slice(2)
const args = options(rest)
if (command === 'check') {
  if (!args.plan || !args.repo || !args.branch) { console.error('사용: security-gate.mjs check --plan <계획서> --repo <레포> --branch <브랜치>'); process.exit(2) }
  const gate = securityGate(readFileSync(args.plan, 'utf8'), { repo: args.repo, branch: args.branch })
  console.log(gate.why)
  process.exit(gate.block ? 3 : 0)
} else if (command === 'risk') {
  if (!args.dir || !args.base) { console.error('사용: security-gate.mjs risk --dir <워크트리> --base <기준 ref>'); process.exit(2) }
  const committed = securityDiffParts(git(args.dir, ['diff', '--unified=0', `${args.base}...HEAD`]))
  const working = securityDiffParts(git(args.dir, ['diff', '--unified=0', 'HEAD']))
  // 아직 git 에 안 올린 새 파일은 경로만(내용은 읽지 않는다)
  const untracked = git(args.dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).map((path) => ({ path }))
  const verdict = securityRiskVerdict({ files: [...committed.files, ...working.files, ...untracked], added: [...committed.added, ...working.added] })
  console.log(verdict.why)
  process.exit(verdict.risky ? 0 : 1)
} else {
  console.error('사용: security-gate.mjs check|risk …'); process.exit(2)
}
