# athena-studio
Athena Studio — 아테나(AI 에이전트 개발팀) 데스크톱 앱. 작업 창(자체 터미널 — 탭 · 분할) · 현황판을 한 창에

## 켜기 (맥)
```sh
npm install   # node-pty 는 맥 prebuild 를 쓴다(Xcode 빌드 필요 없음)
npm start
```
스튜디오는 앱 껍데기만 관리하고, 아테나 코드는 아테나 레포(`novum-lab-kr/athena`)가 관리한다.
처음 켜면 [아테나 받기…] 로 받을 곳을 고른다 — 그 안의 `athena/` 에 아테나 레포를 clone 하고 바로 연결한다
(이미 아테나가 있으면 그대로 쓰고, 아테나가 아닌 것이 있으면 건드리지 않는다).
이미 받아 둔 폴더(`CLAUDE.md` · `scripts/board/server.mjs` 가 있는 폴더)는 [이미 받은 아테나 폴더 고르기…].
고른 폴더는 `~/Library/Application Support/Athena Studio/config.json` 에 기억한다. 바꾸려면 [파일 → 아테나 폴더 바꾸기…].

## 화면
| 탭 | 단축키 | 하는 일 |
|---|---|---|
| 🖥 작업 창 | ⌘1 | 3칸 — 왼쪽 작업 공간(herdr spaces 처럼 레포마다 하나 · 이름 아래 브랜치 · 그 안 에이전트와 상태 — 아테나 delegate 가 만든다) · 가운데 탭 · 분할 터미널(xterm.js) · 오른쪽 Explorer. 셸은 데몬이 갖는다 — 처음엔 `athena` 작업 공간(아테나 폴더)에서 claude · codex 를 켠다 |
| 📋 현황판 | ⌘2 | `http://localhost:4700` (꺼져 있으면 `scripts/board/server.mjs` 를 띄운다) |

- 작업 창 단축키 — ⌘T 새 탭 · ⌘⇧T 새 작업 공간(폴더 고르기) · ⌘D 오른쪽으로 나누기 · ⌘⇧D 아래로 나누기 · ⌘W pane 닫기 · ⌘⌥W 탭 닫기(둘 다 에이전트가 돌면 묻는다) · ⌘⌥방향키 옆 pane · ⌘⇧[ / ⌘⇧] 이전·다음 탭 · ⌘⇧↑ / ⌘⇧↓ 이전·다음 작업 공간 · ⌘B 왼쪽 작업 공간 접기(아이콘 줄) · ⌘⌥B 오른쪽 Explorer 접기(칸 머리의 « » 로도). 창 닫기는 ⌘⇧W
- 오른쪽 Explorer — 지금 작업 공간 폴더의 [파일] 트리(VSCode Material Icon Theme 아이콘 — `material-icon-theme` MIT · 바뀐 파일 글자 M·U·A·D·R · 그 폴더 ●) / [변경] git 목록. 누르면 터미널 옆에 뷰어 — VSCode 처럼 확장자에 맞는 색(Shiki · Dark+ 테마)과 줄 번호, 바뀐 파일은 diff(옛·새 번호), 이미지는 그림(Esc 로 닫기). 파일은 main 이 그 작업 공간 폴더 안만 읽고 색도 main 이 칠한다
- Ctrl 조합은 모두 pane 안(셸 · 에이전트)으로 간다. 앱 단축키는 ⌘ 만 쓴다(⌘R = 현황판 새로고침).
- 앱을 닫아도 데몬 · 셸 · 에이전트 · 현황판은 계속 돈다. 다시 켜면 같은 탭 · 배치 · 화면으로 다시 붙는다.
- 데몬: 앱이 없으면 떼어 띄운다(Electron 을 node 로). 소켓 `~/Library/Application Support/Athena Studio/daemon.sock` · 로그 `daemon.log` · pane 밖에서 찾는 접속 파일 `~/.athena-studio/daemon.json`. 아테나 화면 계층은 `bin/athena-studio-cli` 로 pane 을 다룬다
- pane 셸에는 `ATHENA_STUDIO=1` · `ATHENA_STUDIO_PANE_ID` · `ATHENA_STUDIO_TAB_ID` · `ATHENA_STUDIO_WORKSPACE_ID` · `ATHENA_STUDIO_SOCKET` · `ATHENA_STUDIO_CLI` · `ATHENA_STUDIO_NODE` 가 들어 있다
- 연결이 끊기면 [보기 → 작업 창 다시 붙기]. 데몬 파일을 고쳤으면 [보기 → 작업 창 데몬 다시 띄우기(pane 모두 닫힘)…]
- 현황판 안의 결정 콘솔 등 현황판 주소 링크는 앱 안 새 창, 그 밖의 링크는 기본 브라우저로 연다.
- 현황판 로그: `~/Library/Application Support/Athena Studio/board.log`

## 설정 (`config.json`)
| 키 | 기본 | 뜻 |
|---|---|---|
| `athenaDir` | 없음 | 아테나 폴더 |
| `boardPort` | 4700 | 현황판 포트(`ATHENA_BOARD_PORT` 로 넘긴다) |

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
