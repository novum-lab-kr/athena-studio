# athena-studio
Athena Studio — 아테나(AI 에이전트 개발팀) 데스크톱 앱. 작업 창(자체 터미널 — 탭 · 분할) · 현황판을 한 창에

## 켜기 (맥)
```sh
npm install   # node-pty 는 맥 prebuild 를 쓴다(Xcode 빌드 필요 없음)
npm start
```
스튜디오는 앱 껍데기만 관리하고, 아테나 코드는 아테나 레포(`novum-lab-kr/athena`)가 관리한다.
처음 켜면 묻지 않고 **스튜디오 전용 아테나**를 앱 데이터 폴더(`~/Library/Application Support/Athena Studio/athena`)에 clone 하고 바로 연결한다
(이미 아테나가 있으면 그대로 쓰고, 아테나가 아닌 것이 있으면 건드리지 않는다). herdr 용 아테나(`~/athena`)와 따로 두고 찾아 쓰지도 않는다 —
팩도 따로라 처음 claude · codex 를 켜면 `/setup` 이 시작된다(받을 때 만드는 `athena.config.json` 은 `{ "reposRoot": "<홈>", "screen": "studio" }` — 레포는 예전처럼 홈 아래에서 찾고, 화면은 스튜디오 데몬으로 다루게 고정한다. 직접 고른 아테나 폴더면 `reposRoot` 는 `..`. 이미 있으면 건드리지 않는다). 받기에 실패하면 [이미 받은 아테나 폴더 고르기…].
예전 스튜디오처럼 `~/athena` 를 쓰고 있었으면 처음 켤 때 한 번 "스튜디오 전용 아테나를 받을까요?" 를 묻는다
([받기] — 앱 데이터 폴더에 새로 받아 그 폴더로 `athena` 작업 공간을 새로 만들고, 하단 모니터 칸도 새 폴더로 다시 띄운다 · `~/athena` 와 그 작업 공간 · 에이전트는 그대로 / [지금 그대로] — 다시 묻지 않는다).
고른 폴더는 `~/Library/Application Support/Athena Studio/config.json` 에 기억한다. 바꾸려면 [파일 → 아테나 폴더 바꾸기…].

## 화면
| 탭 | 단축키 | 하는 일 |
|---|---|---|
| 🖥 작업 창 | ⌘1 | 3칸 — 왼쪽 작업 공간(herdr spaces 처럼 레포마다 하나 · 이름 아래 브랜치 · 그 안 에이전트와 상태 — 아테나 delegate 가 만든다) · 가운데 탭 · 분할 터미널(xterm.js) · 오른쪽 Explorer. 셸은 데몬이 갖는다 — 처음엔 `athena` 작업 공간(아테나 폴더 — 이름과 폴더가 둘 다 맞는 것)에서 claude · codex 를 켠다 |
| 📋 현황판 | ⌘2 | `http://localhost:<boardPort>`(기본 4701) — 포트는 알아서 고른다: 저장된 포트부터 20개를 차례로 보고, 이 아테나 폴더에서 도는 현황판이면 그대로 쓰고 · 비었으면 `scripts/board/server.mjs` 를 띄우고 · 다른 것(herdr 용 `~/athena` 현황판 4700 등)이나 주인을 알 수 없는 것이 쥐고 있으면 다음 번호(맥 `lsof` 로 그 프로세스의 작업 폴더를 본다) |

