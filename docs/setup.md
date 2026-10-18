# 새 회사 첫 실행 (정본 — 도구 무관)

아테나 폴더에서 Claude Code 든 Codex 든 처음 켰는데 **회사 팩이 없으면**(`athena.config.json` 이 없거나 `pack` 이 없거나, 팩 `pack.json` 의 `repos` 가 비었으면) 이 절차를 돈다.
- **herdr 에서 athena 폴더로 `claude`·`codex` 를 켜기만 하면 된다** — 세션 시작 훅이 화면을 세팅하고(`scripts/hooks/workspace-up.py` → `athena-up.sh`), 끝나면 그 pane 에 첫 실행 지시를 대신 입력한다(Claude `/setup` · Codex "docs/setup.md 절차를 0단계부터"). 에이전트가 입력을 기다릴 때(herdr `agent_status` idle)만, 새로 켠 세션에서만 보내고, 사용자가 먼저 말을 걸었으면 보내지 않는다(결과는 `$TMPDIR/hermes-up.log`)
- Claude Code: 훅은 `.claude/settings.json`, 안내는 `scripts/hooks/setup-check.py`, `/setup` 스킬이 이 문서를 따른다
- Codex: 훅은 `.codex/hooks.json`(같은 스크립트를 `--tool codex` 로 — 처음 켤 때 폴더·훅을 믿을지 한 번 묻는다). 훅이 안 돌면 `AGENTS.md` 맨 앞 "첫 실행" 이 이 문서로 보낸다
- herdr 밖이면 화면 세팅·자동 입력 없이 안내만 한다 — 아무 말이나 입력하면 시작한다
- 바깥 도구가 띄운 창(환경 변수 `ATHENA_AGENT` 가 있음 — 예: 서버의 관리 창)에서는 돌지 않는다

레포 폴더: 사용자가 준 폴더(없으면 `athena.config.json` 의 `reposRoot`, 그것도 없으면 `..`)

**도구마다 다른 것**
| | Claude Code | 위임 기능이 없는 도구(Codex 등) |
|---|---|---|
| 사용자에게 묻기 | AskUserQuestion(한 번에 최대 4문항, 선택지) | 대화로 묻는다 — 같은 질문·선택지를 번호로 보여 주고 답을 기다린다 |
| 5단계 레포별 작업자 | Agent 도구 `general-purpose` 백그라운드, 한 번에 최대 5개 · `/monitor` 로 보이게 | 레포를 하나씩 직접 읽어 채운다(작업자 지시를 자기 할 일로) |
| 7-1단계 다이어그램 | `/diagram` | `.claude/skills/diagram/SKILL.md` 절차를 직접 따른다 |

기계적인 일은 `bin/athena` 가, 코드를 읽고 판단하는 일은 아테나(와 작업자)가 한다. 환경 설정이라 계획서 없이 진행하고, 끝에 보고한다. **레포는 읽기만 한다**(fetch·체크아웃·설치도 사용자에게 묻고). 비밀값은 출력하지 않는다.

## 0. 이미 팩이 있는 회사인가
**여러 팩 구조**(본체에 활성 링크 `.pack-data` 가 있다 — `docs/pack.md` "여러 팩")면 먼저 `bin/athena pack status --json` 을 본다. `current.empty: true` 는 `pack new` 로 만든 **빈 팩 자리**다 — 이 /setup 이 그 자리에 팩을 만든다(3단계 `athena init` 이 `pack/`·`<팩 데이터>/local.json` 에 쓰고 자리 이름을 회사 이름으로 바꾼다).
- **빈 팩 자리면 0단계를 건너뛴다** — `pack new` 는 "새로 만들기" 를 고른 뒤에만 불린다(스튜디오 [새로 만들기] · CLI). 이미 있는 팩은 스튜디오 [가져오기]·`pack inspect`/`pack import` 가 맡는다. 1단계부터
- 취소하려면(사용자가 그만두면) `bin/athena pack use <previous>` — 빈 자리는 다음 바꾸기 때 지워진다. previous 는 `pack new` 결과에 있다(모르면 `pack list`)

