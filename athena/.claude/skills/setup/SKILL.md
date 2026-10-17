---
name: setup
description: 새 회사 첫 실행 — 레포를 찾아 회사 팩을 만들고(athena init) 레포마다 에이전트·지식 뼈대·검증 스크립트를 만든 뒤(athena scaffold) 레포 코드를 읽어 뼈대와 서비스 문서를 채우고 QA 초안(앱별 routes·TC)·검증·지문 기준선·레포별 다이어그램까지 잡습니다. 팩이 없을 때 세션 시작 훅이 안내합니다.
argument-hint: "(선택) 레포 폴더 — 비우면 athena.config.json reposRoot 또는 상위 폴더"
---

# 새 회사 첫 실행

레포 폴더: $ARGUMENTS (비우면 `reposRoot`, 없으면 `..`)

절차의 정본은 **`docs/setup.md`**(Codex 등 다른 도구도 같은 문서를 따른다) — 먼저 읽고 0단계부터 그대로 한다.
이 세션(Claude Code)에서는 묻기 = AskUserQuestion, 5단계 작업자 = Agent 도구 `general-purpose` 백그라운드(한 번에 최대 5개 · `scripts/monitor-pane.sh` 로 보이게), 7-1단계 = `/diagram`.
