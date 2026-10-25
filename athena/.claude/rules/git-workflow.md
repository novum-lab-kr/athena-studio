# Git 규칙

- FE 에이전트는 사용자가 pane 에서 **"커밋해줘" 또는 "PR 올려줘" 라고 할 때만** `scripts/commit.sh` 로 로컬 커밋한다(지정 파일만·엄격 검증·계획서 `## Commits` 기록). 직접 `git commit`·`git add -A`, `revert`·`merge`·`cherry-pick`·`am`, `stash`·`reset --hard` 는 보호 훅이 막는다(필요하면 아테나 pane 에 이유와 함께 직접 요청한다 — `[<에이전트> → 아테나] …`. 사용자에게 대신 전해 달라고 하지 않는다)
- **push·PR 은 사용자가 "PR 올려줘" 라고 할 때 `scripts/ship.sh` 로만** 한다(직접 `git push`·`gh pr create` 는 보호 훅이 막는다). 레포 하나짜리 작업만 받고, **"PR 올려줘" 한 마디로 끝까지** — 커밋 안 된 작업은 `commit.sh` 로 먼저 커밋 → 미리보기 초안 → 작업 내용으로 제목·본문 정리 → 묻지 않고 `prBase` 로 draft PR(리뷰 승인 전이면 본문 "확인 필요"·보고에 적는다 · main 직접 레포 push 만 확인받는다). 여러 레포에 걸친 작업은 아테나가 순서를 정해 올린다(`ship.sh` 가 거부하면 에이전트가 아테나 pane 에 직접 요청)
- **끝나면 저절로 PR**(`"autoMerge": true` 레포의 레포 하나짜리 작업만 · 2026-10-25 결정): 에이전트가 요청을 끝내고 검증 스크립트가 통과하면 사용자 "PR 올려줘" 없이 같은 흐름(`commit.sh` → `ship.sh` 미리보기 → 제목 · 본문 정리 → draft PR)을 묻지 않고 돈다 — 이미 열린 PR 이 있으면 그 브랜치에 push 만. 조사만 했거나 바뀐 게 없으면 올리지 않고, 검증이 실패하면 올리지 않고 보고한다. 위임 지시문은 그 레포일 때만 이 문장을 싣는다(`delegate.sh`)
- 예외 하나 더 — **PR 자동 리뷰**(팩 레포 `"autoMerge": true` · 레포 하나짜리 PR 만): `[자동 리뷰 → <에이전트>]` 로 온 수정 지시는 묻지 않고 고쳐 `commit.sh` 로 커밋하고 `ship.sh --auto-push` 로 그 PR 브랜치에만 올린다. 머지는 자동 흐름이 사람의 [머지] 확인 뒤(레포가 `"autoMergeConfirm": false` 면 묻지 않고 바로) squash 로 한다 — 에이전트가 머지하지 않는다(`docs/pr-auto.md`)
- PR 제목 `type(범위): 티켓 요약`, 본문은 공통 템플릿 — 정본 `docs/knowledge/common/git.md` "PR 제목·본문"
- 작업 시작 전 `git status --short --branch`로 대상 레포의 기존 변경 사항을 확인하고, 사용자가 만든 변경과 무관한 파일은 건드리지 않는다
- 커밋 메시지는 한국어(Athena Studio 에서 고른 언어가 있으면 그 언어 — `language.md`), 티켓 번호가 있으면 `feat: PROJ-1234 설명` 형식 (각 레포 최근 커밋 관례 따름)
- 브랜치 전략은 사용자 지시에 따른다
