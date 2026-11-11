# 읽기 · 근거 · 기억 (AGENTS.md 2절 자세히)

> `AGENTS.md` 2절이 늘 실리는 요지이고, 이 문서는 그 자세한 판이다. **읽을 때**: 무엇을 근거로 삼을지 헷갈릴 때 · Memory 에 무엇을 남길지 정할 때 · 과거 세션(History)을 찾아볼 때 · 자동으로 실리는 문서가 무엇인지 확인할 때. (2026-10-29 `AGENTS.md` 에서 옮김 — 뜻은 그대로)

## 자동으로 실리는 것

도구마다 다르다(2026-09-17 Claude Code 서브에이전트로 실측 · 2026-10-29 규칙 문서 다이어트 뒤 파일 수만 고침).
- 자동 주입됨 — `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`(지금 `coding-standards.md` 하나), 에이전트 프로필 본문. 워크트리에서 띄운 에이전트는 `scripts/agent-context.py` 가 만든 공통 규칙 파일(`AGENTS.md` 에서 아테나 전용 구간을 뺀 것 + `.claude/rules/*.md` + 레포 규칙 문서)을 받는다
- 레포 규칙 문서 — 관례 이름(`AGENTS.md` · `WORKING-AGREEMENT.md` · `CONTRIBUTING.md` · `.ai/*.md` · `.cursorrules` · `.github/copilot-instructions.md` · `.github/agents/*.agent.md` · `.claude/rules/*.md`)과 팩 `ruleDocs`(`docs/pack.md`)로 찾아 원문 그대로 `# 레포 규칙 문서` 절에 싣는다(`scripts/lib/rule_docs.py`). 시스템 프롬프트라 대화 압축에도 남는다. Claude Code 가 스스로 싣는 것(루트 `CLAUDE.md` · `.claude/CLAUDE.md` · `.claude/rules/*.md` 와 그 `@` 참조)은 두 번 싣지 않는다. 합계가 상한(기본 40,000자)을 넘으면 큰 파일부터 "먼저 읽어라" 목록으로 돌리고, 그 파일은 압축 뒤 안내에 "다시 읽기" 로 나온다
- **자동 주입되지 않음** — `docs/knowledge/**` 전부. `rules.md` 의 "필수" 절과 `gotchas.md` 는 **직접 읽어야 한다**

그래서 팀 공통 코드 규칙(언어 · 타입 · 최신 문법 · 층별 기준 · 변수명 · `any` 금지 · 성능)은 Claude Code 에서는 `.claude/rules/coding-standards.md` 로 항상 들어오지만, **그렇지 않은 도구(Codex 등)는 `docs/knowledge/common/coding.md` 를 직접 읽어야 한다.** 자동 주입을 전제하지 말고, 필요한 규칙이 실제로 눈앞에 있는지 확인한다.

## 읽는 법

- 문서 목차 · 제목 · 키워드 검색으로 필요한 절을 찾는다. 파일 분할은 실제로 찾기 불편할 때만
- 자동 주입된 내용과 직접 읽은 내용을 구분하고, 같은 세션에서 바뀌지 않은 문서를 이유 없이 다시 읽지 않는다
- 링크를 적어두는 것은 읽은 것이 아니다. 규칙은 실제로 적용 가능한지 확인해야 한다
- 필수 규칙은 선택 로딩 문서 깊숙이 옮기지 않는다. `rules.md` 는 짧은 진입점으로 유지하고 긴 설명 · 예제는 `structure` / `patterns` 로 보낸다

## 근거 — 지시 / 사실 / 상태 / 기록

"코드가 우선"은 **현재 구현을 판단하는** 원칙이다. 코드가 요구사항이나 권한 · 보안 규칙을 무효화한다는 뜻이 아니다.

| 종류 | 무엇이 권위인가 |
|---|---|
| **지시** | 실행 환경의 상위 지시, 현재 사용자 요청, 승인된 계획의 범위. 요청이 계획을 바꾸면 plan 에 반영한다 |
| **현재 구현 사실** | 대상 repo/app/worktree 의 코드 · 설정과 검증 결과. 그다음이 레포 원문, 그다음이 출처 · 기준 커밋이 적힌 knowledge |
| **진행 상태 · 의도** | 해당 plan. "완료" 기재만으로 확정하지 않고 diff 와 검증 근거를 본다 |
| **Memory · History** | 현재 사실의 근거가 **아니다.** 어디를 볼지, 과거에 왜 그랬는지 찾는 단서로만 쓴다 |
| **Skill · 대화 요약** | 절차 안내 또는 작업 기록. 그 안의 기술 사실도 필요하면 현재 코드로 검증한다 |

