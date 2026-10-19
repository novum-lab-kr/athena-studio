# athena-studio
Athena Studio — 아테나(AI 에이전트 개발팀) 데스크톱 앱. 작업 창(자체 터미널 — 탭 · 분할) · 현황판을 한 창에

## 켜기 (맥)
```sh
npm install   # node-pty 는 맥 prebuild 를 쓴다(Xcode 빌드 필요 없음)
npm start     # 맥은 개발용 Athena.app(.dev-app/ · git 무시)으로 켠다 — 메뉴 막대 · Dock · ⌘Tab 이름이 Athena
```
`npm install`(postinstall)이 `node_modules` 의 Electron.app 을 `.dev-app/Athena.app` 으로 복제(APFS)해 이름(Athena) · 앱 아이콘을 바꾸고 이 컴퓨터용으로 다시 서명한다(`scripts/dev-app.js` — Electron 버전 · 아이콘이 바뀌면 `npm start` 때 다시 만든다, 못 만들면 Electron 이름 그대로 켠다).
**스튜디오는 `~/athena`(herdr 용 아테나)와 완전히 다른 앱이다**(아테나 계획서 `20261019-스튜디오-코어-내장`) — 아테나 코어를 앱이 들고 와서 자기 자리에서 쓰고, 본체 · 데이터 · 레지스트리 · 현황판 포트 · 데몬 접속 파일을 `~/athena` 와 나누지 않는다(회사 레포 클론만 같이 쓴다).
- `npm start` 가 켜기 전에 이 레포 `athena/`(git subtree)의 **커밋된** 기록으로 코어 번들을 만든다(`git subtree split` → `.dev-app/resources/athena-core.bundle` · git 무시 · athena/ 트리가 그대로면 다시 만들지 않는다). 배포판(아직 없음 — 패키징은 다음 계획)은 같은 이름을 앱 리소스(`extraResources`)로 넣는다 — 자리는 `src/lib/studio-home.js` `coreBundlePath` 한 곳
- 처음 켜면 번들을 스튜디오 집에 푼다:
  ```
  ~/.athena-studio/core          주 본체(번들에서 clone 한 git 저장소 · main · origin = 번들)
  ~/.athena-studio/bodies/<id>   팩 본체(코어가 만든다 — 레지스트리 bodiesDir)
  ~/.athena-studio/data          데이터 폴더(본체 athena.config.json 의 dataDir · 레지스트리 data/config.json 에 bodiesDir · portBase 4800)
  ~/.athena-studio/daemon.json   데몬 접속 파일(개발 앱은 daemon-dev.json)
  ```
