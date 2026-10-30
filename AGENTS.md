# athena-studio — 개발 안내 (Claude Code · Codex 공통)

이 레포를 **고치는** 에이전트용 정본. Codex 는 이 파일을, Claude Code 는 `CLAUDE.md`(이 파일을 불러온다)를 읽는다. 앱이 무엇인지는 [`README.md`](README.md)(제품 소개 · [한국어](README.ko.md)), 켜기 · 배포판 · 화면 · 데이터 자리 · 구조는 [`docs/development.md`](docs/development.md).

> **`athena/CLAUDE.md` · `athena/AGENTS.md` · `athena/.claude/rules/` 는 따르지 않는다.** 코어 본체에서 아테나(팀 리드)를 켤 때의 페르소나 규칙이다("직접 코드를 작성하지 않는다" · 계획서 · `commit.sh` 등). 이 레포에서 `athena/` 코드를 고칠 때도 이 문서가 기준이다 — 그 파일들은 고칠 대상일 뿐이다.

## 레포 경계
- `src/` · `scripts/` · `bin/` · `test/` — Electron 앱
- `athena/` — 스튜디오 코어의 **정본**. 코어를 고치면 여기서 고치고 여기 커밋한다. 이 폴더를 본체로 직접 쓰지 않는다
- 사용자의 `~/.athena-studio/core` · `bodies/` 는 설치본이다 — 소스로 고치지 않는다(다음 업데이트에 덮이거나 `core-edits` 백업으로 빠진다)

## 명령
```sh
npm install       # postinstall: spawn-helper 권한 · .dev-app/Athena.app 만들기 (새 워크트리는 코어 new-branch.sh 가 scripts/worktree-setup.sh 로 npm ci · Electron 설치까지 해 준다)
npm start         # 코어 번들 · 화면 빌드(dist/renderer) 만들고 개발 앱 켜기(맥)
npm run build:renderer # 화면만 빌드(vite build — 켤 때 저절로 돈다)
npm run check     # 문법(node --check · .mts 는 scripts/check-ts.js — 목록은 package.json 에 손으로) · 끝에 화면 빌드(renderer .ts 문법)
npm run typecheck # 타입 검사(tsc — tsconfig.json · src/renderer/tsconfig.json · athena/jsconfig.json)
npm test          # test/*.test.js (node:test) — 순수 로직 + 데몬 통합(실제 pty)
```
맥 배포판은 `npm run package:mac`(electron-builder · `scripts/package-mac.js` → `dist/release/` · `docs/development.md` "배포판 (맥)"). 앱 코드 빌드는 화면만 — 아래 "TypeScript". 서버 · CI 에서는 Electron 을 띄우지 않는다 — 화면 확인은 맥에서. Node 22.18 이상(`.mts` 를 타입 지우기로 바로 읽는다 — 아래 "TypeScript").

