// @ts-check
// Claude Code 프로젝트 · auto memory 폴더 계산 — 현황판이 읽기만 한다.
// 근거: 공식 문서 code.claude.com/docs/en/memory "Storage location" · managed-settings, Claude Code 2.1.316 번들,
// 2026-11-01 실측(공백 · 한글 · 밑줄 · 200자 넘는 경로에서 진짜 claude 가 만든 폴더 이름과 같음)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

const NAME_LIMIT = 200

// 200자가 넘으면 Claude Code 는 앞 200자 뒤에 원래 경로의 해시를 붙인다
const pathHash = (/** @type {string} */ text) => {
  let hash = 0
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  return Math.abs(hash).toString(36)
}

/** 경로 → ~/.claude/projects 아래 폴더 이름(영문 · 숫자 밖은 '-') */
export const projectFolderName = (/** @type {string} */ path) => {
  const text = path.normalize('NFC')
  const name = text.replace(/[^a-zA-Z0-9]/g, '-')
  return name.length <= NAME_LIMIT ? name : `${name.slice(0, NAME_LIMIT)}-${pathHash(text)}`
}

/** 대화 기록 폴더 — 메모리와 달리 세션을 켠 폴더(cwd) 기준이다 */
export const projectDirOf = (/** @type {string} */ cwd, /** @type {string} */ home) => join(home, '.claude/projects', projectFolderName(cwd))

/**
 * 메모리 폴더 이름의 기준 경로 — 워크트리는 원본 레포 · 그 밖의 git 폴더는 레포 뿌리 · git 이 아니면 그 폴더.
 * 서브모듈은 --git-common-dir 이 슈퍼 레포 .git/modules 안이지만 Claude Code 는 서브모듈 자신을 기준으로 삼는다 — 워크트리일 때만 원본으로 간다
 */
export const memoryBaseOf = (/** @type {string} */ root) => {
  let lines
  try {
    lines = execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')
  } catch {
    return root
  }
  const [topLevel, gitDir, commonDir] = lines
  if (!topLevel || !gitDir || !commonDir) return root
  if (gitDir === commonDir) return topLevel
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir // 맨 레포(bare)의 워크트리는 그 레포 폴더
}

const readSetting = (/** @type {string} */ file) => {
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))?.autoMemoryDirectory
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

// 문서가 정한 값만 받는다 — 절대 경로이거나 ~/ 로 시작. 그 밖은 Claude Code 처럼 무시하고 기본 자리로 간다
const settingDir = (/** @type {string} */ value, /** @type {string} */ home) => {
  let path = value
  if (value.startsWith('~/')) {
    const rest = normalize(value.slice(2) || '.')
    if (rest === '.' || rest === '..' || rest.startsWith('../')) return undefined
    path = join(home, rest)
  }
  const clean = normalize(path).replace(/\/+$/, '')
  if (!isAbsolute(clean) || clean.length < 3 || clean.includes('\0')) return undefined
  return clean.normalize('NFC')
}

/**
 * auto memory 폴더 — settings 의 autoMemoryDirectory 가 먼저(관리 정책 → 로컬 → 프로젝트 → 사용자 순으로 처음 있는 값),
 * 없으면 ~/.claude/projects/<원본 레포>/memory.
 * 현황판이 볼 수 없는 값은 빠진다: --settings · MDM · 서버 관리 정책 · managed-settings.d · 폴더 신뢰 여부
 * @param {string} root 본체 폴더
 * @param {string} home 홈 폴더
 * @param {string} [managedFile] 관리 정책 파일(시험용)
 */
export const memoryDirOf = (root, home, managedFile = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json') => {
  const sources = [managedFile, join(root, '.claude/settings.local.json'), join(root, '.claude/settings.json'), join(home, '.claude/settings.json')]
  for (const file of sources) {
    const value = readSetting(file)
    if (value === undefined) continue
    const dir = settingDir(value, home)
    if (dir) return dir
    break
  }
  return join(projectDirOf(memoryBaseOf(root), home), 'memory')
}
