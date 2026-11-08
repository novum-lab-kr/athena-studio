# 규칙을 무엇이 지키나

`AGENTS.md` 5절 규칙마다 기계(훅 · 스크립트)가 막는지, 글로만 지키는지 적은 표다. 규칙의 정본은 `AGENTS.md` 이고 여기는 "어디서 막히나" 만 본다.
훅은 모두 실수 방지용이지 보안 경계가 아니다 — 스크립트 파일 안의 명령 · 일부러 꼬아 쓴 셸 문법은 보지 않는다(각 훅 머리 주석).

훅이 걸리는 곳
- 아테나 세션 — Claude `.claude/settings.json` · Codex `.codex/hooks.json`(`/hooks` 에서 믿음 표시해야 돈다)
- 위임 에이전트 — `scripts/lib/agent_hooks.py` 한 곳(`delegate.sh` · `agent-context.py` 가 같이 쓴다). reviewer 는 `secret-guard` · `process-guard` · `server-guard` · 권한 확인 알림만

## 표

| 5절 규칙 | 무엇이 지키나 | 기계가 못 보는 것(글만) |
|---|---|---|
| 바꾸는 작업은 계획서 하나에 | `commit.sh` — `--plan` 이 `plans/…md` 로 있어야 커밋하고 `## Commits` 에 적는다 | 커밋 전 작업 · 계획서 내용 |
| 새 작업 브랜치에서 시작 | `commit.sh` · `ship.sh` — 메인 체크아웃 · detached · 보호 브랜치(dev · main · master · stg · frz · prd* · release/* · dev-*)면 거부(`--allow-main-checkout` · main 직접 레포 예외). stash · `reset --hard` 는 `commit-guard.py` | 브랜치를 어디서 땄는지 |
| 담당 범위 밖 수정 금지 | `commit.sh` — 지정 파일이 `--dir` 워크트리 안인지. `ship.sh` — 레포 하나짜리 계획서만 | 다른 레포 파일을 고치는 것 자체 |
| 버그 수정 — 재현 먼저 | 없음 | 글만 |
| 해석이 여러 개면 좁히고 묻기 | 없음 | 글만 |
| 추측 금지 · 돌려 보면 아는 것은 묻지 않기 | 물을 때의 길만 — `ask-to-request.py`(고르기 질문 → 요청 · 위임 에이전트는 늘 · 아테나는 pane 을 안 볼 때) | 추측 · 물을지 말지 판단 |
| 작은 변경 · 범위 밖 정리 금지 | 없음 | 글만 |
| 생성물 직접 편집 금지 | 없음 | 글만 |
| 무거운 명령은 `heavy.sh` 로 | 검증 스크립트 · `commit.sh` 는 스스로 줄을 선다(`heavy.sh` 잠금) | 에이전트가 직접 치는 install · build · test |
| 멈춘 명령은 pid 로만 끄기 | `process-guard.py` — pkill · killall · 0 · 음수 대상 kill · 이름으로 찾은 pid kill | 스크립트 안 · timeout/find -exec 로 감싼 kill |
| 커밋은 `commit.sh` 로만 | `commit-guard.py`(위임 에이전트만) — git commit · `add -A` · merge · revert · stash · `reset --hard` · rebase … | 아테나 세션 · "사용자가 요청할 때만" |
| push · PR 은 `ship.sh` 로만 | `commit-guard.py`(위임 에이전트만) — git push · gh pr 쓰기 · gh api 쓰기 · `--repo-agent`. `ship.sh` — 미커밋 없음 · `commit.sh` 로 기록된 커밋만 | "PR 올려줘 할 때만"(`--user-pr` 도 말한 출처를 증명하지 못한다) |
| 비밀값 노출 금지 | `secret-guard.py`(모든 세션) — 설정 출력 · 비밀 파일 읽기 · 환경 통째 출력 · 토큰 변수 echo · 자격 증명 꺼내기 · 프로세스 전체 인자. `commit.sh` — 비밀 파일 이름 · 내용(개인키 · `.npmrc` 글자 그대로 토큰) 커밋 거부 | 로그 · 보고 · 계획서 · 커밋 메시지에 쓰는 것 |
| 서버는 허용 목록만 자유(팩에 `servers` 가 있을 때 · `docs/setup.md` "서버 하나 더하기") | `server-guard.py`(모든 세션) — 등록한 별칭으로 바로 가는 ssh · scp · rsync · sftp · 명령 안에서 `ssh-run.sh` 시험용 값 정하기. `scripts/ssh-run.sh` — 허용 목록(`scripts/lib/server_allow.py`) 밖 명령 · 모든 `--put` 은 확인 요청을 열고 멈춘다(승인 = 같은 키 · 답 `실행` · 60분) · 비밀 파일 `--get`/`--put` 거부 | 스크립트 파일 안에서 ssh 를 부르는 것 · 허용 목록 명령의 출력에 비밀값이 섞이는 것 |
| 화면은 `scripts/screen` 으로만 | `scripts/screen-lint.sh` — 손으로 돌린다(검증 스크립트에 걸려 있지 않다) | 돌리지 않은 때 |

## 글로만 지키는 규칙이 또 어겨지면

"글만" 칸의 규칙이 반복해서 어겨지면(같은 종류로 두 번째 — 리뷰 지적 · 학습 후보 · 이슈에서 확인) 문서를 더 세게 쓰지 않고 **정비 후보**로 올린다 — 구조 → 훅 · 검증 스크립트 · lint → 테스트 순으로 가장 높은 층에서 막을 방법(형식 `learning.md` 1-2). 새 검사는 그 실수를 되살렸을 때 실제로 실패하는지 확인한다.
훅 · 스크립트가 막는 범위를 바꾸면 이 표도 같이 고친다.
