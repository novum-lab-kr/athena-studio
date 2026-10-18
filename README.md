# Athena — 프론트·백엔드 에이전트 팀 워크스페이스

Claude Code 위에 만든 **프론트엔드 멀티 레포 팀 리드**. 이 폴더에서 `claude` 를 켜면 **아테나**가 되어, 요청을 받아 어느 레포 일인지 고르고 → 계획서를 쓰고 → 담당 FE 에이전트에게 맡기고 → 리뷰까지 받아 보고한다.

> 처음이면 **`ONBOARDING.md`**(화면: `/guide 시작하기`) · 그림으로 보는 사용법은 `docs/playbook.html`(`/guide 열기`)
> Nous Research 의 오픈소스 Hermes Agent 와는 다른 것이다(예전 이름 "헤르메스"가 같았을 뿐) — 따로 설치하지 않는다.

## 한눈에

```
 사용자: "결제 페이지 프로모션 배너 고쳐줘"
   │
   ▼
 [아테나]
   ① 어느 레포?  회사 팩 라우팅(pack/ROUTING.md) · 애매하면 되묻기
   ② 계획서      경량(바로 진행) / 정식(결정 콘솔 → [이대로 진행])
   ③ 브랜치      prBase 에서 워크트리 .worktrees/<레포>/<브랜치>
   │
   ▼
 [담당 에이전트 · 옆 pane]
   작업 → 검증 → 자동 리뷰 → "커밋해줘" → "PR 올려줘"
   │                                        │
   │ 작업 끝·교정·같은 오류 3회               │ PR 머지
   │                                        ▼
   │                               [배우기 검토자]
   ▼                                        │
 학습 후보 ◀────────────────────────────────┘
   │
   ▼
 [현황판 /board]  서비스 · 정비 · QA · 학습 · 아카이브
   │
   └─ [학습] 탭에서 [넣기] → 레포 공책(gotchas.md) → 다음 작업이 읽는다
```

## 팀

| 에이전트 | 담당 레포 | 서비스 |
|---|---|---|
| 레포 담당 에이전트 | 회사 팩 `pack.json` 의 레포마다(모노레포는 앱마다) | 회사 팩 `pack/ROUTING.md` "에이전트" 표 |
| `reviewer` | 전체 (읽기 전용) | 계획서 대비 검증 · 교차 정합성 |
| `learn-reviewer` | 끝난 작업 (읽기 전용) | 배우기 검토자 — 직접 부르지 않음, 내 PR 이 머지되면 돈다 |

**코어와 회사 팩.** 이 레포(코어)는 흐름·훅·현황판·학습 루프·공통 규칙만 갖고 회사 이름을 모른다. 레포 목록·에이전트·레포 지식·검증 스크립트·라우팅은 **회사 팩**(`packs/<회사>/`, 별도 레포)에 있고 `athena pack link` 가 코어의 정해진 자리에 링크로 건다. 레포 목록·기준 브랜치의 정본은 팩의 `pack.json`. 레포는 `repos/<레포>` 링크로 접근하고, `claude` 를 켤 때 옆 폴더에서 알아서 연결한다.

## 시작하기

```bash
git clone <코어 레포 주소> athena && cd athena
git clone <회사 팩 레포 주소> packs/<회사>      # 팩이 있는 회사 — 없으면 건너뛰고 claude 에서 /setup
echo '{ "pack": "packs/<회사>", "reposRoot": ".." }' > athena.config.json
bin/athena pack link                            # 팩 파일을 코어 자리에 링크로
claude              # (또는 codex) herdr 안이면 화면 세팅 → 팩이 없으면 첫 실행(/setup)이 저절로 시작된다 · 레포 연결도 자동
```

| 이렇게 하면 | 일어나는 일 |
|---|---|
| 그냥 말하기 — "목록 페이지네이션 버그 원인 찾아줘" | 아테나가 라우팅 → 계획서 → 디스패치 → 리뷰 → 보고 |
| `/setup` | 새 회사 첫 실행 — 레포 찾기 → 팩 만들기 → 에이전트·지식 뼈대 → 서비스 문서 → QA 초안 → 검증 → 지문 → 다이어그램 (팩이 없으면 herdr 에서 켤 때 저절로 시작된다) |
| `/call <에이전트>` | 담당 에이전트를 pane 에 바로. 요청·"커밋해줘"·"PR 올려줘" 까지 그 pane 에서 |
| `/board` | 현황판(`localhost:4700`) — 서비스 · 정비 · QA · 학습 · 아카이브 |
| `/guide` | 가이드 메뉴 — 구조 설명 · 시작하기 · 플레이북 · 다이어그램 · 확장 가이드 · 스킬 · 에이전트·라우팅 |
| `/monitor` | 백그라운드·pane 에이전트 로그 실시간 |
| `/sync` | 운영 브랜치를 읽어 지식 문서 갱신 (가끔, 한 사람이) |
| `/diagram` | 서비스 다이어그램 다시 그리기 |
| (회사 스킬) | 팩 `pack/ROUTING.md` "회사 스킬" |
| "현황 알려줘" · "리뷰해줘" · "○○ 전체 검수 돌려줘" | 말로 하는 것 |

