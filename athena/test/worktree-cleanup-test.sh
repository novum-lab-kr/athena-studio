#!/usr/bin/env bash
# 끝난 작업 워크트리 정리 판정 시험 — scripts/board/worktree-cleanup.mjs(현황판 자동 완료 · 자동 보관 · 이슈 [아카이브] 가 쓴다).
# 2026-11-02 — 팩 워크트리가 ~170개 쌓였다(대화 · /call 로 시작한 계획서는 자동 완료돼도 남았다). 조건마다 지움 · 남김을 진짜 git 으로 본다.
# 임시 폴더(원격 bare · 메인 체크아웃 · 워크트리) · 네트워크 · gh · 화면을 부르지 않는다 · 몇 초
#
# 사용: test/worktree-cleanup-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/athena-worktree-cleanup-test.XXXXXX")" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t GIT_CONFIG_NOSYSTEM=1 HOME="$TMP/home"
mkdir -p "$HOME" "$TMP/worktrees"
g() { git -C "$@" >/dev/null 2>&1; }

# 원격(bare) · 메인 체크아웃(main)
git init -q --bare -b main "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/main" 2>/dev/null
printf 'a\n' > "$TMP/main/a.txt"; printf 'b\n' > "$TMP/main/b.txt"
g "$TMP/main" add . && g "$TMP/main" commit -qm init && g "$TMP/main" push -q origin main

# 워크트리 하나 — origin/main 에서 브랜치를 따 파일 하나를 바꿔 커밋
wt() { # wt <이름> <파일> <내용>
  g "$TMP/main" worktree add -q -b "feat/$1" "$TMP/worktrees/$1" origin/main
  printf '%s\n' "$3" > "$TMP/worktrees/$1/$2"
  g "$TMP/worktrees/$1" add . && g "$TMP/worktrees/$1" commit -qm "$1"
}
# main 에 squash 로 합쳐 push(PR 끔 바로 머지 — 작업 브랜치는 push 하지 않는다 · pr-auto.mjs directMerge 와 같은 모양)
squash() { # squash <이름>
  g "$TMP/main" fetch -q origin && g "$TMP/main" checkout -q main && g "$TMP/main" merge -q --ff-only origin/main
  g "$TMP/main" merge -q --squash "feat/$1" && g "$TMP/main" commit -qm "squash $1" && g "$TMP/main" push -q origin main
}

# ① 바로 머지됨(squash) · 작업 브랜치는 원격에 없음 → 지움
wt squashed a.txt a2; squash squashed
# ② 브랜치를 push 하고 그대로 main 에 머지(fast-forward) → 지움 · .omc/ 도구 폴더만 추적 안 됨 → 지움
wt ffmerged b.txt b2; g "$TMP/worktrees/ffmerged" push -q origin feat/ffmerged; g "$TMP/main" merge -q --ff-only feat/ffmerged; g "$TMP/main" push -q origin main
mkdir -p "$TMP/worktrees/ffmerged/.omc/state"; printf '{}' > "$TMP/worktrees/ffmerged/.omc/state/x.json"
# ③ 반영 안 됨(push 만 함) → 남김
wt notmerged c.txt c1; g "$TMP/worktrees/notmerged" push -q origin feat/notmerged
# ④ 머지됐지만 미커밋 변경 → 남김 · ⑤ 추적 안 된 파일 → 남김
wt dirty d.txt d1; squash dirty; printf 'x\n' >> "$TMP/worktrees/dirty/d.txt"
wt untracked e.txt e1; squash untracked; printf 'x\n' > "$TMP/worktrees/untracked/new.txt"
# ⑥ 머지 뒤 안 올린 커밋을 더 함 → 남김
wt extra f.txt f1; squash extra; printf 'more\n' > "$TMP/worktrees/extra/f.txt"; g "$TMP/worktrees/extra" commit -qam more
# ⑦ GitHub PR 로 머지(원격 main 은 아직 옛 것 · 브랜치는 push) — 머지된 PR head 가 지금 HEAD → 지움
wt prmerged h.txt h1; g "$TMP/worktrees/prmerged" push -q origin feat/prmerged
# ⑧ 머지됐는데 pane 이 그 폴더(아래)를 씀 → 남김
wt busy i.txt i1; squash busy; mkdir -p "$TMP/worktrees/busy/sub"
# ⑨ 머지됐는데 direct 레포 → 남김
wt direct j.txt j1; squash direct
# ⑩ 워크트리 자리 밖 → 남김
g "$TMP/main" worktree add -q -b feat/outside "$TMP/outside" origin/main
# ⑪ 이슈 워크트리 판정(옛 그대로 — 반영 · pane 을 보지 않음): 깨끗 + push 됨 → 지움 · 안 올린 커밋 → 남김(push 이유)
wt issueok k.txt k1; g "$TMP/worktrees/issueok" push -q origin feat/issueok
wt issuelocal l.txt l1

