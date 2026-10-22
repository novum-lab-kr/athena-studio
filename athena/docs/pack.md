# 팩 형식

아테나는 **코어**(이 폴더 — Athena Studio 가 들고 와 `~/.athena-studio/core` 에 푼다 · 흐름·훅·현황판·학습 루프·공통 규칙)와 **팩**(레포 목록·에이전트·레포 지식·검증 스크립트·라우팅)으로 나뉜다. 코어는 회사 이름을 모르고, 필요한 값은 `scripts/lib/config.mjs`(파이썬은 `scripts/lib/athena_config.py`)로 읽는다.

## 연결

```
athena.config.json   이 컴퓨터 설정 — { "pack": "packs/<회사>", "reposRoot": ".." }   (코어에는 example 만 커밋된다)
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
- `bin/athena pack backup [--out <폴더>]` — 지금 팩 폴더를 `<팩>-pack-<날짜-시각>.tar.gz` 로(기본 `<데이터>/backups/packs/` · `pack backup --with-work` 도 같다). `.env*`·`*.key`·`*.pem`·`.npmrc`·`node_modules`·`.DS_Store`·`.omc` 는 담지 않는다
- `bin/athena pack restore <파일>` — `packs/<팩>` 으로 되살린다. 같은 이름 팩이 있으면 **덮지 않고 멈춘다**(옮기거나 지운 뒤 다시). 팩 없이 쓰는 중이면 `athena.config.json` 의 `pack` 을 잡고 링크까지 건다
- `pack backup --with-work` 는 이 컴퓨터의 레포 자리(`local.json` — 지금 이어진 링크의 실제 경로)도 담는다. 되살릴 때 그 폴더가 있으면 그대로 잇는다(`--new` 는 그대로 · `--replace` 는 이 컴퓨터 설정에 없는 레포만 채운다). 팀에 주는 `pack export` 에는 담지 않는다. 두 파일 모두 **사본** pack.json 에 레포 git 주소(`repos[].remote` · https 주소의 사용자 · 토큰은 뗀다)를 채운다 — 원본 팩은 그대로
- **여러 팩 구조**(아래)에서는 두 명령 모두 멈추고 안내만 한다 — 팩만은 `pack export --out <폴더>`, 팩 + 작업 기록은 `pack backup --with-work`, 되살리기는 `pack restore --with-work <파일>` 또는 `pack inspect <파일>` → `pack import <token> --new`
- 말로: "팩 백업해줘" · "팩 되살려줘 <파일>"

## 여러 팩 (팩마다 본체 — 팩 여러 개를 동시에)

팩 여럿을 등록해 두고 **팩마다 본체를 따로** 둔다. 본체는 코어 체크아웃이고, 본체 하나 = 팩 하나 = 현황판 하나다. 그래서 팩 여러 개를 **동시에** 켤 수 있다(한 팩에서 아테나·에이전트가 일해도 다른 팩은 그대로 열린다). 다른 팩으로 가는 것은 **열기**(`pack open`)다 — 본체의 팩을 바꾸지 않는다. 팩과 그 팩의 작업 기록은 **사용자 데이터 폴더**에 있고, 본체에는 링크만 있다. 팩끼리 섞이지 않는다(가져오기는 복사 · 링크 금지).

```
~/.athena-studio/core/          주 본체 — git 저장소 주인(앱이 들고 온 번들에서 clone) · main 브랜치 · 정비(코어 고치기·커밋)는 여기서만
~/.athena-studio/bodies/<id>/   팩 본체 — 같은 저장소의 git 워크트리 · 브랜치 없이(detached) 배포 커밋 · pack open 이 만든다(레지스트리 bodiesDir)
  (각 본체 안)
├─ .pack-data → <데이터>/packs/<id>     그 본체의 팩 — 본체를 만들 때 한 번 걸고 바꾸지 않는다
├─ pack · plans · issues · repos · .worktrees · archive · .sync      고정 링크(.pack-data/…)
├─ .board-trash · .board-learn-stats.json · .board-jev-*.json · .jev-log.jsonl · .qa-runs · .qa-auth · .qa-baselines → .pack-data/state/…
├─ .claude/agents/<x>.md 등 팩 링크 → pack/agents/<x>.md
└─ athena.config.json            그 본체 설정(dataDir · boardPort)