## 학습

```
 작업한 에이전트 ── 작업 끝 · 교정 · 같은 오류 3회 ──┐
                                                  ├─▶ 학습 후보
 배우기 검토자 ──── 내 PR 머지 뒤                  │      │
                  (계획서·대화·바뀐 코드·리뷰 댓글) ┘      ▼
                                         현황판 [학습] 탭 — 사람이 [넣기]
                                                  │
                                                  ▼
                   레포 공책 gotchas.md (회사 팩 레포 — git 으로 팀 공유)
                                                  │
                                                  ▼
                                       다음 작업이 시작 전에 읽는다
```

다시 마주치고 · 모르면 실제로 잘못되고 · 코드만 봐서는 모르는 **코드 함정**만, 근거가 코드·실행 결과일 때만. 취향은 공용 공책에 넣지 않는다(Claude 메모리 몫). 기준 정본 `docs/knowledge/common/learning.md` · 채점 `node scripts/learn-eval.mjs`

## 구조

코어(이 레포)와 회사 팩(`packs/<회사>/`, 별도 레포)으로 나뉜다. 팩 파일은 `bin/athena pack link` 가 코어의 정해진 자리에 **링크**로 건다 — 아래 "(팩)" 표시가 그런 자리다. 팩 형식은 `docs/pack.md`.