사용자에게 묻는다 — "회사 팩 레포가 이미 있나요?" · 선택지 `있다 — 주소 입력`(clone 주소를 받는다) / `없다 — 새로 만든다`.
- 있다(옛 구조): `git clone <주소> packs/<회사>` → `athena.config.json` 에 `{ "pack": "packs/<회사>", "reposRoot": ".." }` → `bin/athena pack link` → `scripts/setup.sh`(repos/ 링크) → 6단계(검증) → 7-2단계(Jev 키) → 보고하고 끝
- 있다(여러 팩 구조): `bin/athena pack inspect <주소> --json` → `bin/athena pack import <token> --new` → `bin/athena pack use <id>` → `scripts/setup.sh --links-only` → 6단계 → 7-2단계 → 보고하고 끝

## 1. 레포 찾기
`bin/athena init --scan [--root <폴더>] [--depth <n>]` — 표를 그대로 보여 준다. 레포 폴더 아래 3단계(팀·회사 폴더로 묶여 있어도)까지 찾고, 같은 레포의 워크트리는 하나로 친다. 이름이 겹치면 위 폴더 이름을 붙인다(`teamA-web`). 추정(종류 single·monorepo·packages · 층 fe·be · 기준 브랜치 · 작업 base · 앱별 브랜치 · GitHub 조직)이다. 바로 아래가 아닌 레포의 위치는 3단계가 이 컴퓨터 설정(`athena.config.json` `repoPaths`)에 적는다.

## 2. 사용자 확인
- **넣을 레포** — 찾은 레포를 **전부, 찾은 순서 그대로** 보여 주고 사용자가 고른다. 아테나가 미리 빼거나(아테나 복사본·연구용 등) 추천하지 않는다 — 맨 위 "전체" 로 모두 고를 수 있다(사용자 결정 2026-10-17: 질문 창 4칸에 맞춰 아테나가 갈라 보여 주던 것을 없앴다)
  - `node scripts/setup-pick.mjs [--root <폴더>] [--depth <n>]` — 고르기 콘솔(`plans/setup/<날짜>-첫-실행-레포-고르기.md` + html, 체크박스 · 맨 위 "전체 (N개)")을 만든다 → `scripts/board.sh open <md>` 로 연다. 대화에는 "레포 N개를 콘솔에 띄웠다" 한 줄만
  - 사용자가 고르고 [이대로 진행] 을 누르면 이 pane 에 `1. 넣을 레포: a, b, …` 가 들어온다("전체 (N개)" 가 있으면 전부). 현황판이 안 떠 있으면 콘솔이 [프롬프트로 복사] 로 바뀐다 — 사용자가 붙여 넣는다
  - 대화로만 묻는 도구(Codex 등)는 같은 목록을 번호로 **전부** 보여 주고 "번호들 또는 전체" 로 받는다
- 나머지는 한 번에 최대 4문항으로 묻는다
- **회사 이름**(팩 폴더 이름, 영문 소문자) · **회사를 가리키는 말**(names — 서비스·브랜드 이름, `pack check` 가 코어에서 찾는다)
- **추정이 틀린 레포** — 기준 브랜치(운영 반영분)·작업 base(PR 대상)·종류·층. 고칠 게 있으면 그 레포만 다시 묻는다
- **에이전트 이름** — 기본은 `<레포>-fe|be`, 모노레포는 `<앱>-fe` + `<레포>-packages-fe`. 바꾸려면 `--agent <레포>=<이름>` · `--agent <레포>/<앱>=<이름>`

## 3. 팩 만들기
`bin/athena init --pack <회사> --repos <a,b,…> [--names <x,y>] [--org <조직>] [--agent …]` → `packs/<회사>/pack.json`·`ROUTING.md`·`athena.config.json`·링크(여러 팩 구조면 지금 팩 자리 `pack/`·`<팩 데이터>/local.json` — pack.json 에 `formatVersion`·`id` 도 쓴다). 추정을 고쳤으면 `packs/<회사>/pack.json` 해당 레포를 직접 고친다(형식 `docs/pack.md`). 그다음 `scripts/setup.sh`(repos/ 링크).