## TypeScript (섞어 쓰는 중)
- **앱 Node 쪽은 빌드 없음** — Electron 44(Node 24)가 `.mts` 를 타입만 지우고 바로 실행한다. 데몬 띄우기는 JS 때와 같다
- **화면(renderer)은 Vite 빌드** — `src/renderer` 의 `index.html` · `tray.html` 을 `vite.config.mts` 가 `dist/renderer/`(git 무시)로 묶고 main 은 그쪽을 연다. `npm start` · ⚙ 업데이트 뒤 다시 켜기(`scripts/dev-app.js start`)가 켤 때마다 빌드한다 — 실패하면 이전 빌드로 켜고 경고(⚙ 업데이트 뒤면 앱이 알림) · 이전 빌드도 없으면 켜지 않는다. 지켜보며 다시 빌드하지 않는다 — 화면을 고쳤으면 앱을 다시 켠다
- Electron 진입점은 `src/main.mts`(ES 모듈 · `package.json` `main`) — Electron 이 이 파일을 끝까지 읽은 뒤 ready 를 낸다(`app.setName` · `setPath` 는 ready 전). 가져온 모듈은 본문보다 먼저 도니 `src/main/*.mts` 맨 위에서 app 자리를 읽지 않는다
- 앱 Node 쪽(main · daemon · `src/lib`) **새 파일은 `.mts`**(ES 모듈). `.ts` 는 안 된다 — 레포가 CommonJS 라 `import`/`export` 를 쓴 `.ts` 를 tsc 가 막는다
- 가져올 때 확장자까지: `require('./lib/requests.mts')` · `import { x } from './y.mts'`. 타입만이면 `import type`
- **지울 수 있는 문법만** — enum · namespace · 생성자 매개변수 속성 · `import x = require()` 금지(`erasableSyntaxOnly` · `scripts/check-ts.js` 가 막는다)
- JS 파일은 맨 위 `// @ts-check` 를 붙인 것만 검사한다(`checkJs` 를 전역으로 켜면 옛 오류 수천 개). 붙인 파일 · `.mts` 는 오류 0 을 지킨다
- renderer 는 모두 `.ts` · `.tsx`(옛 `renderer.js` 는 R3 에서 기능별 파일로 다 옮겨 지웠다). 진입점 `entry.ts` 가 `ui/index.ts` 다음에 시작 `main.ts` 를 싣는다(main.ts 가 나눈 묶음 — `core.ts` · `terminal.ts` · `screen.ts` · `space-actions.ts` · `browser.ts` · `work.ts` · `detail.ts` … — 을 모두 import 하고 맨 끝 `init()` — 다른 묶음을 진입점에서 따로 먼저 싣지 않는다). 묶음끼리는 서로 import 한다(순환 import · 묶음 사이 사용은 함수 안에서만 — 모듈 맨 위에서 다른 묶음 값을 부르지 않는다). 다른 묶음이 바꾸는 변수는 가진 쪽의 `export let` + `setX`. 문법은 `check` 끝 화면 빌드가 본다. 트레이는 `tray.ts`(`tray-entry.ts` 가 싣는다 · `../lib/i18n.mts` 를 직접 import · `trayPanel` 전역 타입은 그 파일 안). renderer 새 파일은 `.ts`(Vite 가 지운다 · 같은 지울 수 있는 문법만) · 타입 검사는 `src/renderer/tsconfig.json`(DOM · strict). 화면이 같이 쓰는 `src/lib` 4개(layout · space-names · pane-keys · i18n)는 `.mts` — main · 데몬 · 화면 모두 import(화면은 이름공간째 옛 이름 `StudioLayout` 등으로)
- 화면 진입점은 **정적 import 만** — main 이 창을 다 읽자마자(`did-finish-load`) 한 번 보내는 것(트레이 `tray:update`)이 있어 동적 `import()` 로 늦게 실으면 놓친다
- **React 화면**(결정 D2 · 첫 화면 ⚙ 설정 PR-R4) — 새 화면 · 크게 고치는 화면부터 `src/renderer/ui/*.tsx`. 바닐라와 섞는 틀은 `ui/bridge.ts` 하나: 바닐라가 가진 몸통 칸에 `mountIsland` 로 띄우고 닫을 때 내린다(껍데기 — 열기 · 닫기 · Esc · 바깥 누르기 · 포커스 돌려주기 — 는 바닐라 그대로) · 문구는 `useSay`(`core.ts` 가 `StudioUi.connect({ say, showToast })` · 언어가 바뀌면 `main.ts` 가 `textsChanged()`) · 바닐라와 같이 보는 값은 `createStore` + `useStore` · preload 는 `studio` 전역 그대로(화면 `.ts` · `.tsx` 가 부르는 것만 `src/renderer/studio-api.d.ts` 에 타입). 바닐라 `.ts` 는 React 화면을 `./ui/index.ts` 의 `StudioUi` 로 import 한다(전역은 없다). 새 `.tsx` 는 `test/i18n-usage.test.js` `SCRIPT_FILES` 에 더한다. Vite 개발 서버(HMR)는 쓰지 않는다 — CSP `script-src 'self'` 가 React 미리 싣기 인라인 스크립트를 막는다
- renderer 가 실행 중에 만드는 경로는 번들러가 못 본다 — 로고(`assets/logo/…`)는 빌드가 폴더째 복사하고, `ICON_ROOT`(`../../node_modules/material-icon-theme/icons`)는 `dist/renderer` 가 레포 뿌리에서 두 칸 아래라 맞는다(outDir 을 옮기지 않는다)
- preload(`preload.js` · `preload-tray.js`)는 JS + `// @ts-check` — `sandbox: true` 라 한 파일 · `require('electron')` 만 된다(`.mts` · 다른 파일 require 안 됨)
- 데몬 CLI `src/daemon/cli.js` 는 JS + `// @ts-check` — `bin/athena-studio-cli` 가 pane 밖에서 PATH 의 node 로 부를 수 있다(그 node 가 타입 지우기를 못 할 수 있다). 그래서 cli.js 가 부르는 `protocol.js` 도 JS
- 코어 `athena/` 는 `.mjs` 그대로 + JSDoc · 고치는 파일부터 `// @ts-check`(설치본은 node 로 바로 실행 — 빌드를 끼우지 않는다)
- `.mts` 를 CommonJS 에서 `require` 하면 고정된 이름공간 객체다 — 테스트에서 모듈 함수를 바꿔 끼울 수 없다(인자로 넘긴다)

