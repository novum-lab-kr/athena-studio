# 팩 형식

아테나는 **코어**(이 레포 — 흐름·훅·현황판·학습 루프·공통 규칙)와 **팩**(레포 목록·에이전트·레포 지식·검증 스크립트·라우팅)으로 나뉜다. 코어는 회사 이름을 모르고, 필요한 값은 `scripts/lib/config.mjs`(파이썬은 `scripts/lib/athena_config.py`)로 읽는다.

## 연결

```
athena.config.json   이 컴퓨터 설정 — { "pack": "packs/<회사>", "reposRoot": ".." }   (코어 레포에는 example 만)
packs/<회사>/         팩 레포 클론 (코어는 packs/ 를 git 에서 무시)
bin/athena pack link 팩 파일을 코어의 정해진 자리에 심볼릭 링크로 건다 — 목록은 .git/info/exclude 에 적힌다
bin/athena pack check 코어 파일에 팩 names(회사 이름)가 있는지 — 있으면 실패
```

합치는 규칙: `pack.json` 위에 `athena.config.json` 을 덮는다(같은 키면 이 컴퓨터가 이긴다). `repos` 는 팩 것만. `pack` 이 없으면 `athena.config.json` 하나가 전부다(팩 없이 쓰기).

위는 **옛 구조**(본체 하나 = 팩 하나)다. 본체 하나에서 팩 여럿을 골라 쓰는 **여러 팩 구조**는 아래 "여러 팩" — 옛 구조 본체는 `bin/athena pack migrate` 로 옮긴다.

## 팩 폴더

| 팩 안 | 코어 자리(링크) | 내용 |
|---|---|---|
| `pack.json` | — | 레포 목록·회사 값(아래) |
| `ROUTING.md` | `pack/ROUTING.md` | 사람이 읽는 레포·에이전트 표, 라우팅 규칙, 검증 명령, 회사 스킬. `CLAUDE.md` 가 `@pack/ROUTING.md` 로 불러온다 |
| `agents/<이름>.md` | `.claude/agents/` | 레포 담당 에이전트 프로필 |
| `skills/<이름>/` | `.claude/skills/` | 회사 스킬 |
| `knowledge/<레포>/` · `knowledge/company/` · `knowledge/learned/` | `docs/knowledge/` | 레포 지식 5종 · 회사 관례(git·verify·review) · 학습 기록 |
| `verify/<레포>.sh` | `scripts/verify/` | 검증 스크립트(`_lib.sh`·`_nest.sh` 는 코어) |
| `diagrams/*` | `docs/diagrams/` | 서비스 다이어그램 · `index.json`(목록 카드) · `SERVICES.md`(/diagram 서비스 표) — 둘 다 `athena scaffold` 가 처음 만든다 |
| `docs/*` | `docs/` | 회사 안내 문서 · `services.md`(서비스 소개 + 스택 표 — `athena scaffold` 가 처음 만들고 `build-derived` 가 표를 채운다) |
| `scripts/*` | `scripts/` | 회사 전용 스크립트 |
| `qa/{docs,routes,scenarios}` | `docs/qa` · `scripts/qa/routes` · `scripts/qa/scenarios` | QA TC·앱별 QA 설정(화면 목록·서버)·흐름 씬 — 초안은 `node scripts/qa/init-app.mjs --all`(/setup 이 부른다) |
| `sync/` · `archive/` | `.sync` · `archive` | 지문 · 보관한 일 |
| `hooks/delegate-env.sh` | — | (선택) `delegate.sh` 가 에이전트 실행기에 넣을 export 줄 |

코어에 같은 이름의 실제 파일이 있으면 링크하지 않고 실패한다(덮어쓰지 않는다).

## 백업 · 되살리기

팩은 git 레포가 아닐 수 있다(로컬에만 두는 회사 — 그러면 `archive/` 보관도 커밋되지 않고 로컬에만 남는다). 그래서 압축 파일 하나로 백업한다.
- `bin/athena pack backup [--out <폴더>]` — 지금 팩 폴더를 `<팩>-pack-<날짜-시각>.tar.gz` 로(기본 `~/athena-pack-backups/`). `.env*`·`*.key`·`*.pem`·`.npmrc`·`node_modules`·`.DS_Store`·`.omc` 는 담지 않는다
- `bin/athena pack restore <파일>` — `packs/<팩>` 으로 되살린다. 같은 이름 팩이 있으면 **덮지 않고 멈춘다**(옮기거나 지운 뒤 다시). 팩 없이 쓰는 중이면 `athena.config.json` 의 `pack` 을 잡고 링크까지 건다
- **여러 팩 구조**(아래)에서는 두 명령 모두 멈추고 안내만 한다 — 팩만은 `pack export --out <폴더>`, 팩 + 작업 기록은 `pack backup --with-work`, 되살리기는 `pack restore --with-work <파일>` 또는 `pack inspect <파일>` → `pack import <token> --new`
- 말로: "팩 백업해줘" · "팩 되살려줘 <파일>"