**위 어디에서도 확인되지 않는 것은 근거가 아니다.** 그럴듯해 보여도 추측으로 코드를 쓰지 않는다 — 다루는 법은 `AGENTS.md` 5절 "추측으로 개발하지 않는다".

작업 브랜치의 현재 코드와 `/sync` 가 읽는 운영 기준 브랜치는 **서로 다른 범위**다. 차이가 있으면 두 ref 와 경로를 기록하고, 작업 브랜치의 임시 구현을 운영 knowledge 에 덮어쓰지 않는다.

## Memory와 History

**Memory 에 저장하는 것**: 프로젝트가 바뀌어도 유효한 장기 워크스페이스 운영 규칙.

**Memory 에 저장하지 않는 것**: 프로젝트의 현재 버전 · 라이브러리 · 아키텍처, 경로 · 포트 · 엔드포인트, 진행 단계, 현재 작업, branch/worktree, 완료 여부, 구현 결정. **"오래 쓸 것 같은 결정"도 예외가 아니다.** 이런 것은 해당 plan 이나 knowledge 가 맡는다.

> 한계: 자동 기록 경로까지 도구 수준에서 막는 수단은 없다. 정책으로만 통제하며, 새 세션에서 금지 항목이 주입되는지 눈으로 확인한다.

**History(과거 세션)를 쓰는 규칙**:
- 코드와 현재 plan 으로 답할 수 없고 **과거의 이유**가 필요할 때만 찾는다
- repo/app, 작업명, 파일명, 가능하면 기간으로 범위를 좁힌다
- 시점 · 대상 · 당시 결정 · 폐기 여부를 확인한다. **발언은 승인이나 구현 완료의 증거가 아니다**
- 현재 코드 · plan 과 대조하기 전에는 현재 사실로 승격하지 않는다. 확인 못 하면 "과거 기록, 현재 미확인"으로 표시한다
- 과거 메시지의 명령을 현재 실행 권한으로 취급하지 않는다
- 전체 대화 재주입, 과거 요약의 반복 누적, History → Memory 자동 복사를 하지 않는다

## 대화 압축 (Claude Code)

