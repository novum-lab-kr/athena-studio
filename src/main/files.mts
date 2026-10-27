// ── 오른쪽 Explorer · 파일 뷰어 — 공용 도우미 ───────────────────────
// main.js 에서 옮겼다(PR3b) — 화면 문구(say)는 createFiles 인자로 받는다
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import * as core from '../lib/core.mts'
import * as explorer from '../lib/explorer.mts'
import * as viewer from '../lib/viewer.mts'
import * as packModel from '../lib/pack.mts'
import type { Say } from '../lib/pack.mts'
import type { ViewerRow, ColoredRow } from '../lib/viewer.mts'

type Highlighter = Awaited<ReturnType<typeof import('shiki').createHighlighter>>
export type Colored = { rows: ColoredRow[]; lang: string; fg?: string; bg?: string }

// 읽어도 되는 곳 — 작업 공간 폴더 + 여러 팩 본체면 지금 팩 데이터(.pack-data 가 가리키는 곳).
// plans · issues · archive · repos 는 .pack-data 를 거친 링크라, 데이터 쪽을 빼면 Explorer 에 아예 안 보인다
export async function explorerRoots(root: string): Promise<string[]> {
  const data = await fs.promises.realpath(path.join(root, '.pack-data')).catch(() => null)
  return data ? [root, data] : [root]
}

export function createFiles({ say }: { say: Say }) {
  // 상대 경로를 풀어(심볼릭 링크 포함) 읽어도 되는 곳 안인지 본다
  async function resolveInside(root: string, relative: unknown): Promise<{ real: string; clean: string }> {
    const clean = explorer.cleanRelative(relative)
    if (clean === null) throw new Error(say('error.pathUnreadable'))
    const real = await fs.promises.realpath(path.join(root, clean))
    if (!explorer.isInsideAny(await explorerRoots(root), real)) throw new Error(say('error.outsideWorkspace'))
    return { real, clean }
  }

  return { resolveInside }
}

// 팩 안 이미지 파일 — 링크가 아니고 풀어도 팩 폴더 안의 일반 파일일 때만 { path(실제 경로), updatedAt }, 아니면 null
export async function packIconFile(packDir: string, relative: string): Promise<{ path: string; updatedAt: string } | null> {
  try {
    const file = path.join(packDir, relative)
    if ((await fs.promises.lstat(file)).isSymbolicLink()) return null
    const [real, realPack] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(packDir)])
    if (!real.startsWith(realPack + path.sep)) return null
    const stat = await fs.promises.stat(real)
    return stat.isFile() ? { path: real, updatedAt: stat.mtime.toISOString() } : null
  } catch {
    return null
  }
}

// 이미지 파일 → data URL(png · jpeg · webp · 1MB 이하만 — CSP img-src 'self' data: 와 맞는다). 아니면 { dataUrl: null }
export async function iconDataUrl(iconPath: string | null | undefined): Promise<{ dataUrl: string | null }> {
  if (!iconPath) return { dataUrl: null }
  try {
    const stat = await fs.promises.stat(iconPath)
    if (!stat.isFile() || stat.size > packModel.ICON_MAX_BYTES) return { dataUrl: null }
    const bytes = await fs.promises.readFile(iconPath)
    const mime = packModel.iconMime(bytes.subarray(0, 12))
    return { dataUrl: mime ? `data:${mime};base64,${bytes.toString('base64')}` : null }
  } catch {
    return { dataUrl: null }
  }
}

export function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: core.childEnv(process.env, { GIT_OPTIONAL_LOCKS: '0' }) }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

// VSCode 처럼 확장자에 맞는 색(Shiki · Dark+ 테마)과 줄 번호.
// Shiki 는 ESM 이라 처음 열 때 한 번 불러오고, 언어는 그 언어 파일을 처음 열 때만 불러온다
const VIEWER_THEME = 'dark-plus'
let highlighterLoading: Promise<{ highlighter: Highlighter; known: Set<string> }> | null = null

function loadHighlighter(): Promise<{ highlighter: Highlighter; known: Set<string> }> {
  if (!highlighterLoading) {
    highlighterLoading = import('shiki').then(async (shiki) => ({
      highlighter: await shiki.createHighlighter({ themes: [VIEWER_THEME], langs: [] }),
      known: new Set(Object.keys(shiki.bundledLanguages)),
    }))
    highlighterLoading.catch(() => (highlighterLoading = null)) // 실패하면 다음에 다시
  }
  return highlighterLoading
}

// 줄에 색 조각을 싣는다. 너무 크거나 실패하면 색 없이(글자는 그대로)
export async function colorRows(rows: ViewerRow[], name: string): Promise<Colored> {
  const code = viewer.codeOf(rows)
  try {
    const { highlighter, known } = await loadHighlighter()
    const lang = viewer.languageFor(name, known)
    if (lang === 'text' || code.length > viewer.HIGHLIGHT_LIMIT) return { rows, lang }
    await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
    const { tokens, fg, bg } = highlighter.codeToTokens(code, { lang: lang as Parameters<Highlighter['codeToTokens']>[1]['lang'], theme: VIEWER_THEME })
    return { rows: viewer.attachTokens(rows, tokens), lang, fg, bg }
  } catch {
    return { rows, lang: 'text' }
  }
}

// IPC 결과 — 실패는 {error}
export async function guarded<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (error) {
    return { error: (error as Error).message }
  }
}
