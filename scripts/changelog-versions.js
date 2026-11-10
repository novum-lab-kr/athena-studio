// @ts-check
// CHANGELOG.md 줄마다 판 번호 — 그 줄을 처음 넣은 main 커밋(first-parent)의 태그(2026-11-10 · 끝자리 업데이트마다 같은 내역이 뜨던 것).
// PR 은 머지 때 정해질 번호를 모르고(scripts/release-version.js) main 에 파일 커밋도 만들지 않으니, 번호는 git 기록에서 정한다.
// 결과 { "<줄 영어 원문>": "X.Y.Z" } 를 changelog-versions.json 으로 —
//   배포판: scripts/package-mac.js 가 Resources 에 싣는다 · 개발 앱: scripts/dev-app.js start 가 dist/ 에 쓴다(코어 업데이트 팝업 src/main/core-runner.mts)
//   Release 본문: scripts/release-files.js notes 가 공개판 뒤 판의 줄만 고를 때
// 태그 없는 커밋의 줄은 다음 태그 커밋(CHANGELOG 를 안 바꾼 커밋도)의 번호 · 그 뒤 태그가 없으면(개발 HEAD) 번호 없음. 같은 글이 다시 들어와도 처음 번호를 쓴다(이미 쓴 줄은 고치지 않는다)
// 순수 부분(versionsFromLog)은 test/changelog-versions.test.js
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const version = require('../src/lib/version')

const FILE_NAME = 'changelog-versions.json'
const COMMIT_MARK = '\u0001'

/**
 * git log 출력(커밋마다 COMMIT_MARK + sha 줄 · 그 아래 -U0 diff · 오래된 순) → 줄 → 판 번호
 * @param {string} log
 * @param {(sha: string) => string | null} tagOf 그 커밋의 판 번호(v 없이) · 태그가 없으면 null
 * @returns {Record<string, string>}
 */
function versionsFromLog(log, tagOf) {
  /** @type {Record<string, string>} */
  const versions = {}
  /** @type {string[]} */
  let pending = []
  for (const block of log.split(COMMIT_MARK).slice(1)) {
    const [sha = '', ...rest] = block.split('\n')
    for (const line of rest) {
      const added = /^\+- (.+)$/.exec(line)
      const text = added && (added[1] || '').trim()
      if (text && !(text in versions) && !pending.includes(text)) pending.push(text)
    }
    const tag = tagOf(sha.trim())
    if (!tag) continue
    for (const text of pending) versions[text] = tag
    pending = []
  }
  return versions
}

/**
 * 커밋 sha → 가장 낮은 v* 판 번호(가벼운 태그 · 주석 태그 모두)
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv }} options
 * @returns {(sha: string) => string | null}
 */
function tagTable({ repoRoot, env = process.env }) {
  const out = execFileSync('git', ['for-each-ref', `refs/tags/${version.TAG_PATTERN}`, '--format=%(objectname) %(*objectname) %(refname:strip=2)'], { cwd: repoRoot, env, encoding: 'utf8' })
  /** @type {Map<string, string>} */
  const table = new Map()
  for (const line of String(out).split('\n')) {
    const [object = '', peeled = '', name = ''] = line.split(' ')
    if (!version.parseVersion(name)) continue
    const tag = name.replace(/^v/, '')
    const sha = peeled || object
    const known = table.get(sha)
    if (!known || version.compareVersions(tag, known) < 0) table.set(sha, tag)
  }
  return (sha) => table.get(sha) || null
}

/**
 * 그 ref 까지의 CHANGELOG.md 줄 → 판 번호
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv, ref?: string }} options
 */
function changelogVersions({ repoRoot, env = process.env, ref = 'HEAD' }) {
  const options = { cwd: repoRoot, env, encoding: /** @type {const} */ ('utf8'), maxBuffer: 64 * 1024 * 1024 }
  // 태그는 CHANGELOG 를 안 바꾼 커밋에도 붙는다 — 경로로 거른 log 만 돌면 그 태그를 건너뛰어 앞 줄이 늦은 번호를 받는다(리뷰 #283).
  // 그래서 커밋 차례는 모든 first-parent 커밋으로 · 추가된 줄은 CHANGELOG.md diff 에서만
  const shas = String(execFileSync('git', ['rev-list', '--first-parent', '--reverse', ref], options)).split('\n').filter(Boolean)
  const patchLog = String(execFileSync('git', ['log', '--first-parent', '--diff-merges=first-parent', '--reverse', `--format=${COMMIT_MARK}%H`, '-p', '-U0', '--no-color', '--no-ext-diff', ref, '--', 'CHANGELOG.md'], options))
  /** @type {Map<string, string>} */
  const patches = new Map()
  for (const block of patchLog.split(COMMIT_MARK).slice(1)) {
    const newline = block.indexOf('\n')
    const sha = (newline < 0 ? block : block.slice(0, newline)).trim()
    patches.set(sha, newline < 0 ? '' : block.slice(newline + 1))
  }
  const log = shas.map((sha) => `${COMMIT_MARK}${sha}\n${patches.get(sha) || ''}`).join('')
  return versionsFromLog(log, tagTable({ repoRoot, env }))
}

/**
 * changelog-versions.json 쓰기 → 줄 수
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv, out: string }} options
 */
function writeChangelogVersions({ repoRoot, env = process.env, out }) {
  const versions = changelogVersions({ repoRoot, env })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(versions, null, 2)}\n`)
  return Object.keys(versions).length
}

module.exports = { FILE_NAME, COMMIT_MARK, versionsFromLog, tagTable, changelogVersions, writeChangelogVersions }
