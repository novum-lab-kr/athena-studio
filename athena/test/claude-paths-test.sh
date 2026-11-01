#!/usr/bin/env bash
# 현황판 클로드 학습 폴더 계산 시험 — scripts/board/claude-paths.mjs.
# 2026-11-01 버그: 코어의 워크트리인 본체에서 본체 이름 폴더를 읽어 메모리가 비어 보였다(실제는 원본 레포 이름 폴더). 임시 폴더 · 몇 초
#
# 사용: test/claude-paths-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
MADE="$(mktemp -d "${TMPDIR:-/tmp}/athena-claude-paths-test.XXXXXX")" || exit 1
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$MADE"' EXIT
TMP="$(cd "$MADE" && pwd -P)" || exit 1 # git 이 돌려주는 실제 경로와 비교한다(맥 /var → /private/var)

quiet_git() { git -c user.name=t -c user.email=t@t -c protocol.file.allow=always "$@" >/dev/null 2>&1; }
quiet_git init "$TMP/core"
quiet_git -C "$TMP/core" commit --allow-empty -m first
quiet_git -C "$TMP/core" worktree add "$TMP/body" -b body
mkdir -p "$TMP/core/sub" "$TMP/plain" "$TMP/home/.claude" "$TMP/공백 있는_폴더"
quiet_git init "$TMP/lib"
quiet_git -C "$TMP/lib" commit --allow-empty -m first
quiet_git -C "$TMP/core" -c protocol.file.allow=always submodule add "$TMP/lib" mod
quiet_git clone --bare "$TMP/core" "$TMP/bare.git"
quiet_git -C "$TMP/bare.git" worktree add "$TMP/bare-wt" -b wt

node --input-type=module - "$SRC/scripts/board/claude-paths.mjs" "$TMP" <<'NODE'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
const [modPath, tmp] = process.argv.slice(2)
const { memoryBaseOf, memoryDirOf, projectDirOf, projectFolderName } = await import(modPath)
let fail = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  console.log(`  ${ok ? '✔' : '✖'} ${name}`)
  if (!ok) { fail = 1; console.log(`      기대 ${expected}\n      실제 ${actual}`) }
}
const home = `${tmp}/home`
const noManaged = `${tmp}/없는-정책.json`
const defaultDir = (base) => `${home}/.claude/projects/${projectFolderName(base)}/memory`

// 폴더 이름 — 진짜 claude 2.1.316 실측값(2026-11-01)
check('공백 · 한글 · 밑줄 · 점은 글자마다 -', projectFolderName('/tmp/a b_한글.x'), '-tmp-a-b----x')
const longPath = `/x/${'l'.repeat(120)}/${'m'.repeat(120)}`
const longName = projectFolderName(longPath)
check('200자 넘으면 앞 200자 + 해시', longName.slice(0, 200), longPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200))
check('긴 이름의 해시 모양', /^-[0-9a-z]+$/.test(longName.slice(200)), true)
check('한글 자모 분리(NFD)도 합친 글자로 센다', projectFolderName('/가'.normalize('NFD')), '--')

// 기준 경로
check('메인 체크아웃 → 그 레포', memoryBaseOf(`${tmp}/core`), `${tmp}/core`)
check('워크트리 본체 → 원본 레포', memoryBaseOf(`${tmp}/body`), `${tmp}/core`)
check('레포 안 하위 폴더 → 레포 뿌리', memoryBaseOf(`${tmp}/core/sub`), `${tmp}/core`)
check('서브모듈 → 서브모듈 자신', memoryBaseOf(`${tmp}/core/mod`), `${tmp}/core/mod`)
check('맨 레포의 워크트리 → 맨 레포', memoryBaseOf(`${tmp}/bare-wt`), `${tmp}/bare.git`)
check('git 이 아닌 폴더 → 그 폴더', memoryBaseOf(`${tmp}/plain`), `${tmp}/plain`)
check('공백 · 한글 · 밑줄 든 git 아닌 폴더', memoryBaseOf(`${tmp}/공백 있는_폴더`), `${tmp}/공백 있는_폴더`)
check('없는 폴더 → 그 경로 그대로(던지지 않음)', memoryBaseOf(`${tmp}/없음`), `${tmp}/없음`)

// 대화 기록은 본체 이름 그대로 · 메모리만 원본
check('대화 기록 폴더는 본체 기준', projectDirOf(`${tmp}/body`, home), `${home}/.claude/projects/${projectFolderName(`${tmp}/body`)}`)
check('메모리 폴더는 원본 기준', memoryDirOf(`${tmp}/body`, home, noManaged), defaultDir(`${tmp}/core`))

// autoMemoryDirectory
const body = `${tmp}/body`
const setting = (file, value) => { mkdirSync(file.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(file, JSON.stringify({ autoMemoryDirectory: value })) }
const userFile = `${home}/.claude/settings.json`
const projectFile = `${body}/.claude/settings.json`
const localFile = `${body}/.claude/settings.local.json`
const managed = `${tmp}/managed.json`
setting(userFile, '~/my-mem/')
check('사용자 설정 ~/ 풀기', memoryDirOf(body, home, noManaged), `${home}/my-mem`)
setting(projectFile, '/abs/project')
check('프로젝트가 사용자보다 먼저', memoryDirOf(body, home, noManaged), '/abs/project')
setting(localFile, '/abs/local')
check('로컬이 프로젝트보다 먼저', memoryDirOf(body, home, noManaged), '/abs/local')
setting(managed, '/abs/managed')
check('관리 정책이 맨 먼저', memoryDirOf(body, home, managed), '/abs/managed')
rmSync(localFile); rmSync(projectFile)
for (const bad of ['relative/dir', '~/../etc', '~/', '/']) {
  setting(userFile, bad)
  check(`잘못된 값 ${bad} → 기본 자리`, memoryDirOf(body, home, noManaged), defaultDir(`${tmp}/core`))
}
writeFileSync(userFile, '{ broken')
check('깨진 설정 → 기본 자리', memoryDirOf(body, home, noManaged), defaultDir(`${tmp}/core`))
process.exit(fail)
NODE
exit $?