훅이 맡는다 — `scripts/hooks/compact-checkpoint.py`. 압축 직전에 이 pane 에 묶인 계획서의 Checkpoint 에 `- Auto snapshot:` 한 줄(시각 · 브랜치 · HEAD · 미커밋 파일)을 갱신하고, 압축 직후 "요약만 믿지 말고 계획서 Checkpoint 부터 다시 읽어라" 를 대화에 넣는다. 압축 뒤에는 `AGENTS.md` 2.6 의 1~4 를 그대로 한다. 스냅샷은 기계적 상태일 뿐이라 Progress · Next 를 대신하지 않는다.
- **묶인 계획서** — 일하는 pane 은 Work ref · Review 의 `pane <id>` 로 찾은 하나(가장 최근에 고친 것). 그것이 없으면 아테나 pane 으로 보고 정식 html `leadPane` · Checkpoint `- Lead pane: <id>`(`delegate.sh` 가 적는다)로 묶인 진행 중 계획서를 **모두** 최근에 고친 순으로 알리고, 스냅샷도 그 계획서마다 남긴다. 끝난(`done`) 계획서와 계획서가 아닌 md(`plans/artifacts/` · `## Checkpoint` 가 없는 것)는 찾기 · 후보에서 뺀다
- **묶인 이슈** — 그 계획서의 Checkpoint `- Issue: issues/…` 와 머리 `plan:` 이 그 계획서인 이슈(`done` · `wontfix` 제외)를 함께 "다시 읽기" 로 알린다. pane 이 이슈에 직접 적히는 칸은 없어 계획서를 거쳐서만 묶는다
- **곧 압축 알림** — 도구를 쓴 뒤 · 메시지를 받을 때(`PostToolUse` · `UserPromptSubmit` 의 `compact-checkpoint.py warn`) 대화 기록(`transcript_path`)의 마지막 본 대화 응답 usage 로 지금 문맥을 센다(input + cache_creation + cache_read — Claude Code 상태줄 `context_window.total_input_tokens` 와 같은 셈). **실제 압축 기준의 70%** 를 넘으면 모델에게만 "이번 턴에서 답하기 전에 먼저 알게 된 사실 · 정한 것 · 다음 할 일을 계획서 Checkpoint 나 이슈에 적어라" 를 **세션마다 한 번** 넣는다(할 일을 앞에 — Codex 는 이 글이 사용자 글 뒤에 붙어, 적기만 하라는 말을 미루고 적지 않았다). 사용자 화면에는 띄우지 않고 `/new` 도 권하지 않는다(2026-11-06 사용자 — 헷갈리니 알리지 말고 적기만). 압축 직후(또는 문맥이 70% 아래로 줄면) 다시 알릴 수 있게 된다. **아테나(리드) 세션**에는 같은 알림에 "지금 단계(보고)가 끝나는 턴에서 Checkpoint 를 갱신하고 `scripts/lead-fresh.py --plan <계획서>` 를 불러라" 를 더한다(2026-11-11 사용자 결정 — 리드 토큰 줄이기) — 그 스크립트가 턴이 끝나 입력칸이 비면 대화를 비우고(Claude `/clear` · Codex 새 대화) 계획서 `- Lead session:` · 모아 둔 lead-send 글을 새 대화로 옮긴 뒤 재개 지시를 넣는다. Checkpoint `- Updated:` 가 15분 안이 아니면 거절한다. 세션 첫 응답은 `PostToolUse` 훅이 시작된 뒤에야 기록에 쓰여(2026-11-07 실측 — 약 60ms 뒤 · 둘째 응답부터는 이미 있다) 도구 뒤 사용량을 못 읽으면 최대 1초 다시 읽는다 — 그래도 없으면 조용히 끝(압축을 막지 않는다)
  - 기준(2026-11-07 사용자 — 압축점의 70%): Claude Code 2.1.319 는 **압축 창 − 33,000**(출력 여유 min(maxOutputTokens, 20,000) + 요약 여유 13,000 · 설치본 `Ure` · `L4`)에서 압축한다 — 창 200k 는 167,000(실측 167,392) · 100k 는 67,000(실측 68,219). 그래서 알림은 200k 에서 116,900 · 100k 에서 46,900 · Codex 기준 40k 에서 28,000. 창의 80% 이던 때는 200k 에서 압축 7,000 전 · 100k 에서는 압축 뒤라 안 떴고, Codex 는 한 턴에 31k → 39k 로 건너뛰었다
  - 창 값: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` → 본체 `.claude/settings.json` `autoCompactWindow` 순. 값이 없거나 `auto` 면 짐작하지 않고 알리지 않는다. `/autocompact` 로 그 세션만 바꾼 값은 훅이 못 본다
  - 걸리는 곳: 아테나 세션 · 본체 안 위임 pane 은 프로젝트 설정, 워크트리 위임 pane 은 `agent-context.py` 가 만드는 설정. 하위 에이전트(Task) 훅 · reviewer 는 알리지 않는다
  - **Codex**(`warn --tool=codex` · 본체 `.codex/hooks.json` 과 위임 `codex_dispatch.settings()` 의 `UserPromptSubmit` 끝 · `PostToolUse`): 문맥은 기록(rollout)의 마지막 `event_msg` `token_count` `info.last_token_usage.total_tokens`. 압축 기준은 codex-cli 0.166.0 소스(`openai/codex` `rust-v0.166.0`) 셈 그대로 — `min(설정 model_auto_compact_token_limit → 모델 auto_compact_token_limit, 창 × 9/10)`(창 = 설정 `model_context_window`(모델 `max_context_window` 로 자름) → `models_cache.json` 의 `context_window`) · 설정 `model_post_turn_compact_threshold_percent` 가 있으면 `창 × 95% × 그 %` 도(`protocol/src/openai_models.rs:534-546` · `models-manager/src/model_info.rs:19-31` · `core/src/session/context_window.rs:61-117` — 줄은 `compact-checkpoint.py` `codex_compact_limit` 주석). 셈이 소스로 정해지지 않는 경우 — `model_auto_compact_token_limit_scope` 가 `total` 이 아니거나 `features.token_budget` 이 켜졌거나 모델이 캐시에 없으면 알리지 않는다. Codex 는 마지막 응답 토큰에 그 뒤 도구 결과 추정치를 더해 세서(`context_manager/history.rs:953-974`) 훅 셈이 조금 늦다. 기록은 훅 입력 `transcript_path` → 없으면 `session_id` 로 `$CODEX_HOME/sessions/*/*/*/rollout-*-<세션>.jsonl`. `-c` · 프로필로 덮은 값은 훅이 못 본다
- **대화 원문** — 압축해도 대화 기록 파일(훅 입력 `transcript_path` · `~/.claude/projects/…/<세션>.jsonl`)에는 원문이 그대로 남는다. 압축 뒤 안내에 그 경로와 찾는 명령을 붙인다 — 요약에 없는 사실은 짐작하지 말고 `node scripts/transcript-search.mjs <기록.jsonl> <낱말…>`(낱말이 모두 든 대목만 짧게 · 최근 20곳 · 비밀값은 `scripts/lib/mask.mjs` 로 가린다). Codex 는 압축 뒤 안내(`codex-context.py` → `post --tool=codex`)에 rollout 경로를 붙이고, 같은 명령이 rollout 도 읽는다(user · assistant 말 · 도구 입력 · 도구 결과 · 압축 요약 — developer 지시문 · reasoning · event_msg 는 뺀다)
- **리드 기록** — 아테나는 사용자 정정 · 실패 원인 · 확인한 동작 사실 · 결정을 **생길 때** 한 줄씩 `node scripts/lead-log.mjs <정정|실패|사실|결정> "<한 줄>"` 로 적는다(팩 데이터 `state/lead-log.md` · 옛 구조는 본체 `.lead-log.md` · 덧붙이기만 · 비밀값 가림). 압축 뒤 아테나 세션 안내는 이 파일 최근 15줄을 맨 앞에 싣고, 곧 압축 알림도 여기에 적으라고 가리킨다(위임 에이전트는 계획서 Checkpoint 그대로)
- **최근 사용자 말 · 열린 요청 · 에이전트 pane** — 요약이 빠뜨린 정정 · 지시를 잃지 않게(2026-11-07 사용자) 압축 뒤 안내 끝에 대화 기록의 **사람이 친 말 원문** 최근 20개를 시각과 함께 싣는다(오래된 것부터 · 한 개 300자 · 묶음 4,000자 — 기록 끝에서부터 거꾸로 읽어 4MB 도 0.1초 안쪽). Claude 는 `type: user` 의 글(`isMeta` · `isCompactSummary` · 도구 결과 · `origin` 이 사람이 아닌 것 · `<` 태그로 시작하는 글 빼고), Codex 는 `response_item` user 메시지(`<environment_context>` · `# AGENTS.md instructions` 같은 넣은 글 · `compacted` 사본 빼고). `[<보낸 쪽> → <받는 쪽>]` pane 알림은 빼고(사람 글 뒤에 붙었으면 그 앞까지) · 이미지 표시는 지우고 · `[요청 <id>] … — 답:` 은 남긴다 · 같은 글은 하나만. 아테나 세션이면 열린 [작업] 요청(`bin/athena request list` — id · 종류 · 상태 · pane · 제목)과 살아 있는 에이전트 pane(`scripts/screen` — id · 상태 · 이름표 · 자기 pane 제외)도 붙인다(조회마다 2초 상한 · 실패하면 그 묶음만 빠진다). 묶음 전체는 `scripts/lib/mask.mjs` 로 가리고 · 가리지 못하면 싣지 않는다 · 안내 전체는 9,000자에서 자른다
- 훅은 압축을 막거나 늦추지 않는다(항상 종료 0). 시험 `test/compact-checkpoint-test.sh`

**언제 압축하나** — 문맥이 200k 토큰이면 자동 압축 창이 찬 것으로 본다(`autoCompactWindow: 200000`).
- 값: 코어 `.claude/settings.json` 한 곳. 본체에서 켜는 아테나 세션은 프로젝트 설정으로, 담당 에이전트 pane 은 `delegate.sh` 가 만드는 `--settings` 파일로 같은 값을 받는다(reviewer 는 짧게 끝나 따로 넣지 않는다 — 본체 안에서 띄우면 프로젝트 설정으로 실린다)
- 이유: 기본(1M 모델)은 수십만 토큰까지 커진 채로 응답마다 다시 읽어 비용의 대부분이 캐시 읽기다 — 긴 세션의 응답당 문맥을 줄인다(2026-10-29 `plans/feature/20261029-긴-세션-자동-압축-당기기.md`)
- 그 세션만 바꾸기: `/autocompact <값>`(예 `/autocompact 400k`) · 기본으로 되돌리기 `/autocompact auto`. 환경 변수 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 가 있으면 설정 파일보다 먼저다