## 검사
- 앱을 고쳤으면 `npm run check` · `npm run typecheck` · `npm test`. node-pty 를 못 불러오면 데몬 통합 테스트가 **skip** 된다(`test/daemon.test.js`) — 통과 숫자만 보지 말고 skip 이 없는지 본다
- `npm test` 는 코어를 보지 않는다. `athena/` 를 고쳤으면 고친 곳에 맞는 코어 검사를 따로(`athena/` 에서):
  - `test/packs-test.sh`(본체 하나 · 약 1분) · `test/requests-test.sh`(사람에게 묻는 요청 · 약 30초) · `test/bodies-test.sh`(여러 본체 · update · 약 2분) · `test/bundle-test.sh`(번들 코어 · 약 1분) — 모두 임시 폴더에서 돌고 지운다(`KEEP=1` 이면 남김)
  - PR 자동 리뷰(`scripts/pr-auto.mjs` · `scripts/lib/pr-auto.mjs`)를 고쳤으면 `test/pr-auto-test.sh`(몇 초 · 가짜 리뷰어 · GitHub 를 건드리지 않는다)
  - 현황판 자동 완료 · 자동 보관 판정(`scripts/board/plan-bind.mjs` · `server.mjs` `autoDonePlans` · `autoArchive` · 묶인 pane)을 고쳤으면 `test/board-auto-test.sh`(몇 초 · gh · 화면을 부르지 않는다)
  - GitHub 이슈 감시(`scripts/board/github-issues.mjs` · `server.mjs` `githubIssues` · `/api/github-issues`)를 고쳤으면 `test/github-issues-test.sh`(몇 초 · 가짜 gh · 가짜 화면 CLI 로 진짜 현황판 서버 한 주기)
  - 현황판이 pane 에 지시를 넣는 순서(`scripts/board/pane-delivery.mjs` · `server.mjs` `sendToPane` — 질문 창이 떠 있으면 미뤘다가 닫히면 넣기)를 고쳤으면 `test/pane-delivery-test.sh`(몇 초 · 가짜 화면)
  - 현황판 사용량(`server.mjs` `readUsage` · `readClaudeUsage` — `/api/state` `header.usage`, 메뉴 막대가 읽는다)을 고쳤으면 `test/board-usage-test.sh`(몇 초 · 임시 코어 사본에서 진짜 현황판 서버 · 가짜 claude · gh)
  - 무거운 명령 줄서기(`athena/scripts/heavy.sh` 자리 · 메모리 여유 조건 · `scripts/lib/packs.mjs` · `server.mjs` 의 잠금 읽기)를 고쳤으면 `test/heavy-test.sh`(약 45초 · 임시 잠금 경로 · 가짜 memory_pressure)
  - 역할마다 모델(`scripts/lib/models.mjs` · `athena_config.py` `model_of` · `delegate.sh` `--model` · 팩 `models`)을 고쳤으면 `test/models-test.sh`(몇 초 · 진짜 claude 를 부르지 않는다)
  - red-check(`scripts/red-check.mjs` · `scripts/lib/red-check.mjs` · `scripts/verify/red-check.sh` · `ship.sh` 의 red-check 연결)를 고쳤으면 `test/red-check-test.sh`(몇 초 · 가짜 레포 · 가짜 gh)
  - 시크릿 차단 훅(`athena/scripts/hooks/secret-guard.py`)을 고쳤으면 `test/secret-guard-test.sh`(몇 초 · 훅에 글자만 넣어 막힘 · 통과를 본다)
  - 위임 에이전트 끝 알림 훅(`athena/scripts/hooks/agent-done-notify.py` · `delegate.sh` · `agent-context.py` 의 훅 설정)을 고쳤으면 `test/agent-done-notify-test.sh`(몇 초 · 가짜 화면 CLI · 임시 본체 사본)
  - 다이어그램 테마(`scripts/diagram-theme.mjs` · `.css`)를 고쳤으면 `test/diagram-theme-test.sh`(몇 초) — 그리고 `docs/diagrams/*.html` 에 다시 입힌다
  - 화면 계층(`scripts/lib/screen.py` · `screen.mjs`)을 고쳤으면 `scripts/screen-lint.sh` · `scripts/screen-check/check.sh`(golden 비교) · 경로를 바꿨으면 `scripts/path-lint.sh`
  - 위임 에이전트 훅 설정(`athena/scripts/lib/agent_hooks.py` — `agent-context.py` · `delegate.sh` 가 같이 쓴다)을 고쳤으면 `test/agent-hooks-test.sh`(몇 초)
  - `commit.sh` 의 미리 올린 변경 판정(이름 바꾸기 포함)을 고쳤으면 `test/commit-staged-test.sh`(몇 초 · 임시 레포)
  - `pr-auto.mjs` · `learn-review.mjs` 의 직접 실행 판정(`scripts/lib/is-main.mjs`)은 `test/pr-auto-test.sh` 끝의 심볼릭 링크 검사가 본다
  - 자세한 것은 `athena/docs/pack.md` "여러 팩 테스트"

