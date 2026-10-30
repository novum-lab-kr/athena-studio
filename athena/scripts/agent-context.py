#!/usr/bin/env python3
"""워크트리에서 에이전트를 띄울 때 넘길 정의·공통 규칙 파일을 만든다 (delegate.sh 가 쓴다).

왜 필요한가: 워크트리는 그 자체가 별도 git 레포라 Claude Code 가 hermes 의
.claude/agents·.claude/rules·AGENTS.md 를 찾지 못한다(2026-09-23 실측 — `--agent 'reviewer' not found`).
그래서 에이전트 정의는 --agents JSON 으로, 공통 규칙은 --append-system-prompt-file 로 직접 넣는다.
워크트리가 hermes 안(.worktrees/)이면 반대로 상위의 CLAUDE.md(팀리드 역할)·AGENTS.md·rules 가
자동으로 딸려 와 규칙이 두 번 들어가고 "직접 코드를 쓰지 않는다"는 팀리드 지시까지 섞인다.
settings 의 claudeMdExcludes 로 그것들을 빼고 여기서 만든 컨텍스트만 한 번 넣는다.

사용: scripts/agent-context.py <에이전트명> <athena 루트> <워크트리> <agents.json 출력> <context.md 출력> <settings.json 출력>
"""
import json, re, shlex, sys, pathlib
import os

agent, hermes_dir, workdir, agents_out, context_out, settings_out = sys.argv[1:7]
hermes = pathlib.Path(hermes_dir).resolve()

# 에이전트 md 의 frontmatter(name/description/tools)와 본문을 나눈다
text = (hermes / ".claude/agents" / f"{agent}.md").read_text(encoding="utf-8")
_, front, body = text.split("---", 2)
meta = {}
for line in front.strip().splitlines():
    key, _, value = line.partition(":")
    meta[key.strip()] = value.strip()

definition = {"description": meta.get("description", ""), "prompt": body.strip()}
if meta.get("tools"):
    definition["tools"] = [tool.strip() for tool in meta["tools"].split(",") if tool.strip()]
pathlib.Path(agents_out).write_text(json.dumps({agent: definition}, ensure_ascii=False), encoding="utf-8")

# 공통 규칙: AGENTS.md(아테나 전용 구간을 뺀 것) + .claude/rules/*.md. CLAUDE.md 는 아테나(팀리드) 전용이라 넣지 않는다.
# AGENTS.md 의 <!-- lead-only … --> ~ <!-- /lead-only --> 는 첫 실행 · 여러 팩 본체 · 라우팅 · /sync 처럼
# 아테나만 쓰는 절이다 — 에이전트에게는 매 응답 다시 읽는 비용만 늘린다(2026-10-29 규칙 문서 다이어트).
# 디스패치 프로토콜은 .claude/rules 가 아니라 docs/dispatch.md 라 여기 들어오지 않는다
LEAD_ONLY = re.compile(r"<!-- lead-only\b.*?<!-- /lead-only -->\n?", re.S)
def agent_rules(text):
    return LEAD_ONLY.sub("", text)

parts = [
    "# 아테나 작업 컨텍스트 (워크트리 실행)",
    f"- 아테나 루트: `{hermes_dir}` — 아래 문서의 `docs/`, `scripts/`, `plans/`, `issues/` 상대 경로는 모두 여기 기준이다",
    f"- 작업 디렉토리(워크트리): `{workdir}` — 코드 변경은 여기서만 한다. 에이전트 프로필의 `repos/<레포>` 는 메인 체크아웃이므로 수정하지 않는다",
    "- 검증 스크립트는 아테나 루트의 `scripts/verify/*.sh` 를 절대 경로로 실행한다. "
    "환경변수 `ATHENA_VERIFY_DIR` 가 이 워크트리를 가리키므로 워크트리가 검증된다",
    "",
    agent_rules((hermes / "AGENTS.md").read_text(encoding="utf-8")),
]
for rule in sorted((hermes / ".claude/rules").glob("*.md")):
    parts += ["", rule.read_text(encoding="utf-8")]
pathlib.Path(context_out).write_text("\n".join(parts), encoding="utf-8")