```
athena/                        ← 코어
├── AGENTS.md                  공통 규칙·지식 진입점 (Codex 등 다른 도구도 읽는다)
├── CLAUDE.md                  Claude Code 전용 — 아테나 역할 · 흐름 · 스킬. 회사 라우팅은 @pack/ROUTING.md 로 불러온다
├── ONBOARDING.md              시작하기 가이드
├── athena.config.example.json 이 컴퓨터 설정 예시 → athena.config.json 으로 복사(git 무시) — 팩 위치 · reposRoot
├── bin/athena                 init(레포 찾기·팩 만들기) · scaffold(뼈대) · pack link · pack check
│
├── .claude/
│   ├── agents/                reviewer · learn-reviewer + 레포 담당 에이전트(팩)
│   ├── rules/                 언어 · 코드 · Git · 디스패치 규칙
│   └── skills/                /setup /call /board /sync /diagram /guide /monitor + 회사 스킬(팩)
│
├── docs/
│   ├── knowledge/             지식 노트 — 에이전트가 일할 때 읽는다
│   │   ├── common/            팀 공통 (coding · git · verify · reporting · learning)
│   │   ├── athena/            아테나 자체 함정 공책
│   │   └── <레포>/ · company/ · learned/   레포 지식 · 회사 관례 · 학습 기록(팩)
│   ├── athena-explained.html  아테나 구조 설명 (/guide 설명 — 팩 판이 있으면 그것)
│   ├── playbook.html          그림으로 보는 사용법 (/guide 열기 — 팩 판이 있으면 그것)
│   ├── onboarding.html        시작하기 화면 (/guide 시작하기)
│   ├── diagrams/              작업 흐름 그림 + 서비스 다이어그램(팩) (/guide 그림)
│   ├── templates/pack/        새 회사 뼈대 템플릿 — 에이전트 · rules · structure · gotchas · verify
│   ├── pack.md                회사 팩 형식 · 여러 팩 · 여러 팩 테스트
│   ├── issues.md              이슈 등록 기준 · 형식 · 완료 기준
│   ├── extending.md           스킬·에이전트 추가 방법
│   └── plan-template*         계획서 템플릿 (정식 md + 결정 콘솔 html · 경량 md)
│
├── plans/                     작업계획서 — 각자 로컬 (git 에 안 올라감 · 형식 docs/plan-template*)
├── issues/                    이슈·학습 후보 — 각자 로컬 (git 에 안 올라감 · 형식 docs/issues.md)
├── repos/                     담당 레포 링크 (각자 로컬, scripts/setup.sh)
├── packs/<회사>/              (옛 구조) 회사 팩 레포 클론 (git 무시) — pack 링크가 가리킨다
├── .pack-data → ~/athena-data/packs/<id>   (여러 팩 구조) 지금 팩 — pack·plans·issues·repos 는 이 아래를 가리키는 링크 (docs/pack.md "여러 팩")
├── test/                      여러 팩 시험(packs-test.sh) · fixture 팩(acme·globex)
│
└── scripts/
    ├── 작업 흐름
    │   ├── new-plan.mjs · plan-html.mjs   계획서 만들기 · 결정 콘솔
    │   ├── new-branch.sh                  작업 브랜치·워크트리 (+ wt-copy-local.sh)
    │   ├── delegate.sh                    에이전트를 pane 에 띄우기
    │   ├── commit.sh · ship.sh            "커밋해줘" · "PR 올려줘"
    │   ├── review-result.sh               reviewer 결론 기록
    │   └── heavy.sh                       무거운 명령 한 번에 하나씩
    ├── 검증 · QA
    │   ├── verify/_lib.sh · _nest.sh · _generic.sh   검증 공용(표 형식 · NestJS · 새 레포 기본)
    │   ├── verify/<레포>.sh               레포별 표준 검증(팩)
    │   └── qa/                            QA 시뮬레이션 (Playwright) — 화면 목록·씬은 팩
    ├── 현황판 · 화면
    │   ├── board.sh · board/              현황판 서버·화면 (/board)
    │   ├── guide-menu.sh · guide-pane.sh  가이드 메뉴 (/guide)
    │   ├── athena-up.sh · athena-layout.sh  athena workspace 고정 배치 — 세션 시작 때 도구 pane 띄우고 정리 · 사이드바 패치판
    │   ├── monitor-pane.sh · agent-monitor.py  로그 모니터 (/monitor)
    │   ├── screen · lib/screen.py · lib/screen.mjs  화면 계층 — pane·탭·workspace 는 여기로만 (지금 백엔드 herdr · ATHENA_SCREEN)
    │   ├── screen-lint.sh · screen-check/  화면 계층 지킴이 · 가짜 herdr 회귀 검사
    │   ├── herdr-sidebar-patch.sh · -build-bin.sh · -reopen.sh · -ensure.sh  herdr-sidebar 패치판 설치·빌드·Explorer 다시 띄우기 (patches/herdr-sidebar)
    │   └── statusline.sh · mdview.py      상태바 · 터미널 마크다운 뷰어
    ├── 학습
    │   ├── learn-review.mjs (+ -pane.sh)  배우기 검토자 — 머지된 내 PR 로 학습 후보
    │   ├── learn-curator.mjs              30일 안 쓴 스킬 정리 후보 (/sync 끝)
    │   ├── gotchas-check.mjs              낡은 공책 줄 · 나눌 때가 된 공책 정리 후보 (/sync 끝)
    │   └── learn-eval.mjs                 학습 품질 채점 (정답지는 팩)
    ├── 지식 문서
    │   ├── sync-fingerprint.mjs           /sync — 운영 브랜치 지문 (기준은 .sync — 팩)
    │   ├── build-derived.mjs              지문 → 팩의 서비스 맵·플레이북 표
    │   └── check-diagrams.mjs · build-diagram-index.mjs · diagram-coverage.mjs
    ├── lib/                               설정 읽기(코어 + 팩 합치기) · 팩 링크 너머 git · init·scaffold
    ├── athena.mjs                         bin/athena 본체
    ├── hooks/                             시작 점검(팩 없으면 /setup 안내) · workspace 배치 · 커밋·push 보호 · 비밀값 노출 막기 · 대화 압축 전후 계획서 저장
    └── setup.sh · archive-plans.sh · agent-context.py · branch-candidates.sh
```

회사 팩(`packs/<회사>/`, 별도 레포):

```
packs/<회사>/
├── pack.json        레포 목록 · 브랜치 · 에이전트 · 회사 값(GitHub 조직·QA·PR 범위 …)
├── ROUTING.md       담당 레포·에이전트 표 · 라우팅 규칙 · 검증 명령 · 회사 스킬
├── agents/ skills/ knowledge/ verify/ diagrams/ docs/ qa/ sync/ archive/
├── guide/           회사 판 안내 HTML (있으면 /guide 가 이걸 연다)
└── hooks/           (선택) delegate.sh 에 넣을 환경값
```

## 확장하기

| 추가할 것 | 방법 |
|---|---|
| 스킬 | `.claude/skills/<이름>/SKILL.md` — 만들면 `/<이름>` 으로 바로 뜬다 (`call/SKILL.md` 를 복사해 시작) |
| 에이전트 | 레포 담당은 회사 팩 `agents/<이름>.md`(+ `pack.json` 에 레포·에이전트) — 새 레포면 `bin/athena scaffold`. `description` 이 라우팅 문장. 안에 `: `(콜론+공백)를 쓰면 YAML 이 깨진다 |
| 같이 고칠 곳 | `CLAUDE.md` 표 · `AGENTS.md` · 이 README · `docs/playbook.html` — 아테나에게 "방금 추가한 거 문서에도 반영해줘" |

상세: `docs/extending.md`
