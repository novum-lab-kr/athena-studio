# 검증 표준

에이전트와 reviewer는 **같은 스크립트**를 기준으로 하고 그 출력 표를 보고서의 "검증 결과"에 그대로 붙인다. reviewer·`commit.sh` 는 `scripts/verify/reuse.sh` 로 부른다 — 같은 트리로 이미 통과했으면 다시 돌리지 않는다(아래 "재사용").

레포별 명령(`scripts/verify/<레포>.sh [인자]`)은 팩 `pack/ROUTING.md` "검증 스크립트", 레포 고유 사정(테스트가 dev 자원에 붙는 레포·알려진 환경 이슈)은 **`docs/knowledge/company/verify.md`**(팩) 에 있다. 함께 읽는다.

## 실행 전 확인
- **워크트리 대상**: 스크립트는 기본으로 메인 체크아웃(`repos/<레포>`)을 검증한다. 워크트리를 검증하려면 `ATHENA_VERIFY_DIR=<워크트리> scripts/verify/<레포>.sh`. `delegate.sh <에이전트> --cwd <워크트리>`로 띄운 pane(reviewer 포함)은 이 값이 이미 들어 있다. 다른 레포의 워크트리를 가리키면 (일반 모드) 경고를 내고 메인 체크아웃을 검증하므로, 여러 레포를 리뷰할 때는 호출마다 붙인다. 결과 표 제목의 브랜치로 어느 트리를 검증했는지 확인한다
- **Node 버전**: 레포 `.nvmrc`와 현재 `node -v`가 같아야 한다. 스크립트가 다르면 경고 단계로 표시한다. 맞추는 법은 `nvm use <버전>`. 값은 각 레포 `.nvmrc`(지문 `.sync/snapshots/<레포>.json` 의 `nvmrc`). `.nvmrc` 가 없으면 검사가 조용히 생략된다
- **작업 base 최신 여부**: 작업 브랜치가 `origin/<prBase>` 보다 뒤처졌으면(`git log --oneline HEAD..origin/<prBase>`) 검증 실패가 내 변경 때문이 아닐 수 있다. 반영이 필요하면 사용자에게 묻는다. 메인 체크아웃을 pull 하지 않는다
- **생성물**: Orval(`__generated__/`)·Relay 아티팩트가 없으면 타입 검사가 실패하거나 건너뛴다. 스크립트가 유무를 확인해 이유를 표시한다
- **타입 검사 단계**(`scripts/verify/_lib.sh` `typecheck_step` — 공용 `_generic.sh` 가 부르고, 레포 스크립트도 부를 수 있다): 지금 폴더에 `tsconfig.json` · `jsconfig.json` · pyright 설정(`pyrightconfig.json` · `pyproject.toml` 의 `[tool.pyright]`)이 있을 때만 줄이 생긴다 — 없으면 그 레포 검증은 지금과 같다. 순수 TS(`allowJs` · `checkJs` 없음)는 오류 하나라도 실패, 섞어 쓰는 중(`allowJs` · `checkJs` · `jsconfig`) · pyright 는 **바뀐 파일**(기준 `origin/<prBase>` merge-base 대비 커밋 + 미커밋 + 미추적)의 오류만 실패이고 전체 오류 수는 결과 칸에 숫자로만 남는다. 레포 스크립트는 `typecheck_step <레포> --all|--changed` 로 정해 부를 수 있다. 기준 ref 를 못 찾으면 미커밋 파일만 보고 그 사실을 결과 칸에 적는다

## 결과 해석
| 표시 | 뜻 |
|---|---|
| ✅ 통과 | 그대로 보고 |
| ❌ 실패 | 마지막 40줄 로그가 함께 출력된다. **내 변경 때문인지 환경 때문인지 구분해서** 보고 |
| ⏭ 건너뜀 | 이유가 함께 표시된다. "통과"라고 쓰지 말고 건너뛴 사실과 이유를 그대로 보고 |
| ⏭ 건너뜀(규칙) | 스크립트가 규칙으로 정한 건너뜀(`skip_step_rule` — 예: 화면 파일이 안 바뀌어 화면 회귀를 안 돌림, `scripts/verify/changed-screen.sh`). 엄격 모드에서도 실패가 아니다. 건너뛴 사실은 그대로 보고 |
| ♻️ 재사용(@시각) | 같은 트리 내용·검증 스크립트·인자로 그 시각에 통과한 기록을 다시 찍은 것(`reuse.sh`). 그 단계의 원래 결과가 함께 적힌다 |