- 작업 창 단축키 — ⌘⇧B 옆 브라우저 열기·닫기 · ⌘T 새 탭 · ⌘⇧T 새 작업 공간(폴더 고르기) · ⌘D 오른쪽으로 나누기 · ⌘⇧D 아래로 나누기 · ⌘W pane 닫기 · ⌘⌥W 탭 닫기(둘 다 에이전트가 돌면 묻는다) · ⌘⌥방향키 옆 pane · ⌘⇧[ / ⌘⇧] 이전·다음 탭 · ⌘⇧↑ / ⌘⇧↓ 이전·다음 작업 공간 · ⌘B 왼쪽 작업 공간 접기(아이콘 줄) · ⌘⌥B 오른쪽 Explorer 접기(칸 머리의 « » 로도) · 가운데 맨 아래는 🛰 에이전트 모니터가 늘 떠 있다(아테나 `scripts/agent-monitor.py --stay --recent` — 데몬의 고정 칸이라 앱을 닫아도 돈다) · 가운데 맨 위 에이전트는 아바타 카드를 옆으로(작업 공간 색 동그라미 · 상태 점 · 이름 · 작업 공간, 넘치면 가로 스크롤, 누르면 그 pane). 창 닫기는 ⌘⇧W
- 오른쪽 Explorer — 지금 작업 공간 폴더의 [파일] 트리(VSCode Material Icon Theme 아이콘 — `material-icon-theme` MIT · 바뀐 파일 글자 M·U·A·D·R · 그 폴더 ●) / [변경] git 목록. 누르면 터미널 옆에 뷰어 — VSCode 처럼 확장자에 맞는 색(Shiki · Dark+ 테마)과 줄 번호, 바뀐 파일은 diff(옛·새 번호), 이미지는 그림(Esc 로 닫기). 파일은 main 이 그 작업 공간 폴더 안만 읽고 색도 main 이 칠한다
- Ctrl 조합은 모두 pane 안(셸 · 에이전트)으로 간다. 앱 단축키는 ⌘ 만 쓴다(⌘R = 현황판 새로고침).
- 앱을 닫아도 데몬 · 셸 · 에이전트 · 현황판은 계속 돈다. 다시 켜면 같은 탭 · 배치 · 화면으로 다시 붙는다.
- 데몬: 앱이 없으면 떼어 띄운다(Electron 을 node 로). 소켓 `~/Library/Application Support/Athena Studio/daemon.sock` · 로그 `daemon.log` · pane 밖에서 찾는 접속 파일 `~/.athena-studio/daemon.json`. 아테나 화면 계층은 `bin/athena-studio-cli` 로 pane 을 다룬다
- pane 셸에는 `ATHENA_STUDIO=1` · `ATHENA_STUDIO_PANE_ID` · `ATHENA_STUDIO_TAB_ID` · `ATHENA_STUDIO_WORKSPACE_ID` · `ATHENA_STUDIO_SOCKET` · `ATHENA_STUDIO_CLI` · `ATHENA_STUDIO_NODE` 가 들어 있다
- 연결이 끊기면 [보기 → 작업 창 다시 붙기]. 데몬 파일을 고쳤으면 [보기 → 작업 창 데몬 다시 띄우기(pane 모두 닫힘)…]
- 🌐 옆 브라우저(⌘⇧B · 탭 줄 오른쪽 🌐) — 오른쪽에서 스르륵 나오는 서랍. 계획서 · 테스트 화면을 띄운다(◀ ▶ ⟳ · 주소창 — `localhost:3000` 처럼 치면 http · Esc 닫기 · ↗ 기본 브라우저로). 페이지는 main 의 WebContentsView(아무 사이트 · 로그인 쿠키는 앱 전용 저장소 `persist:studio-browser` · 샌드박스 · 권한 요청 거절 · http(s) 만)
- 링크 — 현황판에서 누른 http(s) 링크(결정 콘솔 등)는 모두 옆 브라우저, 터미널에서 누른 링크는 localhost 면 옆 브라우저 · 그 밖은 기본 브라우저. 앱이 새 창을 따로 만들지는 않는다.
- 현황판 로그: `~/Library/Application Support/Athena Studio/board.log`

## 설정 (`config.json`)
| 키 | 기본 | 뜻 |
|---|---|---|
| `athenaDir` | 없음 | 아테나 폴더 |
| `boardPort` | 4701 | 현황판 포트를 고르기 시작하는 번호 — 고른 포트를 다시 적는다(앱을 켤 때 · 아테나 폴더를 정할 때 미리 고른다). 현황판 서버에는 `ATHENA_BOARD_PORT` 로 넘기고, 스튜디오가 만든 아테나 설정(`screen: studio`)의 `athena.config.json` `boardPort` 에도 적는다 — pane 안의 아테나가 그 값을 읽어야 맞는 현황판에 콘솔이 뜬다(아테나 쪽 지원 필요). 스튜디오 전용 아테나로 옮길 때 예전 기본(4700)이면 4701 부터 |
| `studioAthenaAsked` | false | `~/athena` → 스튜디오 전용 아테나로 옮길지 이미 물었는지 |

## 구조
- `src/main.js` — 창 · 메뉴(단축키) · 데몬에 붙어 화면에 중계 · 현황판 서버 · 폴더 설정
- `src/daemon-client.js` — 데몬 띄우기 · 붙기 · 버전 확인
- `src/daemon/` — 데몬(`main.js` 소켓 서버 · `pane.js` pty + 화면 버퍼 · `cli.js` 데몬 CLI) · `bin/athena-studio-cli`
- `src/preload.js` — 화면에 열어 주는 IPC 함수
- `src/renderer/` — 작업 공간 · 탭 · 분할 pane · Explorer · 현황판 iframe · 처음 켤 때 폴더 고르기
- `src/lib/` — Electron 없이 도는 순수 로직(`npm test`) — `core.js` · `layout.js`(분할 트리 — 화면도 `<script>` 로 쓴다) · `screen-model.js` · `protocol.js` · `explorer.js` · `file-icons.js`(Explorer 아이콘 고르기 — main) · `viewer.js`(뷰어 줄·diff·언어)

## 검사
```sh
npm run check   # 문법
npm test        # 순수 로직 + 데몬 통합(맥 — 실제 pty)
```
화면 확인은 맥에서 한다(서버에서는 Electron 을 띄우지 않는다).

## 단계
① 시제품(Electron + 탭 두 개) → ② 아테나 코어의 herdr 호출을 한 곳으로 모으기(아테나 팀) → ③ 앱 자체 터미널 데몬으로 herdr 없이(지금 — 코어 studio 백엔드는 아테나 팀)
