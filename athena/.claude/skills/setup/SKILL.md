---
name: setup
description: 새 회사 첫 실행 — 레포를 찾아 팩을 만들고(athena init) 레포마다 에이전트·지식 뼈대·검증 스크립트를 만든 뒤(athena scaffold) 레포 코드를 읽어 뼈대와 서비스 문서를 채우고 흐름 문서 초안 · 검증 · 지문 기준선까지 잡습니다. 팩이 없을 때 세션 시작 훅이 안내합니다.
argument-hint: "(선택) 레포 폴더 — 비우면 athena.config.json reposRoot 또는 상위 폴더"
---

# 새 회사 첫 실행

레포 폴더: $ARGUMENTS (비우면 `reposRoot`, 없으면 `..`)

절차의 정본은 **`docs/setup.md`**(Codex 등 다른 도구도 같은 문서를 따른다) — 먼저 읽고 0단계부터 그대로 한다.
Claude Code에서는 묻기 = AskUserQuestion, 5단계 작업자 = Agent 도구 `general-purpose` 백그라운드(한 번에 최대 5개 · `scripts/monitor-pane.sh` 로 보이게 · Studio 화면이면 앱 아래 모니터 칸이 보여 주므로 스크립트가 아무것도 안 띄운다).

Codex에서는 같은 절차에서 질문은 request_user_input(쓸 수 없는 모드면 `bin/athena request`), 작업자는 `scripts/delegate.sh`로 팩 담당 에이전트 pane에 맡긴다(`docs/dispatch.md`). Agent 도구나 `general-purpose`를 Codex에 요구하지 않는다.
