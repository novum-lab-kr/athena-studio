# athena-studio
Athena Studio — 아테나(AI 에이전트 개발팀) 데스크톱 앱. 작업 창(herdr) · 현황판을 한 창에

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
| 🖥 작업 창 | ⌘1 | 아테나 폴더에서 `herdr` 실행(xterm.js + node-pty · `TERM=xterm-256color` · `COLORTERM=truecolor`) |
| 📋 현황판 | ⌘2 | `http://localhost:4700` (꺼져 있으면 `scripts/board/server.mjs` 를 띄운다) |

- Ctrl 조합은 모두 herdr 로 간다. 앱 단축키는 ⌘ 만 쓴다(⌘R = 현황판 새로고침).
- 앱을 닫으면 herdr 클라이언트만 끝난다. herdr 서버 · 에이전트 · 현황판은 계속 돈다.
- herdr 가 PATH 에 없으면 로그인 셸과 설치 안내를 띄운다. 설치 뒤 [보기 → 작업 창 다시 시작].
- 현황판 안의 결정 콘솔 등 현황판 주소 링크는 앱 안 새 창, 그 밖의 링크는 기본 브라우저로 연다.
- 현황판 로그: `~/Library/Application Support/Athena Studio/board.log`

## 설정 (`config.json`)
| 키 | 기본 | 뜻 |
|---|---|---|
| `athenaDir` | 없음 | 아테나 폴더 |
| `boardPort` | 4700 | 현황판 포트(`ATHENA_BOARD_PORT` 로 넘긴다) |

## 구조
- `src/main.js` — 창 · 메뉴(단축키) · 작업 창 pty · 현황판 서버 · 폴더 설정
- `src/preload.js` — 화면에 열어 주는 IPC 함수
- `src/renderer/` — 탭 · 터미널 · 현황판 iframe · 처음 켤 때 폴더 고르기
- `src/lib/core.js` — Electron 없이 도는 순수 로직(`npm test`)

## 검사
```sh
npm run check   # 문법
npm test        # 순수 로직
```
화면 확인은 맥에서 한다(서버에서는 Electron 을 띄우지 않는다).

## 단계
① 이 시제품(Electron + 탭 두 개) → ② 아테나 코어의 herdr 호출을 한 곳으로 모으기(아테나 팀) → ③ 앱 자체 터미널 데몬으로 herdr 없이