- 다시 켤 때 들고 온 번들이 주 본체보다 **앞이면** 업데이트한다(뒤 · 갈라짐이면 건드리지 않는다). 팩이 있으면 코어 `update --from <번들> --backup-dirty`(팩 본체마다 · 일하는 본체는 건너뜀 · 고친 코어 파일은 `data/backups/core-edits/` 에 사본) · 팩이 없는 주 본체는 앱이 앞으로 감는다(고쳐 뒀으면 같은 자리에 사본을 두고). 건너뛴 본체 · 백업 · 실패는 첫 창 위에 한 번 알리고, 기록은 앱 데이터 `pack.log`. 사용자 데이터(`data/`)는 업데이트가 쓰지 않는다
- [이미 받은 아테나 폴더 고르기…] · [파일 → 아테나 폴더 바꾸기…] 는 개발용으로 남아 있다(다른 본체를 직접 열 때)
팩은 탭 줄 왼쪽 `▣ <팩> ▾`(카트리지 아이콘 · 또는 [파일 → 팩…] · ⌘⇧P)에서 고르고 · 갈아 끼우고 · 가져오고(압축 파일 · 팩 폴더 · git 레포 · 기존 아테나) · 내보내고 · 백업한다. 일은 모두 본체 명령 `node scripts/athena.mjs pack … --json` 이 하고(약속 정본: 그 계획서 "5. 공통 스펙"), 앱은 부르고 · 기다리고 · 화면을 정리한다. 본체가 아직 여러 팩을 지원하지 않으면 이 메뉴는 숨는다.
시작 화면 — 앱을 켤 때마다(팩이 있어도 · 켤 때 도는 에이전트가 없으면) 작업 창 가운데에 밤하늘 시작 화면(부엉이 · ATHENA · [새 팩 만들기] · [팩 가져오기] · 아래 "내 팩" 목록 — 지금 팩 맨 위 · 최근 순(pack list 의 updatedAt) · 최대 5개). 목록에서 고르면 그 팩으로 들어간다(지금 팩이면 바로 · 다른 팩이면 갈아 끼우기 — 닫을 pane 이 없으면 확인 없이). 팩이 하나도 없으면 만들기 · 가져오기만. 떠 있는 동안 에이전트 모니터는 접어 두고 들어가면 펼친다.
팩을 갈아 끼우면 그 팩에 묶인 pane 만 닫는다(R2) — 본체 `pack busy` 의 에이전트를 품은 pane · `athena` 작업 공간 · 본체 · 데이터 폴더(코어 `pack status` 의 `dataDir`) 안 pane. 다른 프로젝트에서 도는 claude · 다른 폴더 셸은 그대로 둔다. 일하는 에이전트(닫을 pane 안)가 있으면 [끝나면 바꾸기] · [멈추고 바꾸기](Esc) · [취소]. 바꾸기 명령은 오래 걸려도 중간에 끊지 않고 "오래 걸려요" 만 보여 준다(R3). 돌아오면 계획서 Checkpoint 로 이어 간다(pane · 대화 되살리기는 2단계). 스튜디오 밖에서 도는 에이전트 · 무거운 명령이 있으면 아무것도 닫지 않고 멈춘다.
이 레포의 `athena/`(아테나 레포 git subtree)는 앱이 들고 갈 코어의 출처다 — 본체로 직접 쓰지 않는다.

### 아테나 받기 · 보내기 (git subtree — 자동으로 하지 않는다)
정본은 아테나 레포다. 스튜디오에서 고친 아테나는 아테나 레포로 보내고, 아테나 레포가 바뀌면 받아 온다(작업 트리가 깨끗할 때).
```sh
# 아테나 레포의 새 변경 받기
git subtree pull --prefix athena https://github.com/novum-lab-kr/athena.git main
# 여기서 고친 athena/ 커밋을 아테나 레포로 보내기(아테나 레포 main 에 바로 — 권한 · 리뷰는 아테나 규칙대로)
git subtree push --prefix athena https://github.com/novum-lab-kr/athena.git main
```
subtree 를 받아 커밋한 뒤 `npm start` 로 켜면 새 번들 → 스튜디오 코어 업데이트까지 이어진다. 열린 창 목록은 앱 데이터 `config.json` 에 기억한다.

### 앱 데이터 — 개발 앱과 배포판은 따로
| | 개발 앱(`npm start`) | 배포판(나중) |
|---|---|---|
| 앱 데이터(설정 · 데몬 소켓 · 로그) | `~/Library/Application Support/Athena Studio Dev/` | `~/Library/Application Support/Athena Studio/` |
| 데몬 접속 파일 | `~/.athena-studio/daemon-dev.json` | `~/.athena-studio/daemon.json` |
| 번들 ID | `kr.novum-lab.athena-studio.dev` | (패키징 때) |

스튜디오 집의 코어 · 본체 · 데이터(`~/.athena-studio/{core,bodies,data}`)는 둘이 같이 쓴다. 이전 개발 앱이 쓰던 `Athena Studio/` 앱 데이터는 읽지 않는다(처음 켜면 새로 시작한다).

