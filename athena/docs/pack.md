# 회사 팩 형식

아테나는 **코어**(이 레포 — 흐름·훅·현황판·학습 루프·공통 규칙)와 **회사 팩**(레포 목록·에이전트·레포 지식·검증 스크립트·라우팅)으로 나뉜다. 코어는 회사 이름을 모르고, 필요한 값은 `scripts/lib/config.mjs`(파이썬은 `scripts/lib/athena_config.py`)로 읽는다.

## 연결

```
athena.config.json   이 컴퓨터 설정 — { "pack": "packs/<회사>", "reposRoot": ".." }   (코어 레포에는 example 만)
packs/<회사>/         팩 레포 클론 (코어는 packs/ 를 git 에서 무시)
bin/athena pack link 팩 파일을 코어의 정해진 자리에 심볼릭 링크로 건다 — 목록은 .git/info/exclude 에 적힌다
bin/athena pack check 코어 파일에 팩 names(회사 이름)가 있는지 — 있으면 실패
```

합치는 규칙: `pack.json` 위에 `athena.config.json` 을 덮는다(같은 키면 이 컴퓨터가 이긴다). `repos` 는 팩 것만. `pack` 이 없으면 `athena.config.json` 하나가 전부다(팩 없이 쓰기).

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
- 말로: "팩 백업해줘" · "팩 되살려줘 <파일>"

## pack.json

```jsonc
{
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