## 4. 뼈대
`bin/athena scaffold` — 레포마다 `agents/<에이전트>.md` · `knowledge/<레포>/{rules,structure,gotchas}.md` · `verify/<레포>.sh`(코어 `_generic.sh` 호출), 팩 하나에 `docs/services.md`(서비스 소개 · 스택 표 자리) · `diagrams/SERVICES.md`(/diagram 서비스 표) · `diagrams/index.json`(다이어그램 목록 카드). 있는 파일은 건드리지 않는다.

## 5. 뼈대 채우기 (레포마다 작업자 하나 — 위 표)
작업자 지시(레포마다 같은 틀):
- 대상: `repos/<레포>`(모노레포 앱은 `apps/<앱>`)를 **운영 기준 ref**(`git show origin/<branch>:<경로>` · `git ls-tree`)로 읽는다. 메인 체크아웃은 브랜치가 제각각이라 읽지 않는다. 쓰지 않는다
- 채울 것: 에이전트 `description`(어떤 요청이면 이 에이전트인지 — 화면·도메인 키워드 한 문장, **콜론+공백 금지**) · `rules.md` "필수"(금지·용어·생성물) · `structure.md`(스택·디렉토리·라우트·스크립트) · 레포 원문(`README`·`CLAUDE.md`·`AGENTS.md`) 요약. **확인 안 된 것은 "확인 필요"로 남긴다** — 추측을 사실로 쓰지 않는다
- `patterns.md`·`workflows.md` 는 만들지 않는다(그 레포를 처음 작업할 때 채운다)
- 레포 고유 검증이 필요하면(`_generic.sh` 로 부족) `verify/<레포>.sh` 를 `_lib.sh` 로 다시 쓴다
- 보고: 채운 파일 · "확인 필요" 목록 · **서비스 소개**(서비스(앱)마다 "무엇을 하나" 한 줄 · 주요 화면·API 3~5개와 근거 파일) — services.md 는 작업자가 쓰지 않는다(여럿이 한 파일을 덮지 않게)
그다음 아테나가
- `ROUTING.md` "어느 레포인지 고르기"(요청 말 → 레포)를 채운다. 같은 말이 여러 레포를 가리키면 "되묻는다"로 적는다
- `docs/services.md` "서비스 소개" 표의 "확인 필요" 칸을 작업자 보고로 채운다(근거 없는 칸은 그대로). "스택 (자동)" 구간은 손대지 않는다 — 7단계 `build-derived` 가 채운다

## 5-1. QA 초안
`node scripts/qa/init-app.mjs --all` — 등록한 화면 레포의 앱마다(단일 레포 = 앱 하나, 모노레포 = 앱마다, 백엔드·패키지·Next 아닌 앱은 건너뜀) 운영 기준 ref 의 화면 목록을 읽어 팩 `qa/routes/<앱>.json`(QA 설정 초안)과 `qa/docs/tc/<앱>.md`(화면마다 스모크 TC)를 만들고 링크한다. 있는 파일은 덮지 않는다. 출력의 "확인 필요"(로그인 쿠키 `server.tokenCookie` · `devUrl` · 로그인 경로 · dev 전 준비 스크립트 · 동적 화면 samples)는 5단계 작업자가 읽은 코드로 채울 수 있으면 채우고(근거 파일을 적는다), 아니면 그대로 보고에 남긴다 — 형식 `docs/knowledge/common/verify.md` "앱 설정"

## 6. 검증 한 번
레포마다 `scripts/verify/<레포>.sh [<앱>]`(무거우니 `heavy.sh` 가 줄 세운다) — 결과 표를 그대로 모아 보여 준다. ❌·⏭ 은 통과로 치지 않고 "확인 필요"(설치 안 됨·스크립트 없음 등)로 남긴다. 설치는 사용자에게 묻고 한다.

## 7. 지문 기준선
`node scripts/sync-fingerprint.mjs`(fetch 한다 — 사용자에게 한 줄 알린다) → 리포트 확인 → `node scripts/sync-fingerprint.mjs --accept` → `node scripts/build-derived.mjs`(`docs/services.md` 스택 표가 채워진다). 이후는 평소 `/sync`(`.claude/skills/sync/SKILL.md`).

