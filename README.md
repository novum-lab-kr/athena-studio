# athena-studio
Athena Studio — 아테나(AI 에이전트 개발팀) 데스크톱 앱. 작업 창(자체 터미널 — 탭 · 분할) · 에이전트 모니터를 한 창에. 현황판은 기본 브라우저로 연다.
아테나 코어(`athena/`)를 앱이 들고 와서 스튜디오 집(`~/.athena-studio`)에 풀어 쓴다 — 따로 설치할 것은 없다.

> 이 레포를 고치는 에이전트 · 개발자는 [`AGENTS.md`](AGENTS.md)(개발 규칙 · 함께 고칠 곳 · 함정 · 수동 확인)도 본다.
> `athena/CLAUDE.md` · `athena/AGENTS.md` 는 코어 본체에서 켜는 아테나(팀 리드) 문서라 다르다.

버그 · 기능 제안은 [Issues](https://github.com/novum-lab-kr/athena-studio/issues/new/choose) 양식으로, 보안 문제는 공개 이슈 말고 [비공개 신고](https://github.com/novum-lab-kr/athena-studio/security/advisories/new)로 — [`SECURITY.md`](SECURITY.md).

## 켜기 (맥)
필요한 것: Node · npm · git(코어 번들을 `git subtree` 로 만든다) · `claude` 또는 `codex`(작업 창이 처음에 켜는 에이전트).
```sh
npm install   # node-pty 맥 prebuild 를 쓴다(Xcode 빌드 필요 없음) · 개발용 Athena.app 을 만든다
npm start     # 개발용 Athena.app(.dev-app/ · git 무시)으로 켠다 — 메뉴 막대 · Dock · ⌘Tab 이름이 Athena
```
- `npm install`(postinstall)은 node-pty `spawn-helper` 실행 권한을 고치고(`scripts/fix-spawn-helper.js`), Electron.app 을 `.dev-app/Athena.app` 으로 복제해 이름 · 아이콘을 바꾸고 다시 서명한다(`scripts/dev-app.js` — Electron 버전 · 아이콘이 바뀌면 `npm start` 때 다시 만든다, 못 만들면 Electron 이름 그대로 켠다).
- `npm start` 는 켜기 전에 이 레포 `athena/` 의 **커밋된** 기록으로 코어 번들(`.dev-app/resources/athena-core.bundle`)을 만들고, 화면(`src/renderer`)을 Vite 로 `dist/renderer/`(git 무시)에 빌드한다(`vite.config.mts` · 1초 안쪽 · 손으로는 `npm run build:renderer`). 화면을 고쳤으면 앱을 다시 켠다(따로 지켜보며 다시 빌드하지 않는다). 빌드가 실패하면 이전 빌드로 켜고 경고하고, 이전 빌드도 없으면 켜지 않는다. 배포판은 아래 "배포판 (맥)".
- 처음 켜면 묻지 않고 번들을 스튜디오 집에 풀어 쓴다. 안 됐을 때만 [다시 시도] · [이미 받은 아테나 폴더 고르기…] 가 뜬다.

## 배포판 (맥)
```sh
npm run package:mac                    # arm64 · x64 둘 다 → dist/release/(git 무시)
npm run package:mac -- --arch arm64    # 칩 하나만 · --version X.Y.Z 로 번호를 줄 수 있다
```
- 만드는 것: `Athena-Studio-mac-arm64.dmg` · `-x64.dmg` · 같은 이름 `.zip`(칩마다 따로 · universal 아님). 이름 Athena Studio · 번들 ID `kr.novum-lab.athena-studio` · 최소 macOS 13(Ventura — Electron 44 의 최소)
- `scripts/package-mac.js` 가 화면 빌드(`dist/renderer`) → 코어 번들(`athena/` 의 **커밋된** 기록 → `dist/package/athena-core.bundle` → 앱 `Contents/Resources/athena-core.bundle`) → 제3자 고지(`scripts/third-party-notices.js` 가 `package-lock.json` 의 운영 의존성 · Electron 의 이름 · 버전 · 라이선스 · 패키지 안 LICENSE · NOTICE 원문을 모아(패키지에 라이선스 파일이 없으면 `build/third-party-licenses/<이름>@<버전>.LICENSE` 에 넣어 둔 그 버전 upstream 원문 · 그것도 없고 MIT 면 MIT 표준 문구 + package.json author 로 만든 원문(고지에 "reconstructed from package.json" · 빌드 로그에 목록) · 그 밖은 멈춘다) `dist/package/THIRD_PARTY_NOTICES.txt` → 앱 `Contents/Resources/THIRD_PARTY_NOTICES.txt` · Chromium · Node.js 고지는 electron-builder 가 같은 자리에 두는 `LICENSES.chromium.html` · 배포판 맥 메뉴 [Athena → 제3자 고지] 가 연다) → electron-builder 순으로 돈다. 버전은 git 태그(`git describe` — 태그 커밋이면 `0.13.36`, 뒤 커밋이 있으면 `0.13.36+1`)로 앱 `app.getVersion()` 이 그 번호
- asar 를 쓰지 않는다 — 데몬 · 데몬 CLI(`bin/athena-studio-cli` 셸 스크립트)를 파일 경로로 띄우고 코어가 그 CLI 를 셸로 부른다. 퓨즈: RunAsNode 켬(데몬 · CLI · 현황판 · 코어 명령이 `ELECTRON_RUN_AS_NODE` 로 이 앱의 Electron 을 node 로 쓴다) · NODE_OPTIONS · `--inspect` 끔
- 서명: `CSC_LINK`(.p12) · `CSC_KEY_PASSWORD` 가 있으면 Developer ID, 없으면 이 컴퓨터용(ad-hoc) — ad-hoc 판은 다른 맥에서 Gatekeeper 가 막는다. hardened runtime + `build/entitlements.mac.plist`(JIT · 서명 안 된 실행 메모리 · 라이브러리 검사 끄기). 공증은 `APPLE_API_KEY`(.p8 경로) · `APPLE_API_KEY_ID` · `APPLE_API_ISSUER` 가 모두 있을 때 afterSign 훅 `scripts/notarize-mac.js` 가 한다(.app 공증 · staple — .dmg 는 서명만 · electron-builder 의 공증은 끈다: staple 이 지면 빌드가 멈춰서). 공증은 Accepted 가 아니면 멈추고, staple 은 60초 간격 5번 다시 시도하되 끝내 못 붙여도 멈추지 않고 `dist/release/staple.json` 에 false(미staple)로 남긴다 `--require-signing` 이면 다섯 값 중 하나라도 비었을 때 만들지 않는다
- 서명 · 공증판은 GitHub Actions `release-mac`(`.github/workflows/release-mac.yml` · 손으로 돌린다 · 버전 칸을 비우면 git 태그)이 만든다 — Secrets `CSC_LINK` · `CSC_KEY_PASSWORD` · `APPLE_API_KEY_P8`(.p8 내용 — 러너 임시 파일로 써서 `APPLE_API_KEY`) · `APPLE_API_KEY_ID` · `APPLE_API_ISSUER`. 두 칩을 Apple Silicon 러너 하나에서 만들고 .dmg 를 `notarytool` 로 공증(Accepted 아니면 멈춤) · staple(같은 다시 시도 · 못 붙여도 계속) 한 뒤 `codesign --verify --deep --strict` · 팀 `AQUDD2QFNC`(틀리면 멈춤) · `spctl -a -vv`(source=Notarized Developer ID — staple 이 없으면 CloudKit 에 묻다 끊길 수 있어 경고만) · `staple.json`(미staple 이면 경고)을 로그에 남긴다. 러너 → Apple CloudKit 연결이 자주 끊겨(Error 68 · NSURLError -1005) 공증은 됐는데 staple 만 지는 일이 잦아서다. 결과 .dmg · .zip · `staple.json` 은 그 실행의 artifact(14일)
- 공개 자리: 입력 `release`(기본 켬)면 확인 뒤 `latest.json`(`{ version, date, minMacOS, files: [{ arch, name, size, sha256 }] }` — .dmg 기준)과 Release 본문 `release-notes.md`(= `CHANGELOG.md` 의 그 minor 절) · 앱 안 업데이트 피드 `latest-mac.yml`(.zip 두 개의 이름 · 크기 · sha512 — JSON 꼴)도 만들어 같은 artifact 에 넣는다. 버전이 태그 번호(X.Y.Z)가 아니거나 CHANGELOG 에 그 minor 절(`## X.Y (…)` — 문서 머지로 끝자리가 올라도 같은 절 · 패치 번호는 맞추지 않는다 · 괄호 범위는 `v0.15.0 –` 처럼 열어 둬도 된다)이 없으면 만들기 전에 멈춘다 — 배포판을 내기 전에 그 절부터 쓴다(시험 실행은 `release` 를 끈다). 올리기는 로컬에서 `node scripts/publish-release.js --run <실행 id> [--dry-run]` — 내 `gh` 로그인으로 그 artifact 를 받아 이름 · 크기 · sha256(.dmg) · sha512(.zip — `latest-mac.yml`)을 다시 맞추고, .dmg 를 이 맥에서 staple(이미 붙어 있으면 그대로 · 티켓만 받으니 자격 증명은 필요 없다) · `stapler validate` · `spctl`(Notarized Developer ID)로 확인한다. staple 로 파일이 바뀌면 `latest.json` 의 size · sha256 을 다시 쓰고, .zip 안 .app 이 미staple 이면 그대로 올리며 알린다. 그다음 공개 레포 `novum-lab-kr/athena-studio-releases` 에 Release `vX.Y.Z`(초안으로 파일 6개를 다 올린 뒤 공개 · latest · 본문 = release-notes.md)를 만들고 고정 주소 `releases/latest/download/<파일>` · `latest.json` · `latest-mac.yml` 버전을 확인한다(홈페이지와 배포판 ⚙ 업데이트가 그 주소 · 최신 Release 를 읽는다). 같은 태그 · Release · 초안이 이미 있으면 덮지 않고 멈춘다(토큰 Secret 은 두지 않는다). 파일 만들기는 `scripts/release-files.js`(`check` · `notes` · `manifest` · `updater`)
- 배포판 ⚙ 앱 업데이트(`src/lib/release-update.mts` · electron-updater) — 앱 안 `Contents/Resources/app-update.yml`(`package-mac.js` 가 만든다 · generic · 피드 `https://github.com/novum-lab-kr/athena-studio-releases/releases/latest/download`)로 켤 때 · 30분마다 · 팝업을 열 때 `latest-mac.yml` 만 읽고, 새 버전이면 `현재 → 새` · [업데이트] · ⚙ 점. 누를 때만 그 칩의 .zip(애플 실리콘 → `-arm64.zip` · 인텔 → `-x64.zip`)을 받아 sha512 를 맞추고, Squirrel.Mac 이 받은 앱의 서명을 지금 앱의 designated requirement(번들 ID `kr.novum-lab.athena-studio` · Team ID `AQUDD2QFNC`)로 검사한 뒤에만 앱을 끄고 바꿔 다시 켠다(자동 받기 · 끌 때 설치 · 차등 받기 끔). 못 하면 앱은 그대로 · 회색 한 줄(확인 · 받기 · 체크섬 · 설치) · 기록은 앱 데이터 `app-update.log`. 다시 켜지면 코어 번들 맞추기는 그대로(아래 "코어 업데이트"). ad-hoc 판(로컬 `package:mac`)은 DR 이 cdhash 라 어떤 새 판도 설치를 거절한다. v0.15.8 은 업데이트 기능 전 판이라 한 번은 .dmg 로 받아야 한다
- 손님 맥에 필요한 것(코드 근거):
  - `git` — 처음 켤 때 코어 번들을 `git clone` 으로 푼다(`src/lib/studio-home.js` `installCore`). 없으면 맥이 Xcode Command Line Tools 설치를 띄운다
  - `python3` — 코어 훅(`athena/.claude/settings.json`) · 화면 계층(`athena/scripts/lib/screen.py`). Command Line Tools 에 들어 있다
  - `claude` 또는 `codex` — 작업 창이 처음 켜는 에이전트(`src/lib/core.mts` `availableAgents` · 없으면 켜지 않는다)
  - `node` — 코어 스크립트(`athena/bin/athena` · `delegate.sh` · `scripts/*.mjs`)가 PATH 의 node 를 부른다. 앱이 직접 부르는 팩 명령 · 현황판은 node 가 없으면 앱의 Electron 으로 돈다
  - (선택) `gh` — PR 올리기(`ship.sh`)

## 스튜디오 집과 데이터
```
~/.athena-studio/core          주 본체(번들에서 clone 한 git 저장소)
~/.athena-studio/bodies/<id>   팩 본체(팩마다 하나 — 코어가 만든다)
~/.athena-studio/data          데이터 폴더(팩 데이터 packs/<id>/ — 계획서 · 이슈 · 보관함 · 레지스트리 config.json — portBase 4800)
~/.athena-studio/daemon.json   데몬 접속 파일(개발 앱은 daemon-dev.json)
```
회사 레포 클론은 홈 아래(`reposRoot`)에 둔다 — 스튜디오 집 밖이다.

| | 개발 앱(`npm start`) | 배포판(`npm run package:mac`) |
|---|---|---|
| 앱 데이터(설정 `config.json` · 데몬 소켓 · 로그) | `~/Library/Application Support/Athena Studio Dev/` | `~/Library/Application Support/Athena Studio/` |
| 데몬 접속 파일 | `~/.athena-studio/daemon-dev.json` | `~/.athena-studio/daemon.json` |
| 번들 ID | `kr.novum-lab.athena-studio.dev` | `kr.novum-lab.athena-studio` |

스튜디오 집의 코어 · 본체 · 데이터는 개발 앱과 배포판이 **같이 쓴다**.

**코어 업데이트** — 다시 켤 때 들고 온 번들이 주 본체보다 앞이면 업데이트한다(뒤 · 갈라짐이면 건드리지 않는다). 팩 본체는 코어 `update --from <번들> --backup-dirty` 로(고친 코어 파일은 `data/backups/core-edits/` 에 사본), 팩이 없는 주 본체는 앱이 앞으로 감는다. **일하는 세션이 있어도 바로 올린다**(코어가 `update-busy` 를 알 때부터 · 2026-10-26) — 아테나 · 에이전트 · Codex 가 일하는 중이어도 그 본체를 올리고, 학습 검토 · QA 는 끄고 올린다(학습 검토는 일이 남았으면 새 코드로 다시 뜬다). 도는 `commit.sh` · `ship.sh` · 무거운 명령은 최대 60초 기다린 뒤 올리고, 그래도 돌거나 그 팩 작업(열기 · 바꾸기) 중이면 그 본체는 건너뛴다. 업데이트 전에 앱이 떠 있는 데몬의 pane 상태를 앱 데이터 `panes-state.json` 에 적어 `--panes-state` 로 넘기면(코어가 `idle-panes` 를 알 때만) 입력칸에서 기다리는 pane 의 세션은 "일하는 중이던 세션" 에서 뺀다. 업데이트 경로(`version` · `update`)는 약속 번호를 싣지 않는다 — 약속이 오른 앱도 옛 코어를 올린다. 건너뜀(막은 것) · 일하는 중이던 세션 N개 — 바로 올림(pane 이름) · 백업 · 실패는 첫 창 위에 한 번 알리고 기록은 앱 데이터 `pack.log`. 팩 데이터(`data/packs/` — 계획서 · 이슈 · 보관함)는 업데이트가 건드리지 않는다(업데이트 기록 · 레지스트리 · 백업만 `data/` 에 쓴다).

## 화면
| 탭 | 단축키 | 하는 일 |
|---|---|---|
| 🖥 작업 창 | ⌘1 | 왼쪽 작업 공간(레포마다 하나 · 브랜치 · 그 안 에이전트와 상태) · 가운데 탭 · 분할 터미널(xterm.js) · 오른쪽 Explorer. 처음엔 `athena` 작업 공간(본체 폴더)에서 에이전트를 켠다 — `claude` 가 있으면 claude, 없으면 `codex` |
| ☰ 작업 | — | 탭 줄 **[작업 N · ●M]** — 팝업에 **나를 기다리는 것**(에이전트가 남긴 질문 · 결정 요청 — `athena/docs/requests.md`) · **진행 중**(계획서 한 줄씩: 답 대기 · 막힘 · 작업 중 · 대기) · **최근 완료**(24시간 · 완료로 바뀐 시각 기준 — 현황판 사건 기록, 없으면 계획서를 마지막으로 고친 시각). 작업을 누르면 상세(왜 · 정한 것 · 진행 · 검증 · 결과 · 다음 · [계획서 열기] · [결정 콘솔] · [pane 으로 가기]), 질문을 누르면 **앱 안에서 바로 답한다** — 답은 그 pane 에 `[요청 <id>] …` 한 줄로 들어가고 에이전트가 받으면(ack) 목록에서 빠진다(pane 이 없으면 저장만 · [다시 보내기]). 결정은 결정 콘솔로. 요청 수는 요청 폴더를 보다가 바로(현황판이 꺼져 있어도) · 목록은 열 때 현황판을 띄워 읽는다. 새 요청은 맥 알림 한 번 · 메뉴 막대 "확인 필요" 는 요청만 센다 |
| 📋 현황판 | ⌘2 | 탭 줄 아이콘은 **메뉴** — 이슈 · QA · 학습 · 지표 · 아카이브를 고르면 그 페이지를 **기본 브라우저로 연다**(⌘2 · 트레이 [현황판 열기]는 첫 화면 — 해결할 이슈 목록(학습 후보 제외 · 진행 중이면 맡은 pane) · [작업 시작] · 앱 안에는 띄우지 않는다 · 팩을 고르기 전에는 열지 않는다). 현황판 서버는 화면을 안 열어도 PR 머지 자동 완료 · 끝난 일 자동 보관(머지돼 완료 + 배우기 검토 끝 + 묶인 에이전트 pane 이 모두 닫히면 `archive/` 로 · 팩 레포 로컬 커밋) · 학습 대기열 · [작업] 목록 · pane [상세] 를 맡는다. 포트는 본체가 정한다(주 본체 4800 · 팩 본체 4802부터 2씩) — 떠 있는 현황판이 이 팩 것이면 같이 쓰고, 다른 팩 것이면 다시 띄운다. 옛 본체(팩 미지원)면 저장된 포트(기본 4701)부터 20개를 보고 — 이 본체의 현황판이면 같이 쓰고, 비었으면 띄우고, 남의 것이면 다음 번호 |
| 🗺 다이어그램 | — | 탭 줄 아이콘(현황판 옆) — 본체의 `docs/diagrams/index.html`(`/guide 그림` 과 같은 목록)을 기본 앱으로 연다 · 없으면 알림만 · 팩을 고르기 전에는 꺼져 있다 |
| ⚙ 설정 | — | 탭 줄 맨 오른쪽(브라우저 옆) — 팝업 "PR 자동 머지" 묶음에 이 창 팩의 레포마다 레포 이름 줄 스위치(자동 머지 — `pack.json` `"autoMerge"`)와 그 아래 들여쓴 **머지 전에 확인 받기**(`"autoMergeConfirm"` — 자동 머지가 꺼져 있으면 숨김) 스위치. 작업 base 가 운영 브랜치와 같은 레포에서 확인을 끄면 "<prBase> 에 바로 반영돼요" 회색 한 줄. main 직접 레포는 목록에 없다. 저장은 코어 `bin/athena pack set-auto-merge` 가 그 두 키만 고치고, 현황판 · 처리기는 다음 확인 때 새 값을 읽는다(`athena/docs/pr-auto.md` "켜기") · 팩을 고르기 전에는 꺼져 있다. 맨 아래 **앱 업데이트** 줄(개발 앱 체크아웃 — 아래 · 배포판은 위 "배포판 (맥)") — 지금 버전(아래 "버전")을 늘 보이고, 켤 때 · 30분마다 · 팝업을 열 때 `origin main` 을 받아 보고, 뒤처졌을 때만 [업데이트] 가 켜지고 ⚙ 에 점. 누르면 main 을 빨리 감기로만 받고 앱을 끈 뒤 `scripts/dev-app.js restart` 가 다시 켠다(`package.json` · lockfile 이 바뀌었으면 그 전에 `npm install` — 코어 `heavy.sh` 줄 서기 · 기록은 앱 데이터 `app-update.log` · 실패하면 다음 켤 때 알림). 다시 켜면 코어 번들 · 화면 빌드 · 본체 업데이트가 돈다(pane 은 그대로 · 화면 빌드가 실패하면 이전 빌드로 켜고 알림). main 이 아님 · 커밋하지 않은 추적 파일 · 로컬 커밋(빨리 감기 불가) · origin 에서 못 받음이면 진행하지 않고 회색 한 줄로 까닭. 뒤처졌을 때 origin 쪽에 더 높은 버전 태그가 있으면 `0.2.1 → 0.3.0`, 아직 없으면 커밋 수 |

- **작업 창 단축키** — ⌘T 새 탭 · ⌘⇧T 새 작업 공간 · ⌘D / ⌘⇧D 오른쪽 · 아래로 나누기(경계를 끌어 크기 · 더블클릭 반반 — 끄는 동안 · 창 크기를 바꾸는 동안 · 모니터를 접고 펴는 동안에도 터미널 내용이 새 크기에 맞게 다시 그려진다 — 안 프로그램이 새 크기로 다 그릴 때까지는 앞 화면을 그대로 보여 줘 반쪽 화면이 깜빡이지 않는다. 화면이 찬 pane(셸 · Claude Code · 전체 화면 프로그램)은 글을 pane 아래에 붙여 두어 위아래로 바꿀 때 아래쪽 줄이 한 줄씩 되튀지 않는다 — 칸 높이로 나누고 남는 몇 px 는 위에) · ⌘W pane 닫기 · ⌘⌥W 탭 닫기(에이전트가 돌면 묻는다) · ⌘⌥방향키 옆 pane · ⌘⇧[ ] 이전 · 다음 탭 · ⌘⇧↑ ↓ 이전 · 다음 작업 공간 · ⌘B 왼쪽 접기 · ⌘⌥B 오른쪽 Explorer 접기 · ⌘⇧B 옆 브라우저 · ⌘⇧W 창 닫기. pane 을 우클릭하면 그 pane 을 오른쪽 · 아래로 나누기 · 닫기 메뉴가 뜬다(맥의 우클릭 단어 선택은 그대로). Ctrl 조합은 모두 pane 안으로 간다(앱 단축키는 ⌘ 만). ⇧Enter 는 pane 안에 줄바꿈 신호(ESC CR — ⌥Enter 와 같다)를 보낸다 — Claude Code 입력창에서 전송 대신 줄바꿈. ⌘⌫ 는 커서 앞 줄을 지운다(Ctrl+U). ⌘← · ⌘→ 는 줄 처음 · 끝으로 간다(Ctrl+A · Ctrl+E).
- **레포 이름 · 이미지** — 왼쪽 작업 공간에서 레포를 우클릭 → 이름 · 이미지 바꾸기(팩 이름 · 이미지와 같은 대화상자) · 원래 이름으로 · 이미지 지우기. 팩 안(`pack.json` 레포 항목 `displayName` · `icon` · `assets/repos/`)에 저장돼 팀과 같이 쓰고 내보내기 · 백업에 같이 실린다. 왼쪽 사이드바에만 보이고(접은 아이콘 · 펼친 레포 줄 · 아직 안 연 레포 줄 — 펼친 줄은 이름 앞 작은 칸에 이미지 · 이미지가 없으면 접힌 칸과 같은 두 글자 배지 · 누르면 접고 편다) 레포 이름 · 경로 · 브랜치는 그대로다. 아테나 작업 공간은 늘 아테나 로고이고 바꿀 수 없다(팩에 같은 이름 레포가 있어도).
- **pane [상세]** — 계획서에 묶인 pane(그 계획서를 하는 에이전트 pane · 일을 맡긴 아테나 pane)과 아테나 pane(본체 폴더에서 도는 claude — 맡긴 일이 없어도 늘) 머리 줄 오른쪽 아이콘. 누르면 작업 창 위에 오른쪽에서 팝업이 나온다(레이아웃에 끼지 않아 pane · 터미널 크기는 그대로 · 아이콘을 다시 누르거나 × · Esc · 바깥을 누르면 닫힘 · 열려 있는 동안 3초마다 갱신). 에이전트 pane: 맨 위에 사람 몫 — 내가 할 일(열린 요청 · 고르기 질문) · 막힘(계획서 Blocked), 그 아래 한눈 요약(작업 중 · 쉬는 중 · 멈춤과 그 까닭 · 몇 분째 · 시작 · 지금 하는 일 — 화면의 마지막 말 · 다음 할 일 첫 줄 · PR 링크). 그 아래 찾은 것 · 결과(마지막 보고) · PR · 자동 리뷰 · 계획서(요청 · 진행 · 다음 · 검증)를 펼쳐 둔다. 긴 글은 몇 줄만 보이고 [더 보기](요약의 지금 하는 일 · 다음은 두 줄까지 · 결과 6줄 · 요청 3줄 · 진행 5줄 · 검증 4줄). [더 보기] 는 3초 갱신에도 그대로고 닫으면 처음으로. 아테나 pane: 맡긴 일 — 계획서마다 한 줄(나를 기다림 · 지금 · 오늘 끝남 — 보관한 것 포함 · 없으면 빈 목록 안내), 누르면 그 에이전트 pane 상세로 — 그 상세 머리의 [← 맡긴 일] 로 목록에 돌아온다(스크롤 위치 그대로 · pane 아이콘으로 바로 연 상세에는 없음). 토큰 — 요약 첫 줄에 입력+출력을 크게, 캐시(만들기+읽기)는 옆에 작게(예 `토큰 42k (캐시 3.1M)` · 숫자에 마우스를 올리면 정확한 값): 에이전트 pane 은 그 계획서에 묶인 대화 기록 전부(첫 지시가 `이 작업의 계획서: …` · `리뷰할 계획서: …` 인 세션 — 코어 `learn-review.mjs` 와 같은 규칙), 아테나 pane 은 그 pane 의 지금 대화 하나(`<팩 데이터>/state/pane-sessions/<pane>.json` · 맡긴 일 토큰은 더하지 않는다). 같은 답(`message.id`)이 여러 줄로 적혀도 한 번만 세고, 기록을 못 찾으면 줄을 숨긴다. 파일마다 읽은 자리를 기억해 늘어난 부분만 읽는다(`src/lib/token-usage.mts`). 재료는 현황판 카드 · 계획서 · pane 화면 글 · 대화 기록 파일뿐이다(모델을 부르지 않는다). 맡긴 아테나 pane 은 계획서 `- Lead pane:`(delegate.sh 가 적는다) · 정식 결정 콘솔 `leadPane`
- **에이전트 pane 자리** — 아테나가 레포 작업 공간에 에이전트를 띄우면(`delegate.sh`) 그 탭에서 가장 큰 pane 을 긴 쪽으로 반 나눈다 — 글자 칸은 세로가 가로의 약 2배라 가로 칸 수가 세로 줄 수의 2배 이상이면 오른쪽, 아니면 아래로(2개면 좌우 · 4개면 2×2). `--down` 을 주면 아래로 · 데몬이 pane 크기를 알려 주지 않으면(옛 데몬) 탭의 첫 pane 을 오른쪽으로.
- **pane 이름** — 머리 줄(이름 줄)은 포커스와 상관없이 늘 바탕이 깔리고, 포커스된 pane 은 테두리 · 밝은 글자 · 왼쪽 강조 막대로 구분한다. 에이전트 pane 은 `🤖 <에이전트> · <브랜치>`. 아테나 pane 은 그 pane 에서 계획서를 새로 만들면(경량 계획서 · 정식 계획서의 결정 콘솔을 처음 만들 때) `🧭 아테나 · <계획서 제목 앞 30자>` 로 바뀐다. 에이전트 pane · 화면 밖 · 현황판이 이슈를 넘기며 만드는 계획서는 이름을 바꾸지 않는다(`athena/docs/extending.md` "화면 계층").
- **🛰 에이전트 모니터**(가운데 맨 아래 · 모든 작업 공간) — Claude 기록(`~/.claude/projects` 의 JSONL — 서브에이전트 · 워크트리 세션 · 에이전트 pane 폴더 세션, 최근 120분)을 따라 읽어 세션 칩과 시각 · 도구 · 요약 피드를 보여 준다. 칩은 지금 작업 중인 에이전트(끝나지 않았고 2분 안에 움직임)만 — 조용해지면 빠지고(30초마다 다시 그림) 다시 움직이면 다시 뜬다. 칩을 누르면 그 세션만 보고, 고른 세션이 조용해지면 전체 로그로 돌아간다. ⌄ 로 접기. 팩 레포에 GitHub 이슈 감시(`"githubIssues": true` — 코어 `athena/docs/github-issues.md`)를 켜 두면, 현황판이 새 이슈를 가져와 아테나에 맡길 때마다 `[GitHub] 📥 GitHub issue #N · <제목> — imported · Athena on it` 한 줄이 함께 뜬다(그 창 현황판의 `/api/github-issues` 를 보는 동안 15초마다 · 120분 안 · 한 번씩).
- **Explorer** — [파일] 트리(Material Icon Theme 아이콘 · 바뀐 파일 M·U·A·D·R) / [변경] git 목록. 누르면 터미널 옆 뷰어(Shiki Dark+ · 줄 번호 · 바뀐 파일은 diff · 이미지는 그림 · Esc 닫기). 작업 공간 폴더 안만 읽는다. 작업 공간 폴더가 없으면(그 폴더였던 워크트리를 지웠다 등) 그 작업 공간에서 살아 있는 pane 의 폴더(포커스된 pane 먼저)를 대신 보고, 그것도 없으면 "폴더가 없어요". 아테나가 새로 만드는 레포 작업 공간의 폴더는 레포 메인 체크아웃이다(에이전트 pane 은 그 작업의 워크트리에서 돈다).
- **🌐 옆 브라우저**(⌘⇧B) — 오른쪽 서랍(너비를 끌어 바꾸고 기억함). 계획서 · 결정 콘솔 · 테스트 화면용. 로그인 쿠키는 앱 전용 저장소(`persist:studio-browser`) · 샌드박스 · http(s) 만. 터미널 링크는 localhost 면 여기 · 그 밖은 기본 브라우저.
- **칸 크기** — 왼쪽 작업 공간 · 오른쪽 Explorer 의 너비와 아래 에이전트 모니터의 높이는 칸 경계를 끌어서 바꾼다(옆 브라우저 너비와 같은 손잡이 · 더블클릭하면 기본 크기 · 바꾼 크기는 기억해 다시 켜도 그대로). 기본 · 최소 · 최대 — 왼쪽 224 · 160 · 480px / 오른쪽 248 · 180 · 560px / 모니터 170 · 80 · 560px. 창을 줄이면 가운데 pane 칸이 너비 320px · 높이 200px 은 남도록 줄이고(최소 아래로는 안 줄인다), 줄어든 크기는 저장하지 않아 창을 다시 키우면 기억한 크기로 돌아온다. 접은 칸에는 손잡이가 없다.
- **메뉴 막대 아이콘**(맥) — 확인 필요(열린 요청)나 막힌 계획서(Status blocked)가 있으면 로고에 빨간 점. 누르면 패널: 머리줄(연결 상태 · 알림 일시 중지 🔕 · ☰ 메뉴) · 확인 필요(열린 요청 · 지난 7일 평균 답 대기 — 현황판 지표, 꺼져 있으면 숨김) · 작업 공간별 에이전트(입력 대기 · 작업 중 · 대기 — 누르면 그 pane) · 사용량(창마다 막대 + % · 리셋) · 칸반 숫자 · 완료 24h 숫자. **앞에 있는 팩 창** 기준이다. 맥 알림은 사람이 고르거나 답할 것만: 새 요청(질문 · 결정) · pane 의 입력 대기(켤 때 있던 상태 · 보고 있는 pane 은 빼고 · 같은 종류는 묶는다 · 🔕 동안은 안 띄운다 · 누르면 그 요청 · pane). 응답이 끝남 · 리뷰 · 완료는 알리지 않는다(패널 · 칸반 숫자로 본다). **입력 대기**는 에이전트(Claude · Codex)가 권한 질문 · 고르기 창 · 폴더 신뢰처럼 사람이 골라야 이어지는 화면에서 멈춘 것 — 메뉴 막대가 4초마다 에이전트 pane 의 화면 맨 아래(맺음 줄 `Esc to cancel` · `Enter to select` · `Press enter to confirm or esc to cancel` 등과 고르는 줄 `❯` · `›`)를 읽어 알아낸다(`src/lib/screen-model.js` `waitingForInput`). 두 번 잇달아(3초 이상) 보여야 알리고, 풀릴 때까지 다시 알리지 않는다. 에이전트 화면 문구가 바뀌면 못 알아낼 수 있다.
- 맥은 창을 닫아도 메뉴 막대에 남는다 — 끄기는 [Athena 종료] · ⌘Q. 앱을 닫아도 데몬 · 셸 · 에이전트 · 현황판은 계속 돌고, 다시 켜면 같은 탭 · 배치로 다시 붙는다.
- **PR 자동 리뷰 · 수정 · 머지** — 설명은 [`athena/docs/pr-auto.md`](athena/docs/pr-auto.md) 를 본다.

## 팩
팩 = 회사 하나의 레포 묶음 · 에이전트 · 라우팅. 팩마다 본체(`bodies/<id>`)가 따로 있다. 탭 줄 왼쪽 `▣ <팩> ▾`(⌘⇧P · [파일 → 팩…])에서 고르고 · 만들고 · 가져오고(압축 파일 · 팩 폴더 · git 레포 · 기존 아테나) · 내보낸다(담을 것을 묻는다 — 팩 + 내 작업 기록 · 팩만). 일은 모두 본체 명령 `node scripts/athena.mjs pack … --json` 이 하고 앱은 부르고 · 기다리고 · 화면을 정리한다. 본체가 여러 팩을 지원하지 않으면 이 메뉴는 숨는다.
- **바꾸기** — 다른 팩을 누르면 지금 창이 그 팩 본체로 다시 붙는다(작업 공간 · 현황판 · 옆 브라우저 · 모니터). **이전 팩의 pane · 에이전트는 닫지 않는다** — 데몬에서 계속 돌고, 돌아오면 보던 자리 그대로. 다른 창이 이미 보는 팩이면 그 창으로 간다.
- **백업에서 되살리기** — [내보내기 → 팩 + 내 작업 기록]은 이 창의 에이전트 대화 · 워크트리(미커밋 변경 · push 안 한 커밋)도 담는다. 가져오기 끝에 [열고 작업 되살리기] → 워크트리를 만들고 에이전트 pane 을 그 대화로(`delegate.sh --resume`), 아테나 pane 은 `claude --resume` 으로 다시 연다(코어 `pack restore-work` · 계획서 `docs/plans/20261022-pack-full-restore.md`).
- **새 창으로 열기** — 팩 우클릭. 우클릭 메뉴에는 이름 바꾸기 · 원래 이름으로 · 이미지 고르기 · 지우기 · **팩 삭제**(어느 창도 보고 있지 않은 팩만 — 먼저 팩 + 작업 기록을 자동 백업하고 [가져오기]로 되살린다 · 워크트리가 남아 있으면 목록을 보여 주고 한 번 더 묻는다 · 레포 폴더는 그대로)도 있다(아이콘 더블클릭 → 이름 · 이미지 대화상자). 지금 팩이면 내보내기도(코어 명령이 지금 팩만 다룬다). 열린 창 목록은 앱 `config.json` 에 기억한다.
- **시작 화면** — 켤 때 도는 에이전트가 없으면 작업 창 가운데에 밤하늘 시작 화면([새 팩 만들기] · [팩 가져오기] · "내 팩" 최근 5개). 여러 창을 되살릴 때는 첫 창에만.
- 데몬이 옛 버전(protocol 4 이하)이면 바꾸기 · 새 창 · 새 팩을 막고 [작업 창 데몬 다시 띄우기] 를 안내한다.
- 팩 본체 코어가 앱보다 옛 버전이라 명령을 모르면(사용법만 찍어 "알 수 없는 답") 앱이 그 본체 `version` 의 약속 번호 · `capabilities` 를 보고 "이 팩 본체 코어가 옛 버전이라 아직 안 돼요" 로 알린다(`src/lib/pack.mts` `coreTooOld` · 오류 코드 `core-old`). 앱을 다시 켜면 코어 업데이트가 그 본체를 올린다.

## 버전
SemVer 0.x — 정본은 git 태그 `vX.Y.Z` 하나다(`package.json` `version` 은 태그가 없을 때의 시작값 0.1.0 · 올리지 않는다). main 에 머지되면(사람이 GitHub 에서 머지해도 · 자동 머지 흐름이 머지해도) 워크플로 `.github/workflows/release.yml` 이 `scripts/release-version.js` 로 그 커밋에 다음 태그를 달고 GitHub Release(PR 제목 · 링크)를 만든다 — 그 커밋의 PR 제목 타입이 `feat` 이거나 `!` 가 붙으면 가운데(0.Y+1.0), 그 밖은 끝자리(0.Y.Z+1), 기준은 가장 높은 `v*` 태그. main 에 파일을 고치는 커밋은 만들지 않고, 이미 태그가 있는 커밋은 건너뛴다. 실행마다 기준 태그 뒤 아직 태그 없는 main 커밋을 오래된 순으로 모두 채우므로 머지가 몰려 실행이 취소돼도 빠지지 않는다(계산은 `src/lib/version.js` · 미리 보기 `node scripts/release-version.js --sha <커밋> --dry-run`). 앱은 `git describe` 로 읽는다 — 태그 커밋이면 `0.2.1`, 그 뒤 커밋이 3개 더 있으면 `0.2.1+3`, 태그가 없으면 `package.json` 값. 배포판은 만들 때 정한 태그 번호(`app.getVersion()` — 위 "배포판 (맥)"). `npm start` 가 켤 때 origin 의 `v*` 태그를 먼저 받고(못 받으면 있는 태그로) 정한 번호 하나를 ⚙ 앱 업데이트 줄 · 맥 메뉴 [Athena 정보] · 코어 번들에 같이 쓴다 — ⚙ 확인이 나중에 태그를 더 받아도 지금 번호는 다시 켤 때까지 그대로(새 번호는 `현재 → 새` 로만). 코어는 번들의 버전 ref 로 읽는다(코어 `version --json` 의 `version` — `athena/docs/pack.md` "코어 업데이트 · 되돌리기 · 버전"). 약속 번호(`CONTRACT`) · 데몬 `PROTOCOL` 과는 따로다.

## 문제가 생기면
| 메뉴 | 하는 일 |
|---|---|
| [보기 → 작업 창 다시 붙기] | 데몬 연결만 다시 — pane 은 그대로 |
| [보기 → 작업 창 데몬 다시 띄우기(pane 모두 닫힘)…] | 데몬을 끄고 새로 — **열린 pane · 에이전트가 모두 닫힌다**(데몬 코드를 고쳤을 때) |
| [보기 → 스튜디오 초기화(모든 팩 · pane 삭제)…] | 확인 뒤 현황판 · 데몬을 끄고 스튜디오 집의 코어 · 본체 · 팩 데이터 · 이 앱 데몬 파일을 지운 뒤 다시 켠다. 회사 레포 클론 · 언어 설정 · 다른 앱(개발 앱 ↔ 배포판) 접속 파일은 둔다 — **팩 데이터는 두 앱이 같이 쓰므로 둘 다에서 지워진다** |
| [파일 → 아테나 본체 폴더 바꾸기…] | 개발용 — 스튜디오 집 밖의 본체를 직접 연다 |

로그는 앱 데이터 아래 `daemon.log` · `board.log` · `pack.log`.

## 설정 (앱 데이터 `config.json`)
| 키 | 뜻 |
|---|---|
| `athenaDir` · `windows` | 열린 팩 창의 본체 폴더(처음 켜면 `~/.athena-studio/core`) |
| `boardPort` | 옛 본체에서만 — 현황판 포트를 고르기 시작하는 번호(기본 4701 · 고른 포트를 다시 적는다). 팩 지원 본체는 본체가 정한 포트를 쓴다 |
| `language` | 화면 언어 `ko` · `en` · `ja` · `zh`([보기 → 언어]). 없으면 시스템 언어, 네 언어 밖이면 영어. 에이전트 답 언어도 따라간다 — 창이 본체를 열 때 · 언어를 바꿀 때 본체 `.claude/settings.local.json` 의 `language`(`korean` 등)에 적고, 코어 훅 `scripts/hooks/language.py` 가 메시지마다 다시 읽어 아테나 · 위임 에이전트 · Codex 에 넣는다(켜 둔 세션도 다음 메시지부터). 답뿐 아니라 계획서 · 이슈 · 커밋 메시지 · 주석도 그 언어로 |

예전 키 `homeAthenaAsked` · `studioAthenaAsked` 는 읽으면서 버린다. 칸 접힘 · 모니터 접힘 · 칸 너비 · 모니터 높이 · 브라우저 너비 같은 화면 기억은 이 파일이 아니라 화면 쪽 저장소(localStorage)에 있다.

## 구조
| 자리 | 하는 일 |
|---|---|
| `athena/` | 스튜디오 코어(정본) — 앱이 들고 갈 코어 번들의 출처. 본체로 직접 쓰지 않는다 |
| `src/main.mts` | Electron main(진입점 · ES 모듈) — 창(팩마다) · 메뉴 · 데몬 중계 · 현황판 서버 · 팩 명령 · 옆 브라우저 · 트레이 · 에이전트 모니터 |
| `src/main/` | main.mts 에서 나눈 기능 묶음(`.mts` — 쓰는 것은 인자로 받는다) — `monitor-logs.mts`(에이전트 모니터 기록 읽기) · `files.mts`(Explorer · 파일 뷰어 도우미) · `board.mts`(현황판 띄우기 · 확인 · 끄기 · 읽기) · `core-runner.mts`(스튜디오 코어 준비 · 코어 · 팩 명령 실행) · `app-updater.mts`(⚙ 앱 업데이트) · `tray.mts`(메뉴 막대 아이콘 · 패널 · 맥 알림) · 팩 창 묶음(`installX(ctx, …)` 로 창 문맥에 붙는다) `explorer-panel.mts`(오른쪽 Explorer) · `athena-agent.mts`(아테나 에이전트 · 백업에서 되살리기) · `pack-repos.mts`(팩 레포 · 자동 머지 설정 · 레포 에이전트 부르기) · `work.mts`(현황판 · 사람에게 묻는 요청 · [작업] 팝업) · `daemon-link.mts`(데몬 연결) · `workspaces.mts`(pane · 탭 · 작업 공간 · 팩 레포 더하기 · 빼기 · 우클릭 메뉴) · `agent-monitor.mts`(에이전트 모니터) · `pane-watch.mts`(pane [상세] · pane 목록 갱신) · `catch-up.mts`(팩 본체 따라잡기) · `athena-dir.mts`(아테나 폴더 · 팩 바꾸기) · `packs.mts`(회사 팩 · 팩 표시 이름 · 이미지 · 우클릭 메뉴) · `side-browser.mts`(옆 브라우저) · `pack-window.mts`(창) |
| `src/preload.js` · `src/preload-tray.js` | 창 · 트레이 패널에 열어 주는 IPC 함수(따로) |
| `src/renderer/` · `vite.config.mts` | 작업 창(`index.html` · 진입점 `entry.ts` · 시작 `main.ts`(init · 아테나 폴더 · 언어 바꾸기) · 거기서 나눈 `core.ts`(공용 · 문구) · `terminal.ts`(pane 터미널) · `screen.ts`(데몬 붙기 · 작업 창 명령) · `tabs.ts`(탭 줄) · `pane-layout.ts`(pane 배치 · 크기 · 모니터 칸) · `dividers.ts`(경계 끌기) · `edge-resize.ts`(양옆 칸 너비 · 모니터 높이 끌기) · `pack-dialogs.ts`(팩 대화상자 · 진행 표시 · 이름 · 이미지) · `pack-switch.ts`(팩 줄 · 팩 메뉴 · 시작 화면 · 팩 바꾸기) · `pack-transfer.ts`(팩 만들기 · 가져오기 · 내보내기) · `browser.ts`(옆 브라우저 서랍) · `work.ts`([작업] · 현황판 메뉴 · ⚙ 설정 팝업) · `detail.ts`(pane [상세] · 요청 답하기) · `tips.ts`(툴팁) · `space-actions.ts`(왼쪽 작업 공간 목록 · 레포 메뉴 · 에이전트 부르기) · `side-panels.ts`(양옆 칸 접기 · 미리보기) · preload 타입 `studio-api.d.ts` · `style.css`) · 트레이 패널(`tray.html` · `tray-entry.ts` · `tray.ts` · `tray.css`) · 로고(`assets/logo/` — 화이트판만 쓴다). Vite 가 `dist/renderer/` 로 묶고 main 은 그쪽을 연다 · 타입 검사는 `src/renderer/tsconfig.json` |
| `src/renderer/ui/` | React 화면(`*.tsx` — ⚙ 설정 팝업 몸통 `settings-pop.tsx` · [작업] 팝업 몸통 `work-pop.tsx` · 에이전트 모니터 칸 `monitor.tsx` · pane [상세] 몸통 `pane-detail.tsx` · 시작 화면 몸통 `pack-welcome.tsx` · 옆 브라우저 막대 · 알림 줄 `browser-bar.tsx` · 알림 · 상태 줄 `notices.tsx` · 왼쪽 작업 공간 목록 `spaces.tsx` · 팩 줄 `pack-rail.tsx` · 팩 목록 줄 `pack-menu.tsx` · 팩 작업 진행 표시 몸통 `pack-progress.tsx`) · 바닐라 `.ts` 와 잇는 틀 `bridge.ts`(몸통 칸에 띄우기 · 문구 · 같이 보는 값) · `index.ts` 가 `StudioUi` 하나로 묶어 넘긴다 |
| `src/daemon/` · `src/daemon-client.mts` · `bin/athena-studio-cli` | 데몬(`main.mts` 소켓 서버 · `pane.mts` pty + 화면 버퍼 · `cli.js`) · 띄우기 · 붙기 · 버전 확인 · 코어 화면 계층이 pane 을 다루는 CLI |
| `src/lib/` | Electron 없이 도는 순수 로직(`npm test`) — `studio-home.js`(스튜디오 집 · 번들 · 업데이트 판단 · 초기화) · `app-update.mts`(⚙ 앱 업데이트 개발판 — 뒤처짐 · 빨리 감기) · `release-update.mts`(⚙ 앱 업데이트 배포판 — electron-updater 확인 · 받기 · 설치) · `version.js`(버전 번호 — 태그 계산 · describe) · `pack.mts`(팩 명령 출력 · 오류 · 약속 번호 · 이름 · 아이콘 · 시작 화면) · `core.mts`(설정 · 에이전트 고르기 · 자식 환경 · 포트) · `protocol.js`(데몬 통신) · `layout.mts`(분할 트리) · `screen-model.js` · `explorer.mts` · `file-icons.js` · `viewer.mts` · `agent-feed.mts`(모니터 피드) · `tray-model.mts`(트레이 요약 · 알림) · `tray-icon.mts` · `i18n.mts` · `space-names.mts` · `pane-keys.mts` |
| `src/i18n/<언어>.json` | 화면 문구 사전 4개(ko · en · ja · zh — 일 · 중은 검수 전 `draft`) |
| `scripts/` | `dev-app.js`(개발용 Athena.app · 코어 번들 · 화면 빌드 · 켜기) · `fix-spawn-helper.js` · `fake-pack.js`(개발용 가짜 본체) · `package-mac.js`(맥 배포판 — electron-builder) · `release-files.js`(Release 본문 · `latest.json` · `latest-mac.yml` 만들기) · `publish-release.js`(공개 레포에 올리기 — 로컬 gh) · `third-party-notices.js`(배포판 제3자 고지) |
| `test/` | `node:test` — 순수 로직 + 데몬 통합(맥 · 실제 pty) |
| `CHANGELOG.md` | 손님용 변경 기록(영어) — 배포판 버전마다 New / Improved / Fixed · 배포판 Release 본문은 그 버전 절 |
| `docs/release/` · `LICENSE` | 배포판 문서 — 손님용 사용 약관 초안 `EULA.md`(영어 · 법률 검토 전) · 홈페이지에 넘기는 고정 주소 · 부탁 `homepage-handoff.md` · 레포 루트 `LICENSE`(모든 권리 보유) |

## 검사
```sh
npm run check   # 문법
npm test        # 순수 로직 + 데몬 통합(맥 — 실제 pty)
```
화면 확인은 맥에서 한다. 코어(`athena/`)를 고쳤으면 코어 검사도 따로 — [`AGENTS.md`](AGENTS.md) "검사".
