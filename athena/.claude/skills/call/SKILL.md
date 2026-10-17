---
name: call
description: 담당 에이전트를 그 레포 workspace 에 pane 으로 바로 띄웁니다. 브랜치를 먼저 물어 워크트리를 만들고 그 폴더에서 띄우며, 요청은 그 pane 에서 직접 합니다. 대화하며 범위를 좁혀 가는 작업에 씁니다.
argument-hint: "<에이전트> — 예: web-fe · api-be (목록은 pack/ROUTING.md)"
---

# 에이전트 띄우기 (브랜치·요청은 pane 에서)

대상: $ARGUMENTS

권장 방식(CLAUDE.md 3단계 "프롬프트 없이 pane 을 열고 그 안에서 작업을 지시한다")을 한 번에 한다. **아테나는 브랜치를 묻고 워크트리를 만들어 그 폴더에서 띄우기만 한다.** 요청을 받아 진행하는 것은 pane 안의 에이전트가 한다.

> 브랜치를 pane 안에서 정하면 claude 가 athena 루트에서 켜진 채로 남아, 사이드바 Explorer(선택한 pane 프로그램의 폴더를 따라간다)가 워크트리 대신 hermes 를 보여 준다. 그래서 워크트리를 **먼저** 만들고 `--cwd` 로 띄운다.

## 동작
1. 인자 = 에이전트 이름(`.claude/agents/<이름>.md`). 없거나 틀리면 에이전트 목록을 보여 주고 묻는다. `reviewer` 는 이 스킬로 띄우지 않는다(리뷰는 아테나에게 "리뷰해줘" — 계획서·워크트리를 붙여 `delegate.sh reviewer` 로 띄운다)
2. 브랜치 정보를 뽑는다 — 다른 도구를 먼저 부르지 않는다:
   ```bash
   scripts/call-branch-info.sh <에이전트>
   ```
   `target`(new-branch.sh 대상) · `repo` · `main`(메인 체크아웃 상태·미커밋 개수) · `candidate`(최근 작업 브랜치 0~3개 — 브랜치·로컬/원격·최근 활동·체크아웃 위치)
   - **`direct` 줄이 있으면(main 직접 레포 — 팩 `direct: true`) 3·4 를 건너뛴다**: 브랜치를 묻지도 만들지도 않고 `direct` 의 메인 체크아웃 경로를 `<워크트리>` 자리에 쓴다. 띄우기 전 한 줄 — `📋 경량으로 진행합니다 — /call · main 직접(브랜치·워크트리·PR 없음) · <메인 체크아웃 상태>`. 메인 체크아웃이 그 브랜치가 아니거나 뒤처졌으면 알린다
3. 곧바로 AskUserQuestion — 질문 '어느 브랜치로 작업할까요?'(header '브랜치'). 선택지는 후보마다 '<브랜치> 이어 쓰기'(description 에 로컬/원격·최근 활동) + '새 브랜치 만들기'(description 'Other 에 티켓 번호나 fix/설명을 적어 주세요'). 질문 앞에 두 줄로 알린다 — `📋 경량으로 진행합니다 — /call 로 담당자를 지정한 작업 (여러 레포·API 로 커지면 정식)` 와 메인 체크아웃 상태
   - 같은 레포에 이미 다른 pane 이 도는 브랜치(후보의 체크아웃 위치가 워크트리이고 그 브랜치 pane 이 떠 있음)는 description 에 "진행 중 pane 있음" 을 적는다 — 같은 작업을 둘이 만지지 않게
4. 워크트리를 만든다 — 후보를 골랐으면 `scripts/new-branch.sh <브랜치> <target> --reuse`, 새 이름이면 `--reuse` 없이. 새 이름인데 '⚠️ 이미 있다' 가 나오면 그 내용을 전하고 '그대로 이어 쓰기 / 다른 이름' 을 다시 묻는다. 출력의 워크트리 경로를 쓴다
5. 띄운다:
   ```bash
   scripts/delegate.sh <에이전트> --cwd <워크트리> --plan new "<에이전트> 작업 (pane 에서 지시)"
   ```
   - 경량 계획서(`plans/task/…`)를 빈 지시로 만들고, 담당 레포 workspace 에 pane 을 지시 없이 띄운다. Work ref 에 워크트리·브랜치·pane 이 적힌다
   - 에이전트는 브랜치·미커밋 상태를 한 줄 보고하고 요청을 기다린다. 첫 요청을 받으면 계획서 제목·`## 지시` 를 그 요청으로 채운다. 끝나면 Status `ready_for_review`
6. pane id · workspace · 브랜치 · 계획서 경로를 한 줄씩 알리고 "그 pane 에서 요청하면 된다" 한 줄

현황판(`/board`)에 계획서 카드가 **진행 중**으로 뜨고 `🤖 <에이전트>` 배지가 붙는다.

## 커밋
- 사용자가 그 pane 에서 **"커밋해줘"** 라고 하면 에이전트가 `scripts/commit.sh` 로 로컬 커밋한다 — 워크트리·보호 브랜치·기존 스테이징·지정 파일을 확인하고 엄격 검증 뒤 커밋, 계획서 `## Commits` 에 기록. 메인 체크아웃이면 거부되고 사용자가 명시해야 `--allow-main-checkout`
- 에이전트가 코드를 바꾼 요청을 보고하면 **자동으로 리뷰를 띄운다**(묻지 않음). 자동 리뷰나 **"리뷰해줘"** → 에이전트가 `scripts/delegate.sh reviewer --cwd <워크트리> --here --plan <계획서>` 로 같은 탭 옆에 reviewer pane 을 띄운다. reviewer 는 결론을 계획서 `- Review result:` 줄로 남긴다
- **"PR 올려줘"** → 에이전트가 `scripts/ship.sh` 미리보기를 보여 주고 base·제목을 확인받은 뒤 draft PR (레포 하나짜리 작업만. 규칙 `docs/knowledge/common/git.md` "PR 올리기")
- 직접 `git commit`·`git add -A`·`git push`·`gh pr create` 는 FE 세션 보호 훅이 막는다. 여러 레포에 걸친 작업의 push·PR 은 아테나에게

## 주의
- 요청이 여러 레포·API·구조 변경으로 커지면 에이전트가 멈추고 알린다 → 아테나가 정식 계획서(`docs/plan-template.md`)로 옮긴다
- 커밋·PR 은 사용자가 정한다