## 화면
| 탭 | 단축키 | 하는 일 |
|---|---|---|
| 🖥 작업 창 | ⌘1 | 3칸 — 왼쪽 작업 공간(herdr spaces 처럼 레포마다 하나 · 이름 아래 브랜치 · 그 안 에이전트와 상태 — 아테나 delegate 가 만든다) · 가운데 탭 · 분할 터미널(xterm.js) · 오른쪽 Explorer. 셸은 데몬이 갖는다 — 처음엔 `athena` 작업 공간(아테나 폴더 — 이름과 폴더가 둘 다 맞는 것)에서 claude · codex 를 켠다 |
| 📋 현황판 | ⌘2 | **여러 팩을 지원하는 본체면 포트는 본체가 정한다**(레지스트리 `packs.<id>.boardPort` → 본체 `athena.config.json` `boardPort` → `ATHENA_BOARD_PORT` → 레지스트리 `portBase` — 스튜디오 데이터는 4800(주 본체) · 4802부터 2씩(팩 본체) · 앱은 `pack status` 로 읽기만 — 본체 하나에 현황판 하나, 떠 있는 현황판의 `/api/state.pack` 이 지금 팩 · 세대와 맞으면 herdr 가 띄웠든 앱이 띄웠든 같이 쓰고, 다른 팩 것이면 끄고 다시 띄운다). 옛 본체면 `http://localhost:<boardPort>`(기본 4701) — 포트는 알아서 고른다: 저장된 포트부터 20개를 차례로 보고, 이 아테나 폴더에서 도는 현황판이면 그대로 쓰고 · 비었으면 `scripts/board/server.mjs` 를 띄우고 · 다른 것(herdr 용 `~/athena` 현황판 4700 등)이나 주인을 알 수 없는 것이 쥐고 있으면 다음 번호(맥 `lsof` 로 그 프로세스의 작업 폴더를 본다) |