node --input-type=module - "$SRC/scripts/board/worktree-cleanup.mjs" "$TMP" <<'EOF'
const [modPath, tmp] = process.argv.slice(2)
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const { cleanupWorktree, withCleanupLine, worktreePathsOf } = await import(modPath)
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const W = (name) => `${tmp}/worktrees/${name}`
const mainDir = realpathSync(`${tmp}/main`)
const repoOf = (direct = false) => (dir) => (dir === mainDir ? { prBase: 'main', direct } : null)
const panes = [{ id: 'p1', cwd: tmp, foreground_cwd: `${tmp}/main` }, { id: 'p9', cwd: tmp, foreground_cwd: `${W('busy')}/sub` }]
const plan = (name, extra = {}) => cleanupWorktree({ path: W(name), roots: [`${tmp}/worktrees`], repoOf: repoOf(), requireMerged: true, mergedHeads: [], panes, checkPanes: true, ...extra })
const head = (name) => execFileSync('git', ['-C', W(name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const branchLeft = (name) => execFileSync('git', ['-C', `${tmp}/main`, 'branch', '--list', `feat/${name}`], { encoding: 'utf8' }).trim() !== ''
const listed = () => execFileSync('git', ['-C', `${tmp}/main`, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
const show = (result) => JSON.stringify(result)

let result = await plan('squashed')
check('바로 머지(squash) · 작업 브랜치 원격에 없음 → 지움 · 폴더 없음 · 브랜치는 남김', result.state === 'removed' && !existsSync(W('squashed')) && branchLeft('squashed') && !listed().includes(W('squashed')), show(result))
result = await plan('ffmerged')
check('push 한 브랜치가 그대로 main 에 머지 · .omc/ 만 추적 안 됨 → 지움', result.state === 'removed' && !existsSync(W('ffmerged')), show(result))
result = await plan('notmerged')
check('prBase 에 반영 안 됨 → 남김(반영 이유)', result.state === 'kept' && result.reason.includes('반영되지 않아') && existsSync(W('notmerged')), show(result))
result = await plan('dirty')
check('머지됐어도 미커밋 변경 → 남김', result.state === 'kept' && result.reason.includes('커밋하지 않은 변경') && existsSync(W('dirty')), show(result))
result = await plan('untracked')
check('머지됐어도 추적 안 된 파일 → 남김', result.state === 'kept' && result.reason.includes('커밋하지 않은 변경'), show(result))
result = await plan('extra')
check('머지 뒤 안 올린 커밋 → 남김', result.state === 'kept' && existsSync(W('extra')), show(result))
result = await plan('prmerged')
check('원격 main 에 아직 없음 · 머지된 PR head 가 아님 → 남김', result.state === 'kept' && result.reason.includes('반영되지 않아'), show(result))
result = await plan('prmerged', { mergedHeads: [head('prmerged')] })
check('머지된 PR head 가 지금 HEAD → 지움', result.state === 'removed' && !existsSync(W('prmerged')), show(result))
result = await plan('busy')
check('pane 이 그 폴더(아래)를 foreground_cwd 로 씀 → 남김(pane id)', result.state === 'kept' && result.reason.includes('pane p9') && existsSync(W('busy')), show(result))
result = await plan('busy', { panes: null })
check('화면(pane 목록)을 못 읽음 → 남김', result.state === 'kept' && result.reason.includes('pane 목록'), show(result))
result = await plan('busy', { panes: [{ id: 'p2', cwd: W('busy') }] })
check('pane cwd 가 그 폴더 → 남김', result.state === 'kept' && result.reason.includes('pane p2'), show(result))
result = await plan('direct', { repoOf: repoOf(true) })
check('main 직접 레포 → 남김', result.state === 'kept' && result.reason.includes('main 직접') && existsSync(W('direct')), show(result))
result = await plan('direct', { repoOf: () => null })
check('팩 레포가 아님 → 남김', result.state === 'kept' && result.reason.includes('팩 레포'), show(result))
result = await cleanupWorktree({ path: `${tmp}/main`, roots: [tmp], repoOf: repoOf(), requireMerged: true, panes: [], checkPanes: true })
check('메인 체크아웃 → 남김', result.state === 'kept' && result.reason.includes('메인 체크아웃') && existsSync(`${tmp}/main/a.txt`), show(result))
result = await cleanupWorktree({ path: `${tmp}/outside`, roots: [`${tmp}/worktrees`], repoOf: repoOf(), requireMerged: true, panes: [], checkPanes: true })
check('워크트리 자리 밖 → 남김', result.state === 'kept' && result.reason.includes('자리 밖') && existsSync(`${tmp}/outside`), show(result))
result = await plan('없음')
check('이미 없는 폴더 → missing(줄을 쓰지 않음)', result.state === 'missing', show(result))
result = await cleanupWorktree({ path: W('issueok') })
check('이슈 워크트리 — 깨끗 · push 됨 → 지움(반영 · pane 은 보지 않음 · 옛 판정)', result.state === 'removed' && !existsSync(W('issueok')), show(result))
result = await cleanupWorktree({ path: W('issuelocal') })
check('이슈 워크트리 — 안 올린 커밋 → 남김(push 이유)', result.state === 'kept' && result.reason.startsWith('push 하지 않은 커밋이 1개'), show(result))
check('지운 뒤 worktree prune — 목록에 지운 폴더가 없음', !listed().includes(W('ffmerged')) && !listed().includes(W('issueok')))
check('워크트리 자리에 지운 것만 빠짐', JSON.stringify(readdirSync(`${tmp}/worktrees`).sort()) === JSON.stringify(['busy', 'direct', 'dirty', 'extra', 'issuelocal', 'notmerged', 'untracked']), readdirSync(`${tmp}/worktrees`).join(','))

// ── Work ref 줄 → 워크트리 경로 · 계획서 한 줄 ──
const refs = '/x/wt/a · 🌿 feat/a · pane p1 (fe)\nathena-studio 메인 체크아웃 · main\n/x/wt/b · 🌿 feat/b\n/x/wt/a · 🌿 feat/a · pane p2 (fe)'
check('worktreePathsOf — 맨 앞이 절대 경로인 줄만 · 겹치면 하나', JSON.stringify(worktreePathsOf(refs)) === JSON.stringify(['/x/wt/a', '/x/wt/b']), JSON.stringify(worktreePathsOf(refs)))
check('worktreePathsOf — 빈 글 → 없음', worktreePathsOf('').length === 0)
const planText = '## Checkpoint\n- Status: done — 자동\n- Work ref: /x/wt/a · 🌿 feat/a\n- Auto done: merged-1\n\n### Progress\n'
const kept = withCleanupLine(planText, '/x/wt/a', '남김 — pane p1 이 이 폴더에서 쓰는 중이라 지우지 않았어요', '2026-11-02 10:00')
check('withCleanupLine — 마지막 Work ref 줄 아래에 한 줄', kept.includes('- Work ref: /x/wt/a · 🌿 feat/a\n- Worktree cleanup: /x/wt/a 남김 — pane p1'), kept)
const removed = withCleanupLine(kept, '/x/wt/a', '지움', '2026-11-02 11:00')
check('withCleanupLine — 같은 폴더 줄은 바꿈(줄이 늘지 않음)', removed.includes('- Worktree cleanup: /x/wt/a 지움 (2026-11-02 11:00)') && removed.split('Worktree cleanup:').length === 2, removed)
check('withCleanupLine — Work ref 가 없으면 Status 줄 아래 · 둘 다 없으면 그대로', withCleanupLine('- Status: done\n', '/p', '지움', 't') === '- Status: done\n- Worktree cleanup: /p 지움 (t)\n' && withCleanupLine('본문\n', '/p', '지움', 't') === '본문\n')
process.exit(fail)
EOF