<데이터>/                       ATHENA_DATA_DIR → 본체 athena.config.json "dataDir"(스튜디오가 채운다) → ~/.athena-studio/data
├─ config.json                 formatVersion(데이터 형식) · packs.<id>{ name · packId · body(본체 경로) · boardPort · generation(그 팩 세대) } · deploy{ commit · previous · operationId · source(bundle · 옛 기록은 origin) }
│                              · (선택) bodiesDir(팩 본체 자리 — <bodiesDir>/<id> · 상대 경로는 데이터 폴더 기준) · portBase(현황판 포트 기준 · 없으면 4700)
├─ registry.lock · locks/<id>.lock · locks/_git.lock    레지스트리 잠금(읽기→수정→저장) · 팩마다 작업 잠금(열기·업데이트) · git 공용(worktree·fetch)
├─ updates/<operationId>.json   업데이트·되돌리기 기록(본체마다 from·to·status)
├─ switch.log                   단계 기록
├─ backups/ · tmp/              자동 백업(교체·옮기기 전) · packs/(pack backup 기본 자리) · core-edits/<operationId>/<id>/(update --backup-dirty 가 둔 고친 코어 파일 사본) · 가져오기 검사 임시본(24시간)
└─ packs/<id>/                  id = 이 컴퓨터의 등록 이름(폴더 이름 · 바뀌지 않음)
   ├─ pack/                     팩(pack.json 의 id = 공유 ID packId)
   ├─ plans/ · issues/          작업 기록
   ├─ repos/                    레포 링크 — 찾는 순서: local.json repoPaths(없으면 reposRoot/<이름>) → 지금 링크가 가리키는 레포(손으로 이은 것) → pack.json repos[].remote 와 git 주소가 같은 레포(reposRoot 아래 3단계). 뒤의 둘로 찾으면 repoPaths 에 적는다
   ├─ worktrees/                새 워크트리(실제 경로)
   ├─ state/                    현황판 휴지통·학습 수·Jev 캐시·QA 결과·학습 검토 대기열(learn-queue)·현황판 토큰(board-token, 600)·사람에게 묻는 요청(requests/ — docs/requests.md)
   └─ local.json                그 팩의 이 컴퓨터 설정 { reposRoot(절대 경로), repoPaths }