## 여러 팩 (본체 하나에서 팩을 골라 쓰기)

본체(이 레포 클론 하나 — 보통 `~/athena`)에서 팩 여럿을 등록해 두고 **한 번에 하나**를 쓴다. 쓰는 팩을 바꾸는 것을 **갈아 끼우기**라 한다(게임팩 갈아 끼우듯 — `pack use`). 팩과 그 팩의 작업 기록은 **사용자 데이터 폴더**에 있고, 본체에는 링크만 있다. 팩끼리 섞이지 않는다(가져오기는 복사 · 링크 금지). 계획서 `plans/feature/20261018-여러-회사-팩.md`.

```
~/athena/                       본체 — git, 업데이트만
├─ .pack-data → <데이터>/packs/<id>     활성 링크 — 팩 갈아 끼우기 = 이것 하나를 원자적으로 교체
├─ pack · plans · issues · repos · .worktrees · archive · .sync      고정 링크(.pack-data/… — 처음 한 번)
├─ .board-trash · .board-learn-stats.json · .board-jev-*.json · .jev-log.jsonl · .qa-runs · .qa-auth · .qa-baselines → .pack-data/state/…
└─ .claude/agents/<x>.md 등 팩 링크 → pack/agents/<x>.md   (논리 경로 pack/ 을 지나므로 같은 이름 파일은 갈아 끼워도 이어진다)

<데이터>/                       ATHENA_DATA_DIR → 본체 athena.config.json "dataDir" → ~/athena-data
├─ config.json                 팩 목록(packs) · 지금 팩(current) · 전환 세대(generation)
├─ switch.lock · switch.log     갈아 끼우기 잠금(주인 pid) · 단계 기록
├─ backups/ · tmp/              자동 백업(교체·옮기기 전) · 가져오기 검사 임시본(24시간)
└─ packs/<id>/                  id = 이 컴퓨터의 등록 이름(폴더 이름 · 바뀌지 않음)
   ├─ pack/                     팩(pack.json 의 id = 공유 ID packId)
   ├─ plans/ · issues/          작업 기록
   ├─ repos/                    레포 링크(local.json 의 reposRoot · repoPaths 로 만든다)
   ├─ worktrees/                새 워크트리(실제 경로 — 기존 본체 .worktrees 의 것은 제자리 · D4)
   ├─ state/                    현황판 휴지통·학습 수·Jev 캐시·QA 결과·학습 검토 대기열(learn-queue)·현황판 토큰(board-token, 600)
   └─ local.json                그 팩의 이 컴퓨터 설정 { reposRoot(절대 경로), repoPaths }
```

- **문서 ID 는 본체 기준 논리 경로**(`plans/…md` · `issues/…md` · `archive/…`) — 실제 경로로 풀지 않는다. 계획서 경로를 받는 스크립트는 `scripts/lib/plan-path.sh`(`plan_rel`)로 맞춘다. 실제 경로로 푸는 새 코드는 `scripts/path-lint.sh` 가 잡는다
- **세션 자리**: 아테나(Claude·Codex)는 본체에서만 켠다 · 위임 에이전트는 워크트리에서(실행기 `delegate.sh` 가 규칙·훅을 넘기고 `ATHENA_PACK_ID`·`ATHENA_SWITCH_GEN` 을 export) · 데이터 폴더에서는 세션을 띄우지 않는다(본체 규칙·훅을 못 찾는다)
- **설정**: 본체 `athena.config.json` 은 본체 것만(`dataDir` · `boardPort` · 필요하면 `screen`) — `pack` 은 쓰지 않는다(활성 링크가 정본). 팩의 이 컴퓨터 설정은 `<데이터>/packs/<id>/local.json`. 합치는 순서 `pack.json` < 본체 설정 < `local.json`
- **현황판 포트**: `ATHENA_BOARD_PORT` → 본체 `boardPort` → 4700. 현황판은 뜰 때의 팩·세대를 `/api/state.pack` 으로 알리고, 세대가 바뀐 뒤의 쓰기는 `409 stale-generation`. `POST /api/shutdown`(같은 출처 + 토큰) 으로 끈다. `scripts/board.sh` 는 떠 있는 현황판이 지금 팩·세대면 그대로 쓴다