# 상위 디렉터리에서 자동 로드되는 hermes 문서를 뺀다 (위 컨텍스트에 이미 들어 있다)
excludes = [str(hermes / "CLAUDE.md"), str(hermes / "AGENTS.md"), str(hermes / ".claude/rules/**")]
# FE 세션 보호 훅 — git commit 직접·add -A 는 commit.sh 로 안내, push·gh pr 차단 (scripts/hooks/commit-guard.py)
# 시크릿 출력 차단 훅은 reviewer 포함 모든 세션에 (scripts/hooks/secret-guard.py — 토큰은 무조건 노출 금지)
# 프로세스 종료 보호 훅도 모든 세션에 (scripts/hooks/process-guard.py — pkill · killall · 0/음수 대상 kill 차단, GH #133)
# 훅 명령은 셸이 읽으므로 경로를 셸 따옴표로 감싼다(경로에 공백·' 가 있어도 깨지지 않게)
def script(rel): return shlex.quote(str(hermes / rel))
secret_hook = {"type": "command", "command": f"python3 {script('scripts/hooks/secret-guard.py')}"}
process_hook = {"type": "command", "command": f"python3 {script('scripts/hooks/process-guard.py')}"}
guard = {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": f"python3 {script('scripts/hooks/commit-guard.py')}"}, secret_hook, process_hook]}]}
settings = {"claudeMdExcludes": excludes}
# 하단 상태바 — 워크트리는 hermes 프로젝트 설정 밖이라 따로 넣는다(레포·브랜치·변경 수·모델, scripts/statusline.sh)
settings["statusLine"] = {"type": "command", "command": f"/bin/sh {script('scripts/statusline.sh')}", "padding": 0}
if agent != "reviewer":
    settings["hooks"] = guard
    # 고르기 질문(AskUserQuestion)을 사람에게 묻는 요청으로 바꿔 [작업] 에 올린다 (scripts/hooks/ask-to-request.py — 위임 에이전트만)
    guard["PreToolUse"].append({"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": f"python3 {script('scripts/hooks/ask-to-request.py')}"}]})
    # 자동 압축 시점 — 워크트리는 본체 프로젝트 설정이 안 실려 따로 넣는다. 값은 본체 .claude/settings.json 한 곳에서 읽는다
    # (reviewer 는 짧게 끝나 넣지 않는다 · docs/knowledge/common/context.md "대화 압축")
    window = json.loads((hermes / ".claude/settings.json").read_text(encoding="utf-8")).get("autoCompactWindow")
    if window:
        settings["autoCompactWindow"] = window
else:
    settings["hooks"] = {"PreToolUse": [{"matcher": "Bash", "hooks": [secret_hook, process_hook]}]}
# 대화 압축 전후 — 직전에 계획서 Checkpoint 에 상태 한 줄, 직후에 계획서부터 다시 읽게 (scripts/hooks/compact-checkpoint.py)
compact_hook = f"python3 {script('scripts/hooks/compact-checkpoint.py')}"
settings["hooks"]["PreCompact"] = [{"hooks": [{"type": "command", "command": f"{compact_hook} pre"}]}]
# pane ↔ 대화 기록 — 팩 백업이 되살릴 때 claude --resume 으로 잇는다 (scripts/hooks/pane-session.py)
settings["hooks"]["SessionStart"] = [{"matcher": "compact", "hooks": [{"type": "command", "command": f"{compact_hook} post"}]},
                                     {"hooks": [{"type": "command", "command": f"python3 {script('scripts/hooks/pane-session.py')}"}]}]
# 답 언어 — 메시지마다 본체 .claude/settings.local.json 의 language(스튜디오 앱 언어)를 다시 읽어 넣는다 (scripts/hooks/language.py)
settings["hooks"]["UserPromptSubmit"] = [{"hooks": [{"type": "command", "command": f"python3 {script('scripts/hooks/language.py')}"},
                                                     {"type": "command", "command": f"python3 {script('scripts/hooks/pane-session.py')}"}]}]
# 끝 알림 — 에이전트가 한 차례를 끝내면 띄운 아테나 pane 에 한 줄(scripts/hooks/agent-done-notify.py — 위임 에이전트만, reviewer 는 계획서 줄로 알린다)
if agent != "reviewer":
    notify = lambda mode: {"type": "command", "command": f"python3 {script('scripts/hooks/agent-done-notify.py')} {mode}"}
    settings["hooks"]["UserPromptSubmit"][0]["hooks"].append(notify("prompt"))
    settings["hooks"]["Stop"] = [{"hooks": [notify("stop")]}]
pathlib.Path(settings_out).write_text(json.dumps(settings), encoding="utf-8")