- 작업 창 단축키 — ⌘⇧B 옆 브라우저 열기·닫기 · ⌘T 새 탭 · ⌘⇧T 새 작업 공간(폴더 고르기) · ⌘D 오른쪽으로 나누기 · ⌘⇧D 아래로 나누기(pane 사이 경계를 끌어 크기 바꾸기 · 더블클릭 반반 — 비율은 데몬 탭 트리에 저장) · ⌘W pane 닫기 · ⌘⌥W 탭 닫기(둘 다 에이전트가 돌면 묻는다) · ⌘⌥방향키 옆 pane · ⌘⇧[ / ⌘⇧] 이전·다음 탭 · ⌘⇧↑ / ⌘⇧↓ 이전·다음 작업 공간 · ⌘B 왼쪽 작업 공간 접기(아이콘 줄) · ⌘⌥B 오른쪽 Explorer 접기(칸 머리의 « » 로도) · 가운데 맨 아래는 🛰 에이전트 모니터(athena 작업 공간에서만 · 앱 화면) — main 이 Claude 기록(`~/.claude/projects` 의 JSONL — 아테나 `agent-monitor.py` 와 같은 대상: 서브에이전트 · 워크트리 세션 · 에이전트 pane 폴더 세션, 최근 120분)을 보일 때만 따라 읽어 머리줄에 세션 칩(레포·브랜치 / 🤖 서브에이전트 설명 · 도구 수 · 마지막 활동, 누르면 그 세션만), 아래에 시각 · 도구 · 요약 피드를 보여 준다. ⌄ 로 접기(기억함). 예전 터미널 모니터 칸(데몬 dock)은 붙을 때 닫는다. 창 닫기는 ⌘⇧W
- 오른쪽 Explorer — 지금 작업 공간 폴더의 [파일] 트리(VSCode Material Icon Theme 아이콘 — `material-icon-theme` MIT · 바뀐 파일 글자 M·U·A·D·R · 그 폴더 ●) / [변경] git 목록. 누르면 터미널 옆에 뷰어 — VSCode 처럼 확장자에 맞는 색(Shiki · Dark+ 테마)과 줄 번호, 바뀐 파일은 diff(옛·새 번호), 이미지는 그림(Esc 로 닫기). 파일은 main 이 그 작업 공간 폴더 안만 읽고 색도 main 이 칠한다
- 맥 상단 메뉴 막대 아이콘(흰 로고 · 맥에서만) — 막힘이 있으면 로고에 빨간 점(숫자는 두지 않는다). 누르면 아이콘 아래로 반투명 패널(배경 없이 맥 HUD 재질): 머리줄(로고 · 30분 작업량 그래프 · 현황판 연결 · 알림을 멈췄으면 🔕 · ☰ 열기 · 현황판 · 알림 일시 중지 · 종료) · 확인 필요 배너(막힌 에이전트 → 그 pane · 막힘·리뷰 대기 계획서 → 결정 콘솔을 옆 브라우저로 · 3줄 + n개 더 · 없으면 ✓ 한 줄) · 작업 공간별 에이전트(누르면 그 pane · 많으면 칸 안 스크롤) · 사용량(도구마다 링 + 창별 % · 리셋) · 칸반 숫자 5칸(현황판이 꺼지면 숨김) · 칸 제목을 누르면 접힘(기억). 맥 알림: 막힘이 8초 이어짐 · 일하다 멈춘 뒤 10초(응답 끝) · 계획서가 리뷰 대기 · 완료로 바뀜(켤 때 있던 상태는 알리지 않고, 보고 있는 pane 은 빼고, 같은 종류 여러 건은 묶는다 · 문구에 명령·지시 내용은 넣지 않는다). 이미 붙은 데몬에서 4초마다 pane 목록 · 15초마다 현황판 `/api/state`(현황판을 띄우지는 않는다). 맥은 창을 닫아도 메뉴 막대에 남는다 — 끄기는 [Athena 종료] · ⌘Q
- Ctrl 조합은 모두 pane 안(셸 · 에이전트)으로 간다. 앱 단축키는 ⌘ 만 쓴다(⌘R = 현황판 새로고침).
- 앱을 닫아도 데몬 · 셸 · 에이전트 · 현황판은 계속 돈다. 다시 켜면 같은 탭 · 배치 · 화면으로 다시 붙는다.
- 데몬: 앱이 없으면 떼어 띄운다(Electron 을 node 로). 소켓 `<앱 데이터>/daemon.sock`(경로가 길면 임시 폴더 `athena-studio-<uid>[-dev]/`) · 로그 `daemon.log` · pane 밖에서 찾는 접속 파일 `~/.athena-studio/daemon.json`(개발 앱 `daemon-dev.json` — 일반 터미널의 아테나는 `daemon.json` 만 보므로 개발 앱 데몬은 pane 안에서만 쓴다). 아테나 화면 계층은 `bin/athena-studio-cli` 로 pane 을 다룬다
- pane 셸에는 `ATHENA_STUDIO=1` · `ATHENA_STUDIO_PANE_ID` · `ATHENA_STUDIO_TAB_ID` · `ATHENA_STUDIO_WORKSPACE_ID` · `ATHENA_STUDIO_SOCKET` · `ATHENA_STUDIO_CLI` · `ATHENA_STUDIO_NODE` 가 들어 있다
- 연결이 끊기면 [보기 → 작업 창 다시 붙기]. 데몬 파일을 고쳤으면 [보기 → 작업 창 데몬 다시 띄우기(pane 모두 닫힘)…]
- 🌐 옆 브라우저(⌘⇧B · 탭 줄 오른쪽 지구본 아이콘) — 오른쪽에서 스르륵 나오는 서랍(왼쪽 가장자리를 끌어 너비 바꾸기 · 기억함 · 더블클릭 기본 너비). 계획서 · 테스트 화면을 띄운다(◀ ▶ ⟳ · 주소창 — `localhost:3000` 처럼 치면 http · Esc 닫기 · ↗ 기본 브라우저로). 페이지는 main 의 WebContentsView(아무 사이트 · 로그인 쿠키는 앱 전용 저장소 `persist:studio-browser` · 샌드박스 · 권한 요청 거절 · http(s) 만)
- 링크 — 현황판에서 누른 http(s) 링크(결정 콘솔 등)는 모두 옆 브라우저, 터미널에서 누른 링크는 localhost 면 옆 브라우저 · 그 밖은 기본 브라우저. 앱이 새 창을 따로 만들지는 않는다.
- 현황판 로그: `<앱 데이터>/board.log`

