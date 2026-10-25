# athena-studio — 개발 안내 (Claude Code · Codex 공통)

이 레포를 **고치는** 에이전트용 정본. Codex 는 이 파일을, Claude Code 는 `CLAUDE.md`(이 파일을 불러온다)를 읽는다. 앱이 무엇인지 · 화면 · 데이터 자리는 [`README.md`](README.md).

> **`athena/CLAUDE.md` · `athena/AGENTS.md` · `athena/.claude/rules/` 는 따르지 않는다.** 코어 본체에서 아테나(팀 리드)를 켤 때의 페르소나 규칙이다("직접 코드를 작성하지 않는다" · 계획서 · `commit.sh` 등). 이 레포에서 `athena/` 코드를 고칠 때도 이 문서가 기준이다 — 그 파일들은 고칠 대상일 뿐이다.

## 레포 경계
- `src/` · `scripts/` · `bin/` · `test/` — Electron 앱
- `athena/` — 스튜디오 코어의 **정본**. 코어를 고치면 여기서 고치고 여기 커밋한다. 이 폴더를 본체로 직접 쓰지 않는다
- 사용자의 `~/.athena-studio/core` · `bodies/` 는 설치본이다 — 소스로 고치지 않는다(다음 업데이트에 덮이거나 `core-edits` 백업으로 빠진다)

## 명령
```sh
npm install     # postinstall: spawn-helper 권한 · .dev-app/Athena.app 만들기
npm start       # 코어 번들 만들고 개발 앱 켜기(맥)
npm run check   # 문법(node --check — 목록은 package.json 에 손으로)
npm test        # test/*.test.js (node:test) — 순수 로직 + 데몬 통합(실제 pty)
```
빌드 · 패키징 스크립트는 아직 없다. 서버 · CI 에서는 Electron 을 띄우지 않는다 — 화면 확인은 맥에서.

## 검사
- 앱을 고쳤으면 `npm run check` · `npm test`. node-pty 를 못 불러오면 데몬 통합 테스트가 **skip** 된다(`test/daemon.test.js`) — 통과 숫자만 보지 말고 skip 이 없는지 본다
- `npm test` 는 코어를 보지 않는다. `athena/` 를 고쳤으면 고친 곳에 맞는 코어 검사를 따로(`athena/` 에서):
  - `test/packs-test.sh`(본체 하나 · 약 1분) · `test/requests-test.sh`(사람에게 묻는 요청 · 약 30초) · `test/bodies-test.sh`(여러 본체 · update · 약 2분) · `test/bundle-test.sh`(번들 코어 · 약 1분) — 모두 임시 폴더에서 돌고 지운다(`KEEP=1` 이면 남김)
  - PR 자동 리뷰(`scripts/pr-auto.mjs` · `scripts/lib/pr-auto.mjs`)를 고쳤으면 `test/pr-auto-test.sh`(몇 초 · 가짜 리뷰어 · GitHub 를 건드리지 않는다)
  - 다이어그램 테마(`scripts/diagram-theme.mjs` · `.css`)를 고쳤으면 `test/diagram-theme-test.sh`(몇 초) — 그리고 `docs/diagrams/*.html` 에 다시 입힌다
  - 화면 계층(`scripts/lib/screen.py` · `screen.mjs`)을 고쳤으면 `scripts/screen-lint.sh` · `scripts/screen-check/check.sh`(golden 비교) · 경로를 바꿨으면 `scripts/path-lint.sh`
  - 자세한 것은 `athena/docs/pack.md` "여러 팩 테스트"