```

- **문서 ID 는 본체 기준 논리 경로**(`plans/…md` · `issues/…md` · `archive/…`) — 실제 경로로 풀지 않는다. 계획서 경로를 받는 스크립트는 `scripts/lib/plan-path.sh`(`plan_rel`)로 맞춘다. 실제 경로로 푸는 새 코드는 `scripts/path-lint.sh` 가 잡는다
- **세션 자리**: 아테나(Claude·Codex)는 그 팩 본체에서 켠다 · 위임 에이전트는 워크트리에서(실행기 `delegate.sh` 가 규칙·훅을 넘기고 `ATHENA_PACK_ID`·`ATHENA_SWITCH_GEN` 을 export) · 데이터 폴더에서는 세션을 띄우지 않는다. 스크립트는 자기 위치로 본체를 찾는다 — 팩 링크로 걸린 스크립트(`scripts/verify/<레포>.sh` 등)는 **본체 경로로** 부른다(실제 경로 `<데이터>/packs/…` 로 부르면 본체를 못 찾는다)
- **정비는 주 본체에서만**: 팩 본체는 브랜치가 없다(detached). 그 본체에서 직접 켠 claude 에는 루트 훅(secret-guard)만 걸리고 커밋 보호(commit-guard)는 위임(`delegate.sh`)이 넣는다 — 팩 본체에서 코어를 고치거나 커밋하지 않는다
- **설정**: 본체 `athena.config.json` 은 본체 것만(`dataDir` · `boardPort` · 필요하면 `screen`) — `pack` 은 쓰지 않는다(활성 링크가 정본). 합치는 순서 `pack.json` < 본체 설정 < `local.json`
- **현황판 포트**: 레지스트리 `packs.<id>.boardPort`(정본) → 본체 `boardPort` → `ATHENA_BOARD_PORT` → 레지스트리 `portBase` → 4700(옛 구조 본체는 env 가 먼저). 주 본체는 지금 값(없으면 `portBase` · 기본 4700), 새 본체는 `portBase`+2(기본 4702) 부터 2씩 — 데이터 폴더마다 `portBase` 로 범위를 가른다(스튜디오 4800). 백그라운드로 띄운 현황판 로그는 `/tmp/hermes-board.log`(포트 4700) · 다른 포트면 `/tmp/hermes-board-<포트>.log`. 현황판은 뜰 때의 팩·**그 팩 세대**·`bodyId`·`core`·`instance` 를 `/api/state.pack` 으로 알리고, 그 팩 세대가 바뀐 뒤의 쓰기는 `409 stale-generation`(다른 팩의 일로는 바뀌지 않는다). `POST /api/shutdown`(같은 출처 + 토큰) 으로 끈다
- **git exclude**: 팩 링크 목록은 `.git/info/exclude` 에 본체마다 구간으로 적는다. 링크된 워크트리도 공용 exclude 만 읽으므로(2026-10-18 git 2.50 실측) 무시 규칙은 모든 본체의 **합집합**이다 — 팩 링크 자리에 코어 실제 파일을 두지 않는 규칙(링크 clash)이 이걸 막는다. 쓰기는 잠금으로 하나씩
- **busy**: 그 본체·그 팩 데이터·그 팩 레포 안에서 도는 claude·codex · QA · 학습 검토 · 무거운 명령 잠금(잠금에 적힌 본체만 — `scripts/heavy.sh` 가 `root` 를 적는다) · 그 팩 작업 잠금. 프로세스·작업 폴더를 못 읽으면 `unknown`(비어 있다고 보지 않는다). 다른 본체의 일은 이 본체를 막지 않는다

### 명령 (`bin/athena …` — 스튜디오 앱이 부르는 약속은 이 절이 정본)

`--json` 이면 진행은 `progress: <단계> <설명>` 줄, **마지막 줄 하나가 JSON**. 실패는 종료 1 + `{ ok:false, error, message }`, 일부만 성공은 종료 1 + `status:"partial"`, 사용법 오류는 2. 스튜디오는 `--contract 2` 를 붙인다(다르면 `contract-mismatch` · `pack use`·`pack new` 는 `--json` 인데 없으면 거부 — 1단계 스튜디오의 "갈아 끼우기"를 막는다). 오류 코드: 1단계(`locked` · `busy` · `not-found` · `invalid-pack` · `unsafe` · `format-unknown` · `conflict` · `token-expired` · `clone-failed` · `rollback`) + `body-conflict` · `body-mismatch` · `port-in-use` · `contract-mismatch` · `data-incompatible` · `fetch-failed` · `verify-failed` · `rollback-unavailable` · `rollback-failed` · `partial`.

| 명령 | 하는 일 |
|---|---|
| `list` · `status` · `busy` | 팩 목록(팩마다 본체 · 포트 · `bodyState` · `core` · `updatePending` · `busy[]`·`busyKnown`) + `emptySlots`(/setup 전 빈 자리) · 이 본체의 팩·포트·코어 · 이 본체에서 도는 것 |
| `open <id>` | 그 팩 본체를 준비하고 경로를 돌려준다. 없으면 `<bodiesDir>/<id>`(레지스트리 `bodiesDir` — 스튜디오는 `~/.athena-studio/bodies` · 없으면 `<주 본체>-<id>`)에 `git worktree add --detach <배포 커밋>`(레지스트리 `deploy.commit` → 주 본체의 `origin/main`(처음 clone 한 번들) · 주 본체 로컬 HEAD 는 쓰지 않는다 · 그 커밋 코어가 팩마다 본체를 모르면 `contract-mismatch`) → 본체 설정 → **그 본체 코드로** 팩을 건다(`pack attach`) → 포트 배정. 있으면 링크를 검증·고친다(못 고치면 `state:"repair-required"`) · 배포 커밋보다 뒤처졌고(배포 커밋이 지금 커밋의 후손 — 앞으로만) 비어 있으면 그때 옮긴다(`updated` — 그 본체 현황판을 껐으면 `updated.boardStopped`). 만들다 실패하면 만들던 본체를 지운다. 그 자리에 다른 폴더가 있으면 `body-conflict`. 빈 자리(`pack new` 뒤 /setup 전)도 연다 — 다른 팩으로 넘어갔다 돌아와 /setup 을 이어 한다 |
| `use <id> [--start-board]` | `open` 과 같다(+ 1단계 필드 `current`·`previous`·`unchanged`·`bodyChanged`·`opened`). 본체의 팩을 바꾸지 않는다 |
| `new` | 빈 팩 자리(`new-<시각>`) + 그 본체 → 그 본체에서 claude 를 켜면 /setup(`athena init` 이 자리 이름만 회사 이름으로 · 본체 폴더는 그대로). 취소는 다른 본체에서 `discard <id>` |
| `discard <id>` | 빈 자리(팩·작업 기록 없음)와 그 본체만 지운다 — 주 본체·부른 본체는 지우지 않는다. 서비스 레포·워크트리는 링크라 그대로 |
| `inspect` · `import <token> --new\|--replace\|--keep` · `import-athena` · `export` · `backup --with-work` · `restore --with-work` · `board-token` · `migrate` | 1단계와 같다. `import --replace` 는 **그 팩의 본체**(어느 본체에서 불렀든)를 기준으로 팩 잠금·busy·현황판 끄기·링크 다시·그 팩 세대 +1 |
| `set-name <이름>\|--clear [--id <팩>]` · `set-icon <이미지>\|--clear [--id <팩>]` | 팩 표시 이름 · 아이콘을 **팩 안**(`pack.json` `displayName`·`icon` · `assets/`)에 — 팀과 공유된다(git 팩이면 팩 레포의 미커밋 변경). 이미지는 앞 바이트로 png·jpeg·webp 만 · 1MB 이하(`invalid-image` · `image-too-large`), 이름은 1~40자 · 줄바꿈 없음(`invalid-name`). `--id` 없으면 이 본체의 팩. 그 팩 작업 잠금 안에서 쓴다. `list`·`status`·`open` 에 `displayName` · `iconPath`(실제 절대 경로) · `iconUpdatedAt`. 내보내기·백업에 `assets/` 가 들고, 가져오기 검사는 `icon` 경로 모양과 `assets/` 안 이미지(형식·크기·링크 없음)를 본다 |
| `relink` · `attach <id>` | 본체 안에서 쓰는 것 — 링크 다시 맞추기(업데이트 뒤 새 코드로) · 빈 본체에 팩을 처음 걸기(이미 다른 팩에 묶였으면 `body-mismatch`) |

### 코어 업데이트 · 되돌리기 · 버전

| 명령 | 하는 일 |
|---|---|
| `update --from <git 번들> [--to <커밋>] [--backup-dirty]` | 앱이 들고 온 코어 번들의 `main` 을 주 본체의 `refs/athena/bundle/main` 으로 받는다(원격에서 받는 길은 없다 — `--from` 이 없으면 사용법 오류 · 결과·`deploy.source` 는 `bundle`) → 배포 커밋 = 그 `main`(또는 `--to`) → 본체마다: 그 팩 잠금 → busy 다시(부른 쪽 포함 · 모르면 건너뜀) → 추적 파일 미커밋이면 `dirty`(`--backup-dirty` 면 다른 검사를 다 통과한 뒤 `<데이터>/backups/core-edits/<operationId>/<id>/` 에 사본 — `files/` · `changes.patch` · `meta.json` — 을 두고 되돌려 계속 · 결과 `backedUp[{ id, dir, files }]` · 본체마다 `backedUp`·`backupDir`) → 이전 커밋을 `refs/athena/rollback/<operationId>/<id>` 로 보존 → 현황판 끄기 → 팩 본체는 `checkout --detach`, **주 본체는 깨끗하고 뒤에만 있으면 `merge --ff-only`**(로컬 커밋이 있으면 `diverged`) → 새 코드로 `relink` → 실패하면 **그 본체만** 이전 커밋으로(`rolledBack` · 그것도 안 되면 `recoveryRequired`). 일하는 본체는 `skipped`(`busy`) — 다음 `open` 때 따라잡는다. 모든 본체가 실패하면(`failed`) 배포 커밋은 그대로 둔다. 대상 커밋의 데이터 형식 범위(`DATA_FORMATS`)가 지금 데이터를 못 다루면 모든 본체가 비었을 때만. 현황판은 다시 띄우지 않는다 |
| `update --rollback [<operationId>]` | 그 업데이트(없으면 본체를 하나라도 바꾼 마지막 업데이트 — 실패·바꾼 것 없는 기록은 건너뛴다)가 **바꾼 본체만**, 지금도 그 실행의 커밋에 있을 때 보존 ref 로 되돌린다(아니면 `moved`). 주 본체는 되돌리지 않는다(`main` — 정비 체크아웃은 손으로). 배포 커밋은 본체를 하나라도 실제로 되돌렸고 지금 배포 커밋이 그 업데이트의 것일 때만 그 전으로(아니면 그대로) |
| `version` | 이 본체 코어 커밋 · `contract`(2) · `dirty` · `dataFormats` · `capabilities`(`update-from-bundle` · `backup-dirty` · `bodies-dir` · `port-base` 가 있으면 위 손잡이를 안다) · `deploy`(`source` 포함). 스튜디오는 `contract` 가 다르면 안내한다 |

- **데이터 형식**: `<데이터>/config.json` 의 `formatVersion` 이 이 코어의 `dataFormats` 밖이면 쓰기 명령은 `data-incompatible`(읽기는 된다) — 형식을 바꾸는 코어는 모든 본체를 함께 올린다

## 여러 팩 테스트 (진짜 스튜디오 집 `~/.athena-studio` 를 건드리지 않고)

**자동 시험** — 둘 다 임시 폴더에서 돌고 끝나면 지운다(`KEEP=1` 이면 남긴다). 진짜 본체·데이터·이 체크아웃의 링크는 건드리지 않는다.
- `test/packs-test.sh`(약 1분) — 본체 하나: test-setup · 이 본체 팩 열기·계약 확인 · 팩마다 잠금 · busy · 계획서 논리 경로 · 가져오기·내보내기·백업 · 옮기기 · 현황판(팩 세대 409·포트 정본·끄기)
- `test/bodies-test.sh`(약 2분) — 임시 bare 원격 + 주 본체 클론(지금 작업 트리를 커밋) + 워크트리 본체(새 코어는 그 원격의 번들로): `pack open`(동시 열기 · 실패하면 지움 · 자리 충돌) · `new`/`discard` · 한 본체가 일해도 다른 본체 열기 · `import --replace` 는 그 팩 본체 기준 · 경로 검증표 · `update --from <번들>`(`--from` 없으면 사용법 오류 · 일하는 본체 건너뜀 · 주 본체 ff·dirty·diverged · 링크 실패면 그 본체만 되돌림 · 멱등) · `--rollback` · 열 때 따라잡기 · 데이터 형식 게이트
- `test/bundle-test.sh`(약 1분) — 앱이 코어를 번들로 들고 오는 경우(스튜디오): 번들 → 주 본체 clone · 본체 설정 `dataDir` · `bodiesDir`·`portBase` · `update --from <번들>`(전체·얇은 번들 · `deploy.source`) · 업데이트 전후 `<데이터>/packs` 해시 동일 · 본체 안 진짜 파일(설정·상태 파일·`.migrate-*`) 그대로 · `dirty` 건너뜀 · `--backup-dirty` 사본 · 되돌리기 · 일하는 본체 · 백업 기본 자리

**손으로 — 테스트 본체**(스튜디오 주 본체 `~/.athena-studio/core` 가 아닌, 그것을 따로 clone 한 폴더를 주 본체로 — 아래 `<테스트 본체>`. `git clone ~/.athena-studio/core <테스트 본체>` · 레지스트리에 `bodiesDir` 가 없으니 `pack open` 은 그 옆에 `<테스트 본체>-<id>` 워크트리를 만든다):
1. 터미널에서
   ```bash
   cd <테스트 본체>
   ATHENA_DATA_DIR=/tmp/athena-test-data bin/athena pack test-setup
   ```
   `/tmp/athena-test-data` 를 **지우고** 가짜 레포 넷(`repos-src/` · 원격은 `remotes/`)과 테스트 팩 둘(`test/fixtures/packs/{acme,globex}` 복사 · 팩마다 샘플 계획서·이슈 하나)을 등록한 뒤 acme 를 이 본체 팩으로 건다. 본체 `athena.config.json` 에 `dataDir: /tmp/athena-test-data` · `boardPort: 4710` 을 적는다. 데이터 폴더 이름에 `test` 가 없거나 본체가 `~/.athena-studio/core` 거나 데이터 폴더가 `~/.athena-studio/data` 면 멈춘다
2. 확인: `bin/athena pack list` → acme ▶(이 본체) · globex(본체 없음)
3. 열기: `bin/athena pack open globex` → `<테스트 본체>-globex` 가 생기고 포트 4702. `cd <테스트 본체>-globex && bin/athena pack use globex --contract 2 --start-board` → 현황판 http://localhost:4702 에 globex 샘플만. 테스트 본체 현황판(4710)은 acme 그대로
4. 동시에: 한 터미널에서 `cd <테스트 본체>-globex && claude` 를 켜 둔 채 `bin/athena pack list` → globex `bodyBusy` · acme 는 비어 있음 · acme 쪽 작업·열기는 그대로 된다
5. 업데이트: 다른 clone 에서 코어에 커밋을 만들고 번들로(`git -C <그 clone> bundle create /tmp/core.bundle main`) `bin/athena update --from /tmp/core.bundle` → claude 가 도는 globex 는 `skipped(busy)`, 나머지는 새 커밋. claude 를 끄고 `bin/athena pack open globex` → 따라잡음. `bin/athena update --rollback` → 그 업데이트가 바꾼 본체만 되돌림
6. 스튜디오: 앱을 `ATHENA_STUDIO_HOME=<임시 폴더>` 로 띄우면 스튜디오 집(코어·본체·데이터·데몬 접속 파일)을 통째로 따로 쓴다 — 창마다 팩(약속 5.7)
7. 끝나면: `bin/athena pack discard <빈 자리>` 로 빈 자리를 지우거나, 본체째 지운다(`git -C <테스트 본체> worktree remove --force <테스트 본체>-globex` · `rm -rf /tmp/athena-test-data`)

- 일부러 실패시키기: `ATHENA_PACK_FAIL_AT=open bin/athena pack new` → `rollback` 과 함께 만들던 본체·자리 없음 · `ATHENA_RELINK_FAIL_AT=<커밋> bin/athena update --from <번들>` → 그 커밋으로 옮긴 본체마다 `rolledBack`
- 테스트 본체에서 `athena pack check` 는 테스트 팩의 names 로 검사하고 `test/fixtures/` 는 뺀다
- **금지**: 테스트 중 `~/.athena-studio` 의 설정·링크·`plans/`·`issues/` 를 바꾸지 않는다. 스튜디오 본체에서 `pack open`·`update` 를 시험 삼아 돌리지 않는다(진짜 워크트리·업데이트). `pack migrate` 는 옛 본체를 **복사한** 폴더에서만 시험한다(`test/packs-test.sh` 는 합성 옛 본체로)

## pack.json

```jsonc
{
  "formatVersion": 1,                     // 팩 형식 버전 — 이 코어가 모르는 버전이면 가져오기·열기를 멈춘다(scripts/lib/config.mjs PACK_FORMAT_VERSION)
  "id": "acme-5f0c1a2b",                  // 공유 ID(packId) — 복사한 팩끼리 같다. 없으면 가져오기·옮기기가 붙인다
  "name": "acme",                         // 바꾸지 않는다 — 가져오기 때 같은 팩 판단에 쓴다
  "displayName": "Acme 쇼핑팀",            // 화면 표시 이름(1~40자 · 줄바꿈 없음 · 화면은 displayName ?? name) — bin/athena pack set-name
  "icon": "assets/icon.png",              // 팩 아이콘 — 늘 assets/icon.<png|jpg|webp>(png·jpeg·webp 만 · 1MB 이하 · SVG·GIF 안 됨) — bin/athena pack set-icon
  "names": ["acme", "에이크미"],          // pack check 가 코어에서 찾을 회사 이름
  "github": { "org": "acme-inc" },        // PR 조회·링크 판별
  "trackedDeps": ["^@acme/"],             // 지문에 버전을 남길 사내 패키지(정규식)
  "worktreeCopy": { "include": [".env", ".env.*"] },
  "qa": { "apps": { "shop-web": "쇼핑" }, "ownHosts": ["acme.com"], "iconFont": "", "exampleUrl": "https://dev.acme.com" },   // apps 는 화면에 보일 이름표만(없어도 된다)
  "derived": { "servicesColumns": ["…"], "playbookOrder": ["…"] },   // 없으면 설정 순서
  "hooks": { "delegateEnv": "hooks/delegate-env.sh" },
  "repos": [
    { "name": "admin-web", "agents": ["admin-fe"], "branch": "prd", "prBase": "dev", "kind": "single", "appDir": "app",
      "remote": "git@github.com:acme-inc/admin-web.git",   // (선택) git 주소 — 폴더 이름이 달라도 이 주소로 레포를 찾는다. athena init 이 적고, 내보내기 · 백업 사본에 채운다
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