### 명령 (`bin/athena pack …` — 스튜디오 약속은 계획서 5절이 정본)

`--json` 이면 진행은 `progress: <단계> <설명>` 줄, **마지막 줄 하나가 JSON**. 실패는 종료 1 + `{ ok:false, error, message }`(코드 `locked` · `busy` · `not-found` · `invalid-pack` · `unsafe` · `format-unknown` · `conflict` · `token-expired` · `clone-failed` · `rollback`), 사용법 오류는 2.

| 명령 | 하는 일 |
|---|---|
| `list` · `status` | 팩 목록(빈 자리는 안 보임) · 지금 팩(`empty:true` 면 /setup 전) · 갈아 끼우는 중인가 · 둘 다 `dataDir`(실제 데이터 폴더 절대 경로) · `status` 는 `boardPort` 도 |
| `busy` | 갈아 끼우면 안 되는 것 — 위임 에이전트·본체 아테나(claude 의 작업 폴더로 판별) · QA · 학습 검토 · 무거운 명령 잠금 · 다른 갈아 끼우기. 부른 명령의 조상 프로세스는 뺀다 |
| `use <id> [--start-board]` | 잠금 → 검사(형식 버전 · busy) → 현황판·학습 검토·QA 끄기 → 활성 링크 교체·팩 링크 → `repos/` 대조 → 확인 → 세대 +1. 중간에 실패하면 이전 팩으로 되돌린다(`rollback`). 현황판은 다시 띄우지 않는다(CLI 는 `--start-board`) |
| `new` | 빈 팩 자리(`new-<시각>`)를 지금 팩으로 → claude 를 켜면 /setup. `athena init` 이 자리 이름을 회사 이름으로 바꾼다. 취소는 `use <previous>`(빈 자리는 다음 갈아 끼우기 때 지운다) |
| `inspect <파일\|폴더\|git 주소>` | 임시 위치에서 검사만 → `token`(24시간). 압축의 절대 경로·`..` · 팩 밖을 가리키는 링크(링크 폴더를 거쳐도 — OS 실제 경로로 본다) · 최상위 `.git` — git clone 으로 받은 것·`import-athena`(내 옛 아테나)만 그대로 두고, 폴더·압축에서 온 것은 지운다(결과 `gitRemoved: true` — 팀과 git 으로 같이 쓰는 팩이면 git 주소로 가져오기) · `.git` 이 링크면 거부 · 비밀 파일(`.env*`·키·`.npmrc`) → `unsafe` · 모르는 형식 → `format-unknown`. git 은 `https://`·`ssh://`·`git@host:path` 만. 같은 `packId`(또는 같은 이름)가 있으면 `conflict` 를 같이 |
| `import <token> --new\|--replace\|--keep` | (`pack.json` 에 `id`·`formatVersion` 이 없어 써 넣었으면 결과 `packJsonUpdated`) 등록 · 같은 팩 교체(기존 팩 자동 백업 · 작업 기록은 그대로 · 지금 팩이면 busy 검사 후 링크 다시) · 버림. 같은 `packId` 를 `--new` 로 두 번 등록하지 않는다 |
| `import-athena <옛 아테나 폴더>` | 팩 + 계획서·이슈(·보관함)를 임시본으로 — 원본은 그대로. 워크트리는 목록만(제자리) → `import <token>` |
| `export --out <폴더>` | 지금 팩만 · 허용 목록(`pack.json` · `ROUTING.md` · agents · knowledge · verify · skills · docs · scripts · qa · hooks · `sync/snapshots` · diagrams — 목록 `index.html` 빼고). 작업 기록·비밀값·결과물은 빠진다 |
| `backup --with-work [--out]` · `restore --with-work <파일> [--new\|--replace]` | 내 백업 — 팩 + 계획서·이슈·보관함(비밀값·상태·워크트리 제외). 되살리기는 검사 뒤 등록(같은 팩이면 `conflict` → `--replace` 는 기존 기록 위에 없는 파일만 더한다) |
| `board-token` | 떠 있는 현황판의 쓰기 토큰·포트 |
| `migrate [--yes]` | 옛 구조 본체(이 폴더)를 여러 팩 구조로. `--yes` 없으면 무엇을 어디로 옮기는지만 보여 준다. 자동 백업 → 복사 → 개수 대조 → 링크 전환 → 설정의 `pack`·`screen`·`reposRoot`·`repoPaths` 를 `local.json` 으로. 옛 `plans`·`issues`·상태 파일은 본체 `.migrate-<시각>/` 로 옮겨 둘 뿐 지우지 않는다(원본 팩 `packs/<회사>` 도 그대로). 두 번 돌리면 `already` |
| `test-setup` | 테스트 전용 — 아래 |