## 설정 (`config.json`)
| 키 | 기본 | 뜻 |
|---|---|---|
| `athenaDir` · `windows` | 없음 | 열린 팩 창의 본체 폴더(처음 켜면 `~/.athena-studio/core`) |
| `boardPort` | 4701 | (옛 본체에서만 — 팩 지원 본체는 본체가 정한 포트를 쓴다) 현황판 포트를 고르기 시작하는 번호 — 고른 포트를 다시 적는다(앱을 켤 때 · 아테나 폴더를 정할 때 미리 고른다). 현황판 서버에는 `ATHENA_BOARD_PORT` 로 넘기고, 스튜디오가 만든 아테나 설정(`screen: studio`)의 `athena.config.json` `boardPort` 에도 적는다 — pane 안의 아테나가 그 값을 읽어야 맞는 현황판에 콘솔이 뜬다(아테나 쪽 지원 필요). |
| `language` | 없음 | 화면 언어 `ko` · `en` · `ja` · `zh` — [보기 → 언어] 로 고르면 적는다. 없으면 시스템 언어, 네 언어 밖이면 영어 |

예전 키 `homeAthenaAsked` · `studioAthenaAsked` 는 읽으면서 버린다.

## 구조
- `athena/` — 아테나 레포 git subtree(앱이 들고 갈 코어의 출처 · 위 '아테나 받기 · 보내기')
- `src/lib/studio-home.js` — 스튜디오 집(앱 신원 · 자리 · 번들 만들기 · 풀기 · 본체 설정 · 레지스트리 손잡이 · 켤 때 업데이트 판단)
- `src/i18n/<언어>.json` — 화면 문구 사전(평평한 키 · 자리는 `{이름}`) · `src/lib/i18n.js` — 언어 고르기 · `t()`(main 은 require, 화면 · 트레이는 `<script>` + preload `i18n()`). 문구를 더하면 네 사전에 같은 키로(테스트가 키 · 자리 · 남은 한국어를 본다 — `test/i18n*.test.js`). 일 · 중은 검수 전(`meta.status: draft`)
- `src/lib/pack.js` — 팩 순수 로직(본체 명령 출력 읽기 · git 주소 검사 · 갈아 끼우기 점검 · 닫을 pane · 시작 화면 · 내 팩 목록) · `scripts/fake-pack.js` — 개발용 가짜 본체(아래 '팩 확인')
- `src/main.js` — 창 · 메뉴(단축키) · 데몬에 붙어 화면에 중계 · 현황판 서버 · 폴더 설정
- `src/daemon-client.js` — 데몬 띄우기 · 붙기 · 버전 확인
- `src/daemon/` — 데몬(`main.js` 소켓 서버 · `pane.js` pty + 화면 버퍼 · `cli.js` 데몬 CLI) · `bin/athena-studio-cli`
- `src/preload.js` — 화면에 열어 주는 IPC 함수
- `src/renderer/` — 작업 공간 · 탭 · 분할 pane · Explorer · 현황판 iframe · 처음 켤 때 폴더 고르기
- `src/lib/` — Electron 없이 도는 순수 로직(`npm test`) — `core.js` · `layout.js`(분할 트리 — 화면도 `<script>` 로 쓴다) · `screen-model.js` · `protocol.js` · `explorer.js` · `file-icons.js`(Explorer 아이콘 고르기 — main) · `viewer.js`(뷰어 줄·diff·언어)
- `src/renderer/assets/logo/` — 로고. 앱은 **화이트판**을 쓴다
  - 화면: `athena-logo-white.png`(탭 줄 왼쪽 · 처음 켤 때 화면)
  - 앱 아이콘: `athena-app-icon.png`(1024 · 둥근 사각형 — Dock · 윈도우·리눅스 창 아이콘 `src/main.js` `APP_ICON` · 개발용 Athena.app 번들 아이콘은 이걸로 .icns 를 만든다) · 크기별 `athena-app-{32,64,128,256,512}.png`
  - 패키징용: `athena.ico`(윈도우 앱 아이콘) · `athena-white.icns` · `favicon-white.ico` — 아직 패키징 설정이 없어 쓰는 곳 없음
  - 화이트가 아닌 판(`athena-*.png` · `athena.icns` · `favicon.ico` · `athena-logo.png`)은 지금 안 쓴다

