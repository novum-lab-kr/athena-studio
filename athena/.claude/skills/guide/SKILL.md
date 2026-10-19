---
name: guide
description: 아테나 가이드 메뉴를 오른쪽 pane 에 띄우거나(문서 · 스킬 목록·실행 · 에이전트·라우팅) 구조 설명·플레이북·다이어그램을 브라우저로 엽니다.
argument-hint: "(없음) | <파일> | 설명 | 열기 | 시작하기 | 그림"
---

# 가이드

인자: $ARGUMENTS

파일을 수정하지 않는다. 인자에 따라 하나만 한다.

안내 HTML(`<athena-explained.html>`·`<playbook.html>`·`<onboarding.html>`)은 팩 판 `pack/guide/<파일>` 이 있으면 그것, 없으면 코어 판 `docs/<파일>` 을 연다.

| 인자 | 동작 |
|---|---|
| 없음 / `pane` / `메뉴` | `scripts/guide-pane.sh` — 현재 pane 오른쪽에 선택형 메뉴(`scripts/guide-menu.sh`)를 띄운다. 아테나 구조 설명 · 시작하기 가이드 · 플레이북 · 다이어그램 · 확장 가이드 · 스킬 목록·실행 · 에이전트·담당 레포·라우팅. 클릭 또는 ↑/↓·숫자 + Enter, `q` 로 닫는다 (Athena Studio pane 안이면 화면 계층 `scripts/screen pane split` · tmux 면 `split-window` · 둘 다 아니면 새 Ghostty 창) |
| `<파일>` / `pane <파일>` | **실제로 있는 경로일 때만** 메뉴 대신 그 파일을 뷰어로 띄운다(예: `CLAUDE.md`). 없는 경로·일반 단어(`스킬`·`팀` 등)면 아래 "그 밖의 질문"으로 처리한다 |
| `설명` / `구조` | `scripts/screen open-url <athena-explained.html>` — 아테나 구조 설명(무엇이고 어떻게 돌아가나 · Hermes Agent 와의 차이)을 브라우저로. 열었다는 한 줄만 답한다 |
| `열기` / `open` | `scripts/screen open-url <playbook.html>` — 플레이북을 브라우저로. 열었다는 한 줄만 답한다 |
| `시작하기` / `온보딩` | `scripts/screen open-url <onboarding.html>` — 시작하기 가이드(원본 `ONBOARDING.md`)를 브라우저로. 열었다는 한 줄만 답한다 |
| `그림` / `다이어그램` | `scripts/screen open-url docs/diagrams/index.html` — 다이어그램 목록(작업 흐름 경량·정식 + 팩 서비스 × 구조·화면 맵·요청 흐름). 열었다는 한 줄만 답한다 |

그 밖의 질문(어느 에이전트가 무엇을 하나, 작업 흐름, 스킬·에이전트 추가 방법)은 메뉴를 띄우지 말고 `AGENTS.md`·`CLAUDE.md`·`docs/extending.md` 에서 해당 절을 찾아 그대로 보여 주고 원본 경로를 한 줄 덧붙인다.