**엄격 모드**(`ATHENA_VERIFY_STRICT=1`, `scripts/commit.sh` 가 켠다 — 커밋 전 검증): 건너뜀(⏭)도 ❌ 실패로 친다. 허용은 사용자 확인 후 `commit.sh --allow-skip "<단계 이름>"`(= `ATHENA_VERIFY_ALLOW_SKIP`)으로만. `ATHENA_VERIFY_DIR` 가 그 레포의 워크트리가 아니면 메인 체크아웃으로 돌지 않고 exit 2 로 멈춘다.

**재사용** — 검증 스크립트가 통과하면 `scripts/verify/_lib.sh` 가 열쇠(트리 내용 + 검증 스크립트 + 인자)로 레포 밖(`${XDG_CACHE_HOME:-~/.cache}/athena/verify-pass/`, 7일 지나면 지움)에 결과 표를 기록한다. `scripts/verify/reuse.sh <레포> [인자]` 는 같은 열쇠면 다시 돌리지 않고 그 표를 `♻️ 재사용(@시각)` 으로 찍는다.
- 트리 내용 = 추적 파일 + 미추적 파일(무시 제외)의 지금 내용 — 커밋 여부·스테이징과 무관하다. 한 글자라도 바뀌면 다시 돈다
- 검증 스크립트 = 그 레포 스크립트 + `scripts/verify/` 코어 파일 + 팩 `pack.json`. 하나라도 바뀌면 다시 돈다
- 실행 환경 = `node -v` · python3 유무. Node 버전이 다른 셸이면 다시 돈다(Node 버전 건너뜀이 환경으로 정해지므로)
- 검증하는 동안 트리가 바뀌었으면 기록하지 않는다
- 엄격 모드에서는 기록에 건너뜀(⏭, 규칙 건너뜀 제외)이 있으면 그 단계가 모두 `--allow-skip` 에 있을 때만 재사용한다
- 꼭 다시 돌려야 하면 `reuse.sh` 대신 `scripts/verify/<레포>.sh` 를 부른다

**화면 회귀(screen-check)는 화면 파일이 바뀐 때만** — 코어 레포 검증이 `scripts/verify/changed-screen.sh` 로 판단한다(기준 ref 대비 커밋된 변경 + 미커밋 + 미추적). 화면 파일 = 화면 계층 자체 · screen-check 시나리오가 돌리는 스크립트 · 화면 계층을 부르는 코드 · 그것들이 불러 쓰는 파일. 손으로 적은 목록이 아니라 그때그때 코드에서 찾는다. 늘 돌리려면 검증 인자 `--full`

## QA 시뮬레이션 (영향 화면 실제 브라우저 검사 — 대상 앱은 팩에 등록한 화면 레포)

화면 목록(`impact.mjs`)은 Pages Router(`pages/**`)와 App Router(`app/**/page.tsx` — 라우트 그룹 `(x)` 는 주소에서 빼고, `layout`·`loading`·`error` 등이 바뀌면 그 폴더 아래 화면 전부, 로그인 표시는 화면과 감싸는 layout 의 `…AuthGuard`)를 둘 다 읽는다(앱 폴더의 `app/`·`pages/`, `src/` 아래도). 대상 앱은 팩 `repos` 에서 정해진다(`scripts/qa/apps.mjs` — 단일 레포 = 앱 하나, 모노레포 = 앱마다, 백엔드·패키지 제외 · `docs/pack.md` "QA 대상 앱"). 실제로 돌리려면 앱마다 `scripts/qa/routes/<앱>.json` 이 있어야 한다(현황판 [전체 검수] 앱 목록도 이 파일 기준) — 초안은 `node scripts/qa/init-app.mjs --app <앱>`(운영 기준 ref 의 화면 목록으로 routes·TC 초안, 있는 파일은 덮지 않는다).

