#!/usr/bin/env node
/**
 * 첫 실행 2단계 — 찾은 레포를 **전부** 체크박스로 보여 주는 고르기 콘솔을 만든다(docs/setup.md 2단계).
 * 아테나가 미리 빼거나 추천하지 않는다 — 맨 위 "전체" 와 찾은 순서 그대로의 레포 목록. 사용자가 고르고 [이대로 진행] 을 누르면
 * 결정 콘솔과 같은 길로 이 pane 에 "1. 넣을 레포: a, b, …" 가 입력된다(현황판이 꺼져 있으면 [프롬프트로 복사]).
 *
 *   node scripts/setup-pick.mjs [--root <폴더>] [--depth <n>] [--pane <id>]
 *   → plans/setup/<날짜>-첫-실행-레포-고르기.md(+ .html) 를 만들고 경로를 출력한다. 연다: scripts/board.sh open <md>
 *
 * 레포를 고르는 일만 한다 — 회사 이름·추정 수정·에이전트 이름은 setup.md 2단계의 다른 질문으로 묻는다.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const scanArgs = ['init', '--scan', '--json']
for (const name of ['root', 'depth']) if (option(name)) scanArgs.push(`--${name}`, option(name))
const repos = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'scripts/athena.mjs'), ...scanArgs], { cwd: ROOT, encoding: 'utf8' }))
if (!repos.length) {
  console.error('레포를 찾지 못했다 — --root 로 레포 폴더를 주거나 --depth 를 늘린다')
  process.exit(1)
}

const ALL = `전체 (${repos.length}개)`
const describe = (repo) =>
  [
    repo.path,
    repo.kind,
    repo.layer,
    repo.lang,
    `기준 ${repo.branch || '?'}`,
    `base ${repo.prBase || '?'}`,
    repo.apps?.length ? `앱 ${repo.apps.map((app) => app.name ?? app).join(' ')}` : '',
    repo.org,
  ]
    .filter(Boolean)
    .join(' · ')

const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const mdFile = `plans/setup/${day}-첫-실행-레포-고르기.md`
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|')
const md = [
  '# 첫 실행 — 넣을 레포 고르기',
  '',
  `> 첫 실행 2단계(docs/setup.md). 찾은 레포 ${repos.length}개를 **찾은 순서 그대로 전부** 보여 준다 — 아테나가 미리 빼거나 추천하지 않는다.`,
  '> 아래 콘솔에서 고르고(맨 위 "전체" 는 모두) [이대로 진행] 을 누르면 아테나가 고른 레포로 팩을 만든다. 추정(종류·층·브랜치)이 틀린 건 다음 질문에서 고친다.',
  '',
  '## 찾은 레포',
  '',
  '| 레포 | 위치 | 종류 | 층 | 언어 | 기준 브랜치 | 작업 base | GitHub 조직 |',
  '|---|---|---|---|---|---|---|---|',
  ...repos.map((repo) => `| ${cell(repo.name)} | ${cell(repo.path)} | ${repo.kind} | ${repo.layer} | ${repo.lang} | ${repo.branch || '?'} | ${repo.prBase || '?'} | ${cell(repo.org) || '—'} |`),
  '',
].join('\n')

const plan = {
  title: '첫 실행 — 넣을 레포 고르기',
  type: 'feature',
  scope: '팩',
  summary: `찾은 레포 ${repos.length}개 — 넣을 레포를 고른다(전체 가능).`,
  decisions: [
    {
      id: 'repos',
      title: '넣을 레포',
      desc: '여러 개 고를 수 있다. "전체" 를 고르면 찾은 레포를 모두 넣는다.',
      type: 'multi',
      required: true,
      options: [{ label: ALL, desc: '찾은 레포를 모두 넣는다' }, ...repos.map((repo) => ({ label: repo.name, desc: describe(repo) }))],
    },
  ],
}

mkdirSync(join(ROOT, 'plans/setup'), { recursive: true })
writeFileSync(join(ROOT, mdFile), md)
// 콘솔 데이터는 임시 폴더에 — plans/ 에 남기면 git 에 샌다(plans/ 는 md·html 만 무시)
const dataFile = join(mkdtempSync(join(tmpdir(), 'athena-setup-pick-')), 'plan.json')
writeFileSync(dataFile, JSON.stringify(plan, null, 2))
const htmlArgs = [join(ROOT, 'scripts/plan-html.mjs'), mdFile, '--data', dataFile]
if (option('pane')) htmlArgs.push('--pane', option('pane'))
try {
  process.stdout.write(execFileSync(process.execPath, htmlArgs, { cwd: ROOT, encoding: 'utf8' }))
} finally {
  rmSync(dirname(dataFile), { recursive: true, force: true })
}
console.log(`레포 ${repos.length}개 · ${mdFile} — 연다: scripts/board.sh open ${mdFile}`)