## 고칠 때 같이 바꾸는 곳
| 바꾸는 것 | 같이 |
|---|---|
| 데몬 ↔ 앱 · CLI 통신(요청 · 응답 · 알림 형식, 요청 하나 더하기도) | `src/lib/protocol.js` `PROTOCOL`(지금 5)을 올리고 그 위 주석에 한 줄 · `src/daemon/main.mts` · `src/daemon/cli.js` · `src/daemon-client.mts` · 코어 화면 계층 `athena/scripts/lib/screen.py`(CLI 를 부른다) · `athena/scripts/screen-check/fake-bin/athena-studio-cli` · `test/protocol.test.js` · `test/daemon.test.js`. 번호가 다르면 켤 때 데몬 다시 띄우기를 묻고, 사용자가 고르면 **pane 이 모두 닫힌다**(고르지 않으면 옛 데몬에 붙어 바꾸기 · 새 창이 막힌다) — `open-url` 처럼 올리지 않은 예외는 이유를 주석에 남긴 것만, 일반 규칙으로 넓히지 않는다 |
| 팩 명령 약속(`pack … --json` 출력 · 오류 코드) | 앱 `src/lib/pack.mts` `CONTRACT` 와 코어 `athena/scripts/lib/bodies.mjs` `CONTRACT`(둘 다 3 — 데몬 `PROTOCOL` 과는 별개) · 출력 해석 · `packErrorText` · `scripts/fake-pack.js`(같은 모양으로) · `test/pack.test.js` · 코어 `athena/docs/pack.md` |
| 화면 문구 | `src/i18n/{ko,en,ja,zh}.json` 네 곳에 같은 키 · 같은 `{자리}`(`test/i18n.test.js`). 문구를 부르는 새 화면 파일은 `test/i18n-usage.test.js` `SCRIPT_FILES` · `HTML_FILES` 에 더한다 |
| 새 `.js` 파일 | `package.json` `check` 목록(자동으로 찾지 않는다) — renderer 새 파일(`.ts`)은 진입점에서 import 하면 `check` 끝의 화면 빌드가 본다 |
| 새 `.mts` 파일 · JS → `.mts` 옮기기 | `package.json` `check` 의 `scripts/check-ts.js` 줄 · 부르는 곳의 `require` 경로(확장자까지) · 테스트의 `require` |
| 순수 로직 | `src/lib/` 에 두고 `test/<이름>.test.js` — Electron 없이 돈다 |
| 스튜디오 집 자리 · 번들 · 업데이트 · 초기화 | `src/lib/studio-home.js` 한 곳(`coreBundlePath` · `resetPlan`) · `test/studio-home.test.js` · `docs/development.md` "스튜디오 집과 데이터" |
| 메뉴 · 단축키 · 화면 동작 | `docs/development.md` "화면" · "팩" · "문제가 생기면" |

