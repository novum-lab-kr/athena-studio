# 경량 계획서 템플릿

**모든 작업은 계획서 하나에 묶인다.** 작업의 무게에 따라 둘 중 하나를 쓴다.

| 종류 | 언제 | 파일 | 승인 |
|---|---|---|---|
| 정식 | 사용자가 정할 것이 있거나 여러 레포·담당을 맞춰야 할 때(새 기능·API·구조 변경은 대개 여기) | `plans/{feature,bugfix,refactor}/…` `.md` + `.html`(결정 콘솔) — `docs/plan-template.md` | 결정 콘솔에서 골라 [이대로 진행] |
| **경량** | 그 밖의 모든 작업 — 문구·스타일 수정 · 버그 하나 · 확인·조사 · 직접 부른 에이전트 작업 · 긴급 수정 | `plans/task/YYYYMMDD-<에이전트>-<요약>.md` 하나 — **이 템플릿** | **사용자의 지시가 곧 승인** |

- 손으로 쓰지 않는다. `node scripts/new-plan.mjs --agent <에이전트> --summary "<요약>"` 이 만든다. `scripts/delegate.sh --plan new "<요약>"` 과 현황판 [작업 시작] 은 이걸 부른다
- 작업이 커지면(여러 레포·API 변경·결정이 필요) 정식 계획서로 옮기고 경량판에는 그 경로를 적는다
- 담당 에이전트는 끝날 때 Checkpoint 의 Progress·결과를 채운다(Validation 은 검증 스크립트 · 커밋 뒤 Status 는 `commit.sh` 가 적는다). Studio [작업] 팝업 · pane [상세] 가 이 Status 를 따라 바뀐다
- 버그 수정이면 `AGENTS.md` 5절의 버그 수정 규칙(재현 먼저 · 수정 전·후 비교)을 따른다
- 경량판은 처음에 html 결정 콘솔이 없다 — 리뷰에서 "결정 필요"가 나오면 그때 같은 계획서에 콘솔이 생긴다(`plan-html.mjs --add`)

<!-- BEGIN:template -->
# {{title}}

> 경량 계획서 — 사용자 지시가 곧 승인. 커지면 정식 계획서(`docs/plan-template.md`)로 옮긴다.

## Checkpoint
- Updated: {{updated}}
- Status: {{status}}
- Owner: {{owner}}
- Agent: {{agent}}
- Issue: {{issue}}
- Work ref: (디스패치할 때 채운다 — 워크트리 · 브랜치 · pane)

### Progress
- [ ] 담당 레포 브랜치·미커밋 상태 확인
- [ ] (작업) → 확인: (방법) → 성공 조건: (기대 결과)
- [ ] 표준 검증 + 동작 확인 결과 기록 — 실행 못 한 것은 이유
- [ ] 근거 확인 — 외부 계약·제품 정책·기본 동작을 근거 없이 넣지 않았나. 확인 못 한 것은 Blocked 에 적고 완료로 보고하지 않는다(`AGENTS.md` 5절)

### Next
1. 담당 레포 브랜치·미커밋 상태를 확인해 보고한다

### Blocked
- 없음

### Validation
- (검증 스크립트 출력 표 · 실행 못 한 것은 "실행 못 함")

## 지시
{{prompt}}

## 결과
- (변경 파일 · 요약 · 남은 위험 — AGENTS.md 6절 보고 형식)
- 📚 배운 것: (끝낼 때 — 0~3줄 + learn 이슈 경로, 없으면 "없음")

## Commits
- (scripts/commit.sh 가 한 줄씩 적는다 — 날짜 · 레포 · 브랜치 · SHA · 메시지 · 검증 · push 여부)
<!-- END:template -->