## 여러 팩 테스트 (진짜 `~/athena`·`~/athena-data` 를 건드리지 않고)

**자동 시험** — `test/packs-test.sh`: 작업 트리를 임시 폴더에 복사한 본체 + 임시 데이터 폴더에서 위 명령을 끝까지 돌린다(약 1분 · 끝나면 지운다 · `KEEP=1` 이면 남긴다). 진짜 본체·데이터·이 체크아웃의 링크는 건드리지 않는다.

**손으로 — 테스트 본체**(지금 쓰는 `~/athena` 가 아닌, 코어 레포를 따로 받은 체크아웃을 본체로 — 아래 `<테스트 본체>`):
1. 터미널에서
   ```bash
   cd <테스트 본체>
   ATHENA_DATA_DIR=~/athena-test-data bin/athena pack test-setup
   ```
   `~/athena-test-data` 를 **지우고** 가짜 레포 넷(`repos-src/` · 원격은 `remotes/`)과 테스트 팩 둘(`test/fixtures/packs/{acme,globex}` 복사 · 팩마다 샘플 계획서·이슈 하나)을 등록한 뒤 acme 를 지금 팩으로 한다. 본체 `athena.config.json` 에 `dataDir: ~/athena-test-data` · `boardPort: 4710` 을 적는다(`screen` 은 넣지 않는다) — 그 뒤로는 `ATHENA_DATA_DIR` 없이도 이 본체는 테스트 데이터를 본다. 데이터 폴더 이름에 `test` 가 없거나 본체가 `~/athena` 면 멈춘다
2. 확인: `bin/athena pack list` → acme ▶ · globex. `ls -l plans issues repos` 가 `.pack-data/…` 링크
3. 갈아 끼우기: `bin/athena pack use globex --start-board` → 현황판 http://localhost:4710 에 globex 샘플만. 다시 `pack use acme`
4. 막히는지: 다른 터미널에서 `cd <테스트 본체> && claude` 를 켜 둔 채 `pack use globex` → `busy`(끄면 통과)
5. 가져오기·내보내기: `bin/athena pack export --out /tmp/x` → `bin/athena pack inspect /tmp/x/acme-pack-*.tar.gz` → 같은 팩이라 `conflict` → `bin/athena pack import <token> --keep`. 나쁜 팩: `bin/athena pack inspect test/fixtures/bad-packs/outside-link` → `unsafe`
6. 스튜디오: 설정 `athenaDir` 를 `<테스트 본체>` 로 · 앱을 `ATHENA_DATA_DIR=~/athena-test-data` 로 띄운다(본체 설정에 `dataDir` 가 있어 없어도 같은 폴더를 본다) → 팩 고르기·갈아 끼우기·가져오기·내보내기
7. 끝나면: `bin/athena pack status` 로 상태를 본 뒤 그대로 두거나, 테스트 데이터를 지운다(`rm -rf ~/athena-test-data` — 테스트 본체의 링크는 그때 깨진 링크가 되니 다시 `pack test-setup`)

- 일부러 실패시키기(되돌리기 확인): `ATHENA_PACK_FAIL_AT=link|repos|verify bin/athena pack use globex` → `rollback` 과 함께 acme 그대로
- 테스트 본체에서 `athena pack check` 는 테스트 팩의 names(코어 문서에 나오지 않는 말로 정해 두었다)로 검사하고 `test/fixtures/` 는 뺀다
- **금지**: 테스트 중 `~/athena` 의 설정·링크·`plans/`·`issues/` 를 바꾸지 않는다. `pack migrate` 는 `~/athena` 를 **복사한** 폴더에서만 시험한다(`test/packs-test.sh` 는 합성 옛 본체로)

## pack.json