## 함정
- **화면은 `dist/renderer/` 를 연다** — `npm start` 를 거치지 않고 `electron .` 으로 바로 켜면(화면 확인 스크립트 등) 빌드가 돌지 않는다. 빌드가 없으면 빈 창 · 있으면 옛 화면이다 — 먼저 `npm run build:renderer`
- **번들은 커밋된 `HEAD:athena` 에서 만든다** — `athena/` 의 미커밋 변경은 `npm start` 에 들어가지 않는다. `athena/` 트리가 같으면 다시 만들지 않고, 만들다 실패해도 앱은 이전 번들 · 이미 푼 코어로 켜진다(`[dev-app] 코어 번들을 만들지 못했어요` 경고만). 켜졌다고 최신 코어가 들어간 것이 아니다 — `npm start` 로그를 본다. (커밋이 필요하다는 뜻이지, 사용자에게 묻지 않고 커밋해도 된다는 뜻은 아니다)
- **데몬은 앱보다 오래 산다** — 데몬 코드(`src/daemon/`)를 고치고 앱만 다시 켜면 옛 데몬에 붙는다. [보기 → 작업 창 데몬 다시 띄우기] 가 필요하고 그러면 pane 이 모두 닫힌다 — 사용자가 에이전트를 돌리는 중이면 먼저 묻는다
- **팩 바꾸기는 pane 을 닫지 않는다** — 창이 다른 본체로 다시 붙을 뿐(`src/main/packs.mts` `packOpen` → `athena-dir.mts` `rebindBody`). pane 이 닫히는 것은 사용자가 pane · 탭을 닫을 때 · 옛 터미널 모니터 칸(데몬 dock) 정리 · 데몬 다시 띄우기 · 스튜디오 초기화뿐이다
- **창마다 문맥이 따로** — 본체 · 데몬 연결 · 현황판 · 옆 브라우저 · 모니터 · 팩 상태는 창(`ctx`)마다. 팩 상태를 전역으로 두지 않고, IPC 는 보낸 창의 문맥으로 처리한다. 트레이는 별도 preload(`preload-tray.js`)와 보낸 쪽 검사를 유지한다
- **팩을 바꾸는 명령은 끊지 않는다** — `use` · `new` · `open` · `update` · `import --replace` 는 시간이 넘어도 "오래 걸려요" 만 띄우고 기다린다(`src/main/core-runner.mts` `PACK_TIMEOUTS` 근처). 여기에 일괄 timeout 종료를 넣지 않는다
- **자식 환경은 `core.childEnv` 로** — `ATHENA_STUDIO*` · `CLAUDE_CODE_*` · `CLAUDECODE` · `ATHENA_AGENT` 등을 걷어 낸다(pane 안에서 앱을 켜도 하위 세션으로 오인하지 않게). 그래서 앱을 켤 때 준 `ATHENA_STUDIO_*` 는 팩 명령 · pane 에 넘어가지 않는다
- 개발 앱과 배포판은 앱 데이터만 따로고 스튜디오 집의 코어 · 본체 · 팩 데이터는 같이 쓴다 — 초기화 · 업데이트는 둘 다에 닿는다
- 앱 단축키는 ⌘ 만 — Ctrl 조합은 pane 으로 보낸다

## 격리 실행 (사용자 앱이 켜져 있을 때)
- `ATHENA_STUDIO_HOME=<임시> npm start` — 스튜디오 집(코어 · 본체 · 데이터 · 접속 파일)과 앱 데이터(`<임시>/app/Athena Studio Dev/`)가 모두 그 아래로. 사용자 앱 · `~/.athena-studio` 를 건드리지 않는다. 끝나면 앱과 함께 데몬도 끈다(`<임시>/daemon-dev.json` 의 `pid`)
- **`HOME` 은 바꾸지 않는다** — 앱은 켤 때의 `HOME` 을 데몬 · pane 에 물려줘서, 바꾸면 pane 안 claude 가 로그인 · 맥 키체인을 못 찾는다(재인증 · '키체인을 찾을 수 없음' — 2026-10-19 실측). Electron 도 `HOME` 을 바꿔도 홈 경로를 그대로 쓴다
- 소켓 경로가 길면 임시 폴더 `athena-studio-<uid>-dev/` 로 떨어진다 — 같은 때 도는 다른 격리 실행과 겹친다
- `--user-data-dir=<…>` · `ATHENA_STUDIO_ENDPOINT=<…>` 를 따로 주면 그 자리가 먼저다. 이 둘만으로는 앱 데이터 · 접속 파일만 갈리고 코어 · 데이터는 진짜 `~/.athena-studio` 를 쓴다 — 격리하려면 `ATHENA_STUDIO_HOME`