**앱 설정**(`routes/<앱>.json`) — 코어에 앱마다 다른 값을 적지 않는다. `$` 로 시작하는 키(`$comment`·`$todo`)는 읽지 않는다.

| 키 | 뜻 |
|---|---|
| `server.port` · `server.basePort` | 작업·기준 dev 서버 포트(기본 3291 · port+1). 두 앱을 번갈아 돌려도 한 번에 하나라 겹쳐도 된다 |
| `server.dev` | 띄우는 명령(앱 폴더에서, `{port}` 치환) — 기본 `<패키지 관리자 exec> next dev -p {port}`. 패키지 관리자는 lockfile 로(pnpm·yarn·npm) |
| `server.prepare` | dev 전에 돌릴 package.json 스크립트 — `"gen:relay"` 또는 `{ "script": "gen:env", "unless": ".env" }`(그 파일이 앱 폴더에 있으면 건너뜀). 기본 없음 |
| `server.tokenCookie` | 로그인하면 생기는 쿠키 이름 앞부분 — 세션이 살아 있나·만료 시각을 이걸로 본다(값은 읽지 않는다). 없으면 세션 파일이 있으면 살아 있다고 본다. `init-app.mjs` 초안은 코드의 쿠키 읽기·쓰기(`cookies.get('…')`·`getCookie('…')` 등)에서 찾은 후보를 `$todo` 에 적고 값은 비워 둔다 |
| `server.localPorts` | 사람이 따로 띄워 둔 dev 서버 포트 — 현황판 [로그인] 이 `port` 다음으로 찾는다 |
| `signInPath` · `signOutPath` · `authPaths` | 로그인 화면 · 로그인 중 거치는 경로(간편인증 콜백 등 — 없으면 앞 둘). login.mjs 는 이 경로 밖으로 나오고 로그인 쿠키가 생겨야 끝난 것으로 본다 |
| `globalPaths` | 바뀌면 화면 전부가 영향인 경로 앞부분(레포 루트 기준 — 예 공통 tsconfig 패키지). `next.config.*`·`middleware`·`_app`·lockfile 등은 기본으로 친다 |
| `authGuard` | 로그인 필요 화면(🔒) 표시용 — 화면 파일·감싸는 layout 에서 찾을 정규식. 기본 `\b\w*AuthGuard\b` |
| `tracking.calls` · `tracking.section` · `tracking.pageView` | 트래킹 이벤트 목록(`impact --events`)용 — 이벤트 함수 이름 → 붙는 말(기본 `sendViewEvent`→`_viewed` · `sendClickEvent`→`_clicked` · `sendScrollEvent`→`_scrolled` · `sendRequestEvent`→`_request`), 스크롤 구간·화면 보기 컴포넌트 `{ "tag", "prop" }`(기본 `ScrollEventWrapper`·`sectionId` / `PageViewEventLogger`·`pageName`) |
| `dataErrors` | 실패 리포트에서 "🗂 계정 데이터 없음"으로 묶을 문구 정규식(오류 문구·화면 `note`) — 기본 `데이터 필요\|계정 상태\|No data returned\|Cannot return null`. 업무 필드 이름(예 `orderHistoryId`)은 여기에 |
| `devUrl` · `profiles` · `routes` · `viewports` · … | 서버 대상 기본 주소 · 세션 프로필 · 화면별 설정(`samples`·`entry`·`skip`·`expect`) · 뷰포트 |
검증 스크립트(lint·타입·테스트)와 별개다. **화면을 URL 로 바로 여는 스모크**라 흐름(본인인증 끝까지 등)은 보지 않는다(2차에서). 바꾼 파일에서 import 를 거꾸로 따라가 **영향받는 화면을 전부** 찾고, 작업 워크트리와 기준(`origin/<prBase>` merge-base) dev 서버를 함께 띄워 Playwright 로 화면마다 연다(데스크톱·모바일). 계획서 `plans/feature/20261002-QA-시뮬레이션-영향-화면.md`.