```jsonc
{
  "formatVersion": 1,                     // 팩 형식 버전 — 이 코어가 모르는 버전이면 가져오기·갈아 끼우기를 멈춘다(scripts/lib/config.mjs PACK_FORMAT_VERSION)
  "id": "acme-5f0c1a2b",                  // 공유 ID(packId) — 복사한 팩끼리 같다. 없으면 가져오기·옮기기가 붙인다
  "name": "acme",
  "names": ["acme", "에이크미"],          // pack check 가 코어에서 찾을 회사 이름
  "github": { "org": "acme-inc" },        // PR 조회·링크 판별
  "trackedDeps": ["^@acme/"],             // 지문에 버전을 남길 사내 패키지(정규식)
  "worktreeCopy": { "include": [".env", ".env.*"] },
  "qa": { "apps": { "shop-web": "쇼핑" }, "ownHosts": ["acme.com"], "iconFont": "", "exampleUrl": "https://dev.acme.com" },   // apps 는 화면에 보일 이름표만(없어도 된다)
  "derived": { "servicesColumns": ["…"], "playbookOrder": ["…"] },   // 없으면 설정 순서
  "hooks": { "delegateEnv": "hooks/delegate-env.sh" },
  "repos": [
    { "name": "admin-web", "agents": ["admin-fe"], "branch": "prd", "prBase": "dev", "kind": "single", "appDir": "app",
      "alias": "admin",                    // new-branch 대상 이름(없으면 레포 이름 일부)
      "prScope": "admin" },                // PR 제목 범위 — 문자열 또는 [{ "match": "^apps/([^/]+)/", "scope": "$1" }]
    { "name": "web", "kind": "monorepo", "branch": "dev", "alias": "web",
      "apps": { "shop-web": { "agent": "shop-fe", "branch": "prd-shop", "prBase": "dev" } },
      "packagesAgent": "web-packages-fe",
      "prScope": [{ "match": "^apps/([^/]+)/", "scope": "$1" }, { "match": "^packages/", "scope": "packages" }] },
    { "name": "ui-packages", "agents": ["packages-fe"], "branch": "main", "prBase": "main", "kind": "packages", "scope": "frontend",
      "requireChangeset": true },          // ship.sh 미리보기가 .changeset/*.md 없으면 경고
    { "name": "mobile", "agents": ["mobile-app"], "branch": "prd", "prBase": "prd", "kind": "single",
      "extraPrBases": ["dev"],             // PR base 후보에 함께
      // "direct": true,                   // main 직접 — 브랜치·워크트리·PR 없이 메인 체크아웃의 prBase 에서 바로 작업·커밋, ship.sh 가 빨리 감기 push(git.md "작업 브랜치 만들기")
      "branchName": { "pattern": "feature/v{version}/{ticket}", "versionFile": "app.config.js", "versionRegex": "^\\s*version:\\s*\"([0-9.]+)\"" } },
    { "name": "api", "agents": ["api-be"], "branch": "prd", "prBase": "dev", "kind": "single", "layer": "be", "appDir": "src" }
  ]
}
```

- `kind`: `single` · `monorepo`(앱마다 에이전트·브랜치, 커밋 검증은 바뀐 앱마다) · `packages`(발행 패키지 — 커밋 검증에 패키지 이름 필요)
- `layer: "be"` — 백엔드. PR 범위 규칙이 없으면 `src/features/<기능>`·`src/<모듈>`

## QA 대상 앱

QA 시뮬레이션(`scripts/qa`) 대상은 **등록한 레포에서 정해진다**(`scripts/qa/apps.mjs`) — 따로 적지 않는다.

- 단일 레포 = 앱 하나(이름은 레포 이름, 바꾸려면 `"qaApp": "<이름>"`) · 앱 폴더는 레포 루트
- 모노레포 = `apps` 의 앱마다(앱 폴더 `apps/<앱>`, 다르면 `apps.<앱>.dir`)
- `kind: packages`·`layer: be` 는 화면이 없어 뺀다. Next.js 앱(`app/`·`pages/`, `src/` 포함)만 돌릴 수 있다
- 앱마다 `qa/routes/<앱>.json` 이 있어야 돌린다(없으면 현황판에 안 보이고 run.mjs 가 초안 명령을 알려 준다). 형식은 `docs/knowledge/common/verify.md` "앱 설정"
- 예전 `qa.repo`(모노레포 하나 가정)는 더 읽지 않는다. 남아 있거나 routes 에 `server` 블록·`server.tokenCookie` 가 없으면 run.mjs·현황판 QA 탭이 한 줄 경고를 띄운다(기본값으로 계속 돈다)