## 7-1. 레포별 다이어그램
사용자에게 묻는다 — "서비스 다이어그램(구조 · 화면 맵 · 요청 흐름)을 지금 그릴까요?" · 선택지 `지금 그린다 (추천)`(description: 서비스 N개 · 작업자 5개씩 · 서비스마다 수 분~수십 분(추측)) / `나중에`(description: 언제든 /diagram).
- 지금: 다이어그램 절차(`.claude/skills/diagram/SKILL.md` — Claude Code 는 `/diagram`)를 전체 대상으로 그대로 돈다 — 서비스 표는 4단계가 만든 `docs/diagrams/SERVICES.md`, 가이드(`guides/<서비스>.md`)는 작업자가 처음 그리며 만든다. 끝나면 `node scripts/build-diagram-index.mjs`
- 나중에: 보고의 "다음" 에 다이어그램(`/diagram`)을 적는다

## 7-2. (선택) Jev 키 — 사람마다 본인 키
Jev(TypeSafe 의 판정 모델)는 QA 실패 원인 추정 · 학습 후보 중복 자동 버리기 · 배우기 검토 나란히 판정에 쓴다(`docs/knowledge/common/learning.md` 6절). **없어도 그대로 돈다.** 유료라 키는 사람마다 본인 것(사용량은 키 주인에게 청구 · 나눠 쓰지 않는다).
사용자에게 묻는다 — "TypeSafe Jev 키가 있나요?" · 선택지 `있다 — 지금 등록`(description: 옆에 뜨는 입력 창에 직접 붙여 넣는다 · 대화창에는 넣지 않는다) / `없다 · 나중에`(description: 없어도 그대로 돈다 · 키가 생기면 "Jev 키 등록해줘").
- 있다: **키를 대화로 받지 않는다.** herdr 면 `scripts/screen pane split --target focused --direction down --cwd <athena> --format id` 로 입력 창을 열고(나온 pane id) `scripts/screen pane run <id> node scripts/jev-key.mjs` — 사용자가 그 창에 붙여 넣고 Enter. 맞는 키인지 그 자리에서 확인하고(틀리면 저장 안 함) `~/.config/athena/typesafe.key`(이 컴퓨터에만 · 권한 600)에 저장한다. 끝나면 `node scripts/jev-key.mjs --status` 로 **있는지·길이만** 확인하고 그 창을 닫는다(`scripts/screen pane close <id>`). herdr 밖이면 새 터미널에서 `node scripts/jev-key.mjs` 를 직접 돌리라고 안내한다
- 사용자가 키를 대화창에 붙여 넣었으면 노출로 본다 — 그 값은 쓰지 않고, 콘솔에서 폐기·재발급한 뒤 입력 창으로 다시 넣자고 알린다(AGENTS.md 5절)
- 나중에 — **"Jev 키 등록해줘"·"Jev 키 바꿔줘"** 도 이 절 그대로(새 키를 넣으면 덮어쓴다). "Jev 키 지워줘" 는 `node scripts/jev-key.mjs --remove`. 등록·지우기는 현황판·배우기 검토를 다시 켜지 않아도 다음 판정부터 먹는다. 환경 변수 `TYPESAFE_API_KEY` 가 있으면 그게 먼저다

## 8. 마무리 보고
- 만든 것: 팩 경로 · 레포·에이전트 표 · 파일 수 · 서비스 문서(`docs/services.md` — 채운 칸·남은 "확인 필요") · 다이어그램(그린 서비스·장 수, 미뤘으면 미룸) · Jev 키(등록함 / 나중에 — "Jev 키 등록해줘")
- 검증 표 · "확인 필요" 목록(레포별) · QA 초안(앱별 화면 수 · 남은 `$todo`)
- 다음: `bin/athena pack check`(코어에 회사 이름이 새지 않았는지) · 팩을 팀과 나누려면 `packs/<회사>` 를 별도 레포로 push(사용자가) · 첫 작업은 평소처럼 말로