```bash
node scripts/qa/impact.mjs --cwd <워크트리> --app <앱>          # 영향 화면만 본다 (빠름, 서버 안 띄움)
node scripts/qa/run.mjs --cwd <워크트리> --app <앱> --plan <계획서> # 실제 실행 → 계획서 Checkpoint 에 "- QA result:" 한 줄
node scripts/qa/login.mjs --app <앱> --url http://localhost:<port>        # 로그인 세션 저장 (한 번, 사용자가 직접 **이메일** 로그인)
node scripts/qa/run.mjs … --headed [--slow 1200]                         # 보이는 창으로 — 창 하나에서 화면 이동 · 진행 띠 · 천천히 스크롤
node scripts/qa/history.mjs [--open [런 id]] [--plan <계획서>]          # QA 이력 (.qa-runs/index.html · 런마다 report.html)
# 현황판(/board) [QA] 탭 — 같은 이력을 실시간으로. 계획서 카드 [QA 실행] 으로도 돌린다(한 번에 하나)
```

TC 목록은 `docs/qa/tc/<앱>.md`(현황판 QA 탭 [TC 목록]이 읽는다). 쓰거나 다시 맞추는 것은 팩의 QA TC 스킬(있으면 — 예 `/qa-tc <앱> [#<PR>]`) — 그 앱 담당 에이전트가 코드를 읽어 갱신하고, 씬으로 옮길 TC 는 `scripts/qa/scenarios/<앱>/_draft/` 에 초안(검수 런은 읽지 않는다). 변경분 모드(`<앱> <브랜치>`)는 `.qa-runs/tc-picks/<앱>@<브랜치>.json` 을 남기고, 그 브랜치의 영향 QA 가 이를 읽어 TC 에 걸린 씬을 돌리고 나머지를 "사람이 확인" 으로 보여 준다(`--tc-picks <파일>` 로 직접 줄 수도 있다). 말로는 "이 브랜치 QA 돌려줘" — 아테나가 둘을 차례로 돌린다.

**전체 검수**(요청할 때만 — 정기 자동 실행 없음): 코드 diff 에 안 보이는 깨짐(API 응답·CMS·공통 패키지·환경)을 서비스 전체로 본다. 영향 QA 와 달리 기준 서버 대신 **승인한 기준 사진**(`.qa-baselines/<앱>/<프로필>/`, git 무시)과 비교한다.
```bash
node scripts/qa/run.mjs --suite --app <앱> [--profile login] [--headed]   # 최신 origin/<prBase>(qa-base) · 화면 전부 + 흐름 씬
node scripts/qa/approve.mjs <런 id> [--key <화면>]                              # 결과를 기준 사진으로 승인 (현황판 QA 탭 [기준으로 승인])
```
- 판정 추가: 🆕 기준 없음(처음 검수 — 승인하면 다음부터 기준) · 🙋 사람 필요(흐름 씬의 사람 단계 — `--headed` 로 돌리면 창에서 진행). 실패·이동 화면은 전체 승인에 올리지 않는다(콕 집으면 올림). 승인할 때 그 화면의 문제 목록도 함께 저장해 다음 검수에서 "알려진 문제"로 뺀다
- **흐름 씬** `scripts/qa/scenarios/<앱>/*.json` — 단계(`goto`·`expectUrl`·`expectText`·`click`·`fill`·`mock`(더미 응답)·`human`(사람 단계)·`wait`·`screenshot`), 형식은 `scripts/qa/scenario.mjs` 머리말. 비밀 값(비밀번호 등)은 씬에 적지 않는다. 이 회사 앱의 씬 목록은 `docs/knowledge/company/verify.md`.
- 요청: 대화("<앱> 전체 검수 돌려줘") 또는 현황판 QA 탭 [전체 검수 시작]. 화면 전부라 수십 분 걸릴 수 있고(추측) `heavy.sh` 차례를 기다린다
- **실행 전에 고른다(D21)** — 대화로 요청받으면 대상·진행 방식을 먼저 묻는다
  - 대상: 🖥 로컬 서버(내 브랜치·qa-base 코드, 이메일 로그인) · ☁️ 서버 `--server <주소>`(dev·stg·dev-1~3·PR 미리보기 — 배포본, 간편인증 가능. **운영 주소는 거부**). 세션은 `.qa-auth/<앱>@<호스트>.<프로필>.json`, 기준 사진은 `.qa-baselines/<앱>@server/`
  - 진행 방식: `--flow` 🧭 비로그인 → (세션이 없거나 만료면 라이브 화면이 로그인 요청 + 로그인 창) → 로그인 상태 전부 차례로(routes profiles 순서 — 예: login → verified, `flowTargets` 로 고를 수 있다. 단계마다 세션이 없거나 만료면 로그인 창, 안 하면 그 단계만 건너뜀) → 끝나면 실패 리포트 모달(D18~D20). 단계마다 그 세션의 씬만 돈다 · `--profiles a,b` 동시 · 한 세션만 `--profile`