## 검사
```sh
npm run check   # 문법
npm test        # 순수 로직 + 데몬 통합(맥 — 실제 pty)
```
화면 확인은 맥에서 한다(서버에서는 Electron 을 띄우지 않는다).

### 팩 확인 (아테나 계획서 7.1 에 붙일 절차)
**공통 준비** — 지금 켜진 개발 앱을 끈다(같은 앱 데이터 · 데몬 접속 파일을 쓴다). 데몬은 옛 버전이면 [보기 → 작업 창 데몬 다시 띄우기] 를 한 번(열린 pane 이 닫힌다 — 새 데몬이어야 팩을 갈아 끼울 때 pane pid 로 스튜디오 밖 에이전트를 가린다).

**격리 실행(사용자 앱이 켜져 있을 때 개발 확인)** — Electron 은 `HOME` 을 바꿔도 홈 경로를 그대로 쓴다. `ATHENA_STUDIO_HOME=<임시> npm start` 면 스튜디오 집(코어 · 본체 · 데이터 · 접속 파일)과 앱 데이터(`<임시>/app/Athena Studio Dev/`)가 모두 그 아래로 간다 — 사용자 앱 · `~/.athena-studio` 를 건드리지 않는다(소켓은 길면 임시 폴더 `athena-studio-<uid>-dev/` — 같은 때 다른 격리 실행과는 겹친다). 끝나면 앱과 함께 데몬도 끈다(`<임시>/daemon-dev.json` 의 `pid`). 예전 방식(`ATHENA_STUDIO_ENDPOINT=<임시>/daemon.json` + `--user-data-dir=<임시>`)은 앱 데이터 · 접속 파일만 가르고 코어 · 데이터는 진짜 `~/.athena-studio` 를 쓴다 — 격리하려면 `ATHENA_STUDIO_HOME` 을 쓴다.