## 고칠 때 같이 바꾸는 곳
| 바꾸는 것 | 같이 |
|---|---|
| 데몬 ↔ 앱 · CLI 통신(요청 · 응답 · 알림 형식, 요청 하나 더하기도) | `src/lib/protocol.js` `PROTOCOL`(지금 5)을 올리고 그 위 주석에 한 줄 · `src/daemon/main.js` · `src/daemon/cli.js` · `src/daemon-client.js` · 코어 화면 계층 `athena/scripts/lib/screen.py`(CLI 를 부른다) · `athena/scripts/screen-check/fake-bin/athena-studio-cli` · `test/protocol.test.js` · `test/daemon.test.js`. 번호가 다르면 켤 때 데몬 다시 띄우기를 묻고, 사용자가 고르면 **pane 이 모두 닫힌다**(고르지 않으면 옛 데몬에 붙어 바꾸기 · 새 창이 막힌다) — `open-url` 처럼 올리지 않은 예외는 이유를 주석에 남긴 것만, 일반 규칙으로 넓히지 않는다 |
| 팩 명령 약속(`pack … --json` 출력 · 오류 코드) | 앱 `src/lib/pack.js` `CONTRACT` 와 코어 `athena/scripts/lib/bodies.mjs` `CONTRACT`(둘 다 3 — 데몬 `PROTOCOL` 과는 별개) · 출력 해석 · `packErrorText` · `scripts/fake-pack.js`(같은 모양으로) · `test/pack.test.js` · 코어 `athena/docs/pack.md` |
| 화면 문구 | `src/i18n/{ko,en,ja,zh}.json` 네 곳에 같은 키 · 같은 `{자리}`(`test/i18n.test.js`). 문구를 부르는 새 화면 파일은 `test/i18n-usage.test.js` `SCRIPT_FILES` · `HTML_FILES` 에 더한다 |
| 새 `.js` 파일 | `package.json` `check` 목록(자동으로 찾지 않는다) |
| 순수 로직 | `src/lib/` 에 두고 `test/<이름>.test.js` — Electron 없이 돈다 |
| 스튜디오 집 자리 · 번들 · 업데이트 · 초기화 | `src/lib/studio-home.js` 한 곳(`coreBundlePath` · `resetPlan`) · `test/studio-home.test.js` · README "스튜디오 집과 데이터" |
| 메뉴 · 단축키 · 화면 동작 | README "화면" · "팩" · "문제가 생기면" |

## 함정
- **번들은 커밋된 `HEAD:athena` 에서 만든다** — `athena/` 의 미커밋 변경은 `npm start` 에 들어가지 않는다. `athena/` 트리가 같으면 다시 만들지 않고, 만들다 실패해도 앱은 이전 번들 · 이미 푼 코어로 켜진다(`[dev-app] 코어 번들을 만들지 못했어요` 경고만). 켜졌다고 최신 코어가 들어간 것이 아니다 — `npm start` 로그를 본다. (커밋이 필요하다는 뜻이지, 사용자에게 묻지 않고 커밋해도 된다는 뜻은 아니다)
- **데몬은 앱보다 오래 산다** — 데몬 코드(`src/daemon/`)를 고치고 앱만 다시 켜면 옛 데몬에 붙는다. [보기 → 작업 창 데몬 다시 띄우기] 가 필요하고 그러면 pane 이 모두 닫힌다 — 사용자가 에이전트를 돌리는 중이면 먼저 묻는다
- **팩 바꾸기는 pane 을 닫지 않는다** — 창이 다른 본체로 다시 붙을 뿐(`main.js` `packOpen` → `rebindBody`). pane 이 닫히는 것은 사용자가 pane · 탭을 닫을 때 · 옛 터미널 모니터 칸(데몬 dock) 정리 · 데몬 다시 띄우기 · 스튜디오 초기화뿐이다
- **창마다 문맥이 따로** — 본체 · 데몬 연결 · 현황판 · 옆 브라우저 · 모니터 · 팩 상태는 창(`ctx`)마다. 팩 상태를 전역으로 두지 않고, IPC 는 보낸 창의 문맥으로 처리한다. 트레이는 별도 preload(`preload-tray.js`)와 보낸 쪽 검사를 유지한다
- **팩을 바꾸는 명령은 끊지 않는다** — `use` · `new` · `open` · `update` · `import --replace` 는 시간이 넘어도 "오래 걸려요" 만 띄우고 기다린다(`main.js` `PACK_TIMEOUTS` 근처). 여기에 일괄 timeout 종료를 넣지 않는다
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