## 수동 확인 — 팩
**공통** — 켜진 개발 앱을 끈다(같은 앱 데이터 · 접속 파일을 쓴다). 데몬이 protocol 5 보다 옛 것이면 [보기 → 작업 창 데몬 다시 띄우기] 를 한 번(pane 이 닫힌다 — 하던 에이전트 작업을 끝낸 뒤). 옛 데몬이면 바꾸기 · 새 창 · 새 팩이 막힌다.

**A. 가짜 본체로 화면 흐름** — `ATHENA_STUDIO_FAKE_PACK=1 npm start`(격리하려면 `ATHENA_STUDIO_HOME` 도). 스튜디오 코어는 그대로 준비되고 팩 명령만 `scripts/fake-pack.js` 가 같은 `--json` 모양으로 답한다.
- 가짜도 파일을 만든다: 상태 `$TMPDIR/athena-studio-fake-pack.json`, 가짜 본체 `$TMPDIR/athena-studio-fake-bodies/<id>/`(`CLAUDE.md` · 현황판 서버). 처음으로 돌리려면 둘 다 지운다. `ATHENA_STUDIO_HOME` 으로 옮겨지지 않는다(그리고 `ATHENA_STUDIO_FAKE_PACK_STATE` 는 `childEnv` 가 걷어 내 앱을 거쳐서는 안 먹는다)
1. 시작 화면 "내 팩" 에 acme(맨 위 "지금") · globex · broken. acme → 작업 창 · 탭 줄 `▣ acme ▾`(⌘⇧P) → 목록 + 새로 만들기 · 가져오기 · 내보내기
2. globex 누르기 → 처음이면 본체 만들기 진행 → 이 창이 globex 로(현황판 다시 뜸) · "연결하지 못한 레포: globex-api" 알림. acme 에서 띄운 pane 은 닫히지 않는다 — acme 로 돌아오면 보던 자리 그대로
3. 팩 우클릭 [새 창으로 열기] → 새 창 · 이미 다른 창이 보는 팩을 누르면 그 창이 앞으로. 이름 바꾸기 · 이미지 고르기 · 지우기 · 원래 이름으로
4. 가져오기 → 압축 파일 이름에 `bad` → "안전하지 않은 파일…" / `acme-pack…tar.gz` → 같은 이름 비교 → [가져온 것으로 바꾸기] → "기존 팩은 자동 백업했어요" / git 레포 → `https://u:비번@…` · 공백 든 주소는 거절, `git@github.com:x/newco.git` 은 등록 → "지금 이 팩으로 바꿀까요?" / 기존 아테나 → 작업 기록(계획서 · 이슈 · 보관함 · 워크트리 1개 미커밋) · acme 와 같은 이름 비교
5. 내보내기 → 팩 + 내 작업 기록 / 팩만 → 저장 폴더 → "만들었어요 — 파일 N개 · KB" · [Finder 에서 보기](가짜는 내보낸 파일은 만들지 않는다 — 경로만)
6. 팩 작업이 도는 중에 메뉴에서 또 열기 → "팩 작업이 진행 중이에요" 알림만
- broken 의 "바꾸다 실패해서 되돌렸어요" 는 옛 `pack use` 경로 흉내다 — 지금 화면은 `pack open` 을 불러 broken 도 그냥 열린다

**B. 진짜 본체로** — 꼭 `ATHENA_STUDIO_HOME=<임시>` 로.
1. `ATHENA_STUDIO_HOME=<임시> npm start` → 격리한 스튜디오 집에 코어가 풀리고 현황판이 본체 설정 포트로 뜬다. 팩 acme · globex 는 화면에서 만들거나 가져온다(코어 쪽 손 준비는 `athena/docs/pack.md` "여러 팩 테스트")
2. A→B→A: 바꿀 때마다 현황판 카드 · 계획서 · 이슈가 그 팩 것만 · `repos/` 가 그 팩 레포만 · B 에서 A 계획서가 안 보임 · A 의 pane 은 살아 있음
3. 가져오기 · 내보내기를 코어 fixtures(`athena/test/fixtures/bad-packs` · 같은 이름)로 — 코어 오류 코드마다 안내가 뜨는지