- **라이브 화면** `--live` → 현황판 `/qa-live?id=<런>` (흐름·동시는 `?group=<묶음>`): 체크리스트(화면·씬, 누르면 검사 단계·스크린샷·호출 팝업) · 화면 영상(데스크톱·모바일) · 실시간 호출(GraphQL 보낸 값·errors·REST·Mixpanel, 태그로 거르기) · 제목 옆 완료 여부 · 실패 리포트(원인별 묶음, [자세히] 펼침, [담당 에이전트에게 조사 맡기기])
- **원인 묶음**은 `scripts/qa/explain.mjs` 정규식이 만든다. 정규식이 모르는 오류는 Jev 키가 등록돼 있으면(`docs/setup.md` 7-2) Jev 가 원인 종류(API·화면 코드·환경·리소스·외부 도구·무관한 경고)를 **추정**해 "추정(Jev N%)" 으로 붙인다(60% 미만은 안 붙임 · 캐시 `.board-jev-qa.json` · 처음 열 때 묻고 다음 새로고침에 보인다). 표시만 바꾸고 `run.json` 원문·실패 판정은 그대로다
- **검사 단계**(화면마다): 열기 · 도착 경로 · 콘솔·페이지 에러(📍 앱 소스 위치) · API 응답 · 이미지(img·CSS 배경·CDN·지연 로딩) · 눈으로 보이는 깨짐(CSS 미적용·아이콘 □·가로 넘침·깨진 글자·값) · 스크린샷 비교 · 트래킹(필수 화면 보기 이벤트 `<PageViewEventLogger pageName>` 누락은 ❌). 잘린 글자·가려진·화면 밖·이름 없는 버튼·찌그러진·흐린 이미지·alt 는 ⚠ 확인 필요(실패 아님)
- **안전장치**: 더미로 지정하지 않은 GraphQL mutation 은 보내지 않는다(막음) · Mixpanel 은 가로채 기록만(전송 안 함) · 외부 수집기(GA·광고·Clarity·Datadog RUM·픽셀)는 막는다 · 검사 중 로그인 토큰이 사라지면 멈추고 로그인을 요청한 뒤 그 화면부터 다시
- 씬 단계 추가: `mock` 의 `operation`(GraphQL 연산 이름) · `expectEvent`(Mixpanel 이벤트·props) · 씬 `viewports`(없으면 데스크톱·모바일 둘 다 동시에)
- routes 설정 추가: `devUrl` · `samplesFrom: "sitemap"`(CMS 동적 화면 주소를 그 서버 `/sitemap.xml` 에서) · `expect`(프로필별 정상 이동) · `allowStatus` · `networkIdle: false` · 화면별 `ignoreConsole`

**세션 프로필**(`routes/<앱>.json` `profiles`, `run.mjs --profile`): `logout`(로그인 화면은 로그인으로 가야 정상) · `login`(이메일 로그인·본인인증 전 — 본인인증 화면으로 가야 정상) · `verified`(본인인증까지 — 머물러야 정상). 기대와 다르게 가면 ❌. 기본은 세션이 저장된 첫 프로필. 세션 파일 `.qa-auth/<앱>.<프로필>.json`
- 본인인증까지 마친 세션: `login.mjs --profile verified --from login --path /auth/ci-request`