**A. 가짜 본체로 화면 흐름** — ⚠️ 가짜여도 **팩 갈아 끼우기 · 새로 만들기는 진짜 데몬의 pane 을 닫는다**(`athena` 작업 공간 · 본체 안 pane — 가짜 본체는 busy 가 비어 있어 다른 에이전트 pane 은 안 닫는다) — 하던 에이전트 작업을 끝낸(계획서 Checkpoint 를 남긴) 뒤에 한다. `ATHENA_STUDIO_FAKE_PACK=1 npm start`(스튜디오 코어는 그대로 준비된다 — 팩 명령만 가짜). 본체 명령 대신 `scripts/fake-pack.js` 가 계획서 5절 모양으로 답한다(파일 · 링크는 안 만진다 · 상태는 임시 폴더 `athena-studio-fake-pack.json`, 지우면 처음으로 · 현황판 포트는 `ATHENA_BOARD_PORT` 없으면 4701).
1. 앱을 켜면 시작 화면 "내 팩" 에 acme · globex · broken(acme 맨 위 "지금") — acme 를 고르면 바로 작업 창 · 탭 줄 `▣ acme ▾`(⌘⇧P) → 목록 acme · globex · broken + 새로 만들기 · 가져오기 · 내보내기 · 내 백업이 보인다
2. globex 로 바꾸기 → "pane N개가 닫혀요" 확인 → 진행 표시(잠금 → … → 끝) → 칩이 globex · 현황판 다시 뜸 · "연결하지 못한 레포: globex-api" 알림
3. 에이전트가 일하는 중에 바꾸기 → [끝나면 바꾸기] · [멈추고 바꾸기] · [취소] 가 뜬다 — [끝나면] 은 기다리는 동안 [취소] 가능, pane 닫기가 시작되면 [취소] 가 사라진다
4. broken 으로 바꾸기 → "바꾸다 실패해서 이전 팩으로 되돌렸어요" · 칩은 그대로
5. 가져오기 → 압축 파일에서 이름에 `bad` 든 파일 → "안전하지 않은 파일…" / 이름이 `acme-pack…tar.gz` → 같은 이름 비교(지금 있는 것 · 가져온 것) → [가져온 것으로 바꾸기] → "기존 팩은 자동 백업했어요" / git 레포 → `https://u:비번@…` 이나 공백 든 주소는 거절, `git@github.com:x/newco.git` 은 등록 → "지금 이 팩으로 바꿀까요?" / 기존 아테나 → 작업 기록(계획서 · 이슈 · 보관함 · 워크트리 1개 미커밋) 이 보이고 acme 와 같은 이름 비교
6. 내보내기 · 내 백업 → 저장 폴더 고르기 → "만들었어요 — 파일 N개 · KB" · [Finder 에서 보기](가짜는 파일을 실제로 만들지 않는다 — 경로만)
7. 팩 창을 연 채로 메뉴에서 또 열기 → "팩 작업이 진행 중이에요" 알림만

**B. 진짜 본체로(코어 1단계 명령이 나온 뒤)** — 진짜 `~/athena` · `~/athena-data` 는 건드리지 않는다.
1. 코어 준비: 아테나 `docs/pack.md` "여러 팩 테스트"(본체 `~/novum-lab/athena` · 데이터 `ATHENA_DATA_DIR=~/athena-test-data` · 팩 acme · globex · 현황판 4710)
2. `ATHENA_DATA_DIR=~/athena-test-data npm start` → [파일 → 아테나 본체 폴더 바꾸기…] 로 `~/novum-lab/athena` → 현황판이 4710 으로 뜬다(본체 설정을 따라감). ⚠️ 이건 **진짜 앱 설정**(`~/Library/Application Support/Athena Studio Dev/config.json` 의 `athenaDir` · `windows`)을 바꾼다 — 끝나면 [아테나 본체 폴더 바꾸기…] 로 원래 폴더로 되돌린다(켜기 전에 `config.json` 을 복사해 두면 되돌리기 쉽다). 진짜 앱 · 데몬을 아예 안 건드리려면 위 '격리 실행'(`ATHENA_STUDIO_HOME=<임시>` · 그 임시 `app/Athena Studio Dev/config.json` 에 `windows` 를 적어 둠)으로 한다
3. A→B→A: 바꿀 때마다 현황판 카드 · 계획서 · 이슈가 그 팩 것만 · `repos/` 가 그 팩 레포만 · B 에서 A 계획서가 안 보임
4. 스튜디오 밖 터미널에서 테스트 본체로 `claude` 를 켜 둔 채 바꾸기 → 아무것도 닫지 않고 "스튜디오 밖에서 도는 에이전트" 로 멈춤
5. 가져오기 · 내보내기를 코어 fixtures(나쁜 팩 · 같은 이름)로 — 5절 오류 코드마다 안내가 뜨는지

## 단계
① 시제품(Electron + 탭 두 개) → ② 아테나 코어의 herdr 호출을 한 곳으로 모으기(아테나 팀) → ③ 앱 자체 터미널 데몬으로 herdr 없이(지금 — 코어 studio 백엔드는 아테나 팀)