| 판정 | 뜻 |
|---|---|
| ✅ 통과 | 열림 · 새 에러 없음 · 기준 화면과 같음 |
| ☑️ 기대대로 이동 | 세션 프로필의 기대대로 가드가 보냈다(예: 본인인증 전 → `/auth/ci-request`) |
| 🟡 변화 | 기준 화면과 픽셀이 다르다 — 의도한 변경인지 **사람이 본다**(실패 아님) |
| ❌ 실패 | 기준 화면에 없던 콘솔 에러·페이지 에러·우리 요청 4xx/5xx·깨진 이미지·시간 초과 |
| ↪️ 이동됨 | 바로 열면 다른 화면으로 넘어가는 단계형 화면 — 단독 진입 불가(실패로 세지 않음). 진입 경로는 `scripts/qa/routes/<앱>.json` 의 `entry` |
| 🔒 로그인 필요 | 로그인 화면으로 넘어갔다 — 세션이 없거나 만료. `login.mjs` 를 다시 |
| 🪪 본인인증 필요 | 본인인증 화면으로 넘어갔다(기대가 없는 화면) — 본인인증 전 계정 |
| 📝 샘플 필요 | 동적 라우트인데 열 URL 이 없다 — `routes/<앱>.json` 의 `samples` 에 적는다 |

- 영향 분석은 **넓게 잡는다**: 패키지 진입점(`index.ts` barrel)을 거치면 그 패키지를 쓰는 화면이 모두 잡힌다(예: `@repo/user-session` 의 `AuthGuard` 하나 → 102개). `_app`·`next.config`·`proxy.ts`·루트 `package.json`·lock 은 화면 전부
- 산출물은 `.qa-runs/<런 id>/`(git 무시 · 지우지 않고 쌓인다), 세션은 `.qa-auth/`(git 무시·권한 600 — 쿠키 값을 출력하지 않는다). 기준 서버용 워크트리 `.worktrees/<레포>/qa-base` 는 재사용한다
- 포트: 작업 3291 · 기준 3292. 첫 실행은 `pnpm install`·webpack 첫 컴파일로 느리다
- 기준 화면에도 있던 에러는 이번 변경 탓이 아니라 실패로 세지 않는다(`baseProblems` 로 개수만 남긴다)

## 알려진 환경 이슈 (코드 문제가 아님)
- 회사 레포마다 다르다 — `docs/knowledge/company/verify.md` "알려진 환경 이슈"

## 무거운 명령 (`scripts/heavy.sh` — 2026-10-29 `AGENTS.md` 5절에서 옮김)

**읽을 때**: `heavy.sh` 가 오래 기다리거나 137 로 끝났을 때 · 무거운 명령을 새로 정할 때. 늘 지킬 요지는 `AGENTS.md` 5절.

- 대상: `pnpm/npm install` · `next build` · `next dev` · `tsc` · 테스트 · `relay` · `pkg:link/unlink` · `docker build` — 앞에 `<athena>/scripts/heavy.sh` 를 붙여 돌린다
- 한 대 공용 잠금 + 1분 부하가 코어×1.2 를 넘으면 내려갈 때까지 대기, 끝나거나 실패해도 잠금을 푼다
- **도는 동안 감시해서** 자식 프로세스가 300개를 넘거나 메모리 여유가 15% 아래면 그 명령과 자식을 모두 끄고 137 로 끝낸다 — 그러면 폭주한 것이니 원인을 찾기 전에는 다시 돌리지 않고 알린다
- 검증 스크립트(`scripts/verify/*.sh`) · `commit.sh` 검증은 스스로 줄을 선다. 기다리는 동안은 코드 작업을 먼저 하고, `next dev` 는 확인이 끝나면 바로 끈다(잠금을 쥐고 있다)
- 여러 에이전트를 동시에 띄워도 무거운 명령은 이걸로 자동 조절된다(2026-10-02 동시 빌드로 컴퓨터가 죽은 뒤)
