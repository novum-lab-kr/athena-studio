"""위임 에이전트에 거는 Claude 훅 설정의 한 곳 — delegate.sh(본체 안 작업) 와 agent-context.py(워크트리 등 본체 밖 작업)가 같이 쓴다.

훅을 더하거나 바꿀 때는 여기만 고친다. 두 경로가 각자 목록을 만들면 한쪽만 고친 뒤 다른 경로로 뜬 에이전트에는 훅이 안 걸린다.
reviewer 는 읽기 전용이라 commit-guard · 고르기 질문 · 끝 알림 · 자동 압축에서 빠지고 secret-guard · process-guard 만 건다.

CLI(delegate.sh): python3 agent_hooks.py inline <출력 json> <athena 루트> <에이전트>  — 본체 안(프로젝트 설정이 실리는 곳)용 settings 전체
"""
import json, pathlib, shlex, sys


def command(path):
    """훅 명령 한 줄 — 경로에 공백 · ' 가 있어도 깨지지 않게 셸 따옴표로 감싼다"""
    return "python3 " + shlex.quote(str(path))


def hook(hermes, rel, args=""):
    return {"type": "command", "command": command(pathlib.Path(hermes) / rel) + (f" {args}" if args else "")}


def pre_tool_use(hermes, agent):
    """Bash 보호 훅(commit-guard · secret-guard · process-guard) + 고르기 질문 → 요청(ask-to-request) — reviewer 는 secret · process 만"""
    bash_hooks = [] if agent == "reviewer" else [hook(hermes, "scripts/hooks/commit-guard.py")]
    bash_hooks += [hook(hermes, "scripts/hooks/secret-guard.py"), hook(hermes, "scripts/hooks/process-guard.py")]
    entries = [{"matcher": "Bash", "hooks": bash_hooks}]
    if agent != "reviewer":
        entries.append({"matcher": "AskUserQuestion", "hooks": [hook(hermes, "scripts/hooks/ask-to-request.py")]})
    return entries


def pane_session(hermes):
    return hook(hermes, "scripts/hooks/pane-session.py")


def done_notify(hermes, agent):
    """끝 알림 — (UserPromptSubmit 에 더할 훅 목록, Stop 훅 항목 목록). reviewer 는 계획서 줄로 알려서 없다"""
    if agent == "reviewer":
        return [], []
    return [hook(hermes, "scripts/hooks/agent-done-notify.py", "prompt")], [{"hooks": [hook(hermes, "scripts/hooks/agent-done-notify.py", "stop")]}]


def auto_compact_window(hermes, agent):
    """자동 압축 시점 — 값은 본체 .claude/settings.json 한 곳. reviewer 는 짧게 끝나 없다"""
    if agent == "reviewer":
        return None
    return json.loads((pathlib.Path(hermes) / ".claude/settings.json").read_text(encoding="utf-8")).get("autoCompactWindow")


def inline_settings(hermes, agent):
    """본체 안(hermes 프로젝트 설정이 실리는 곳)에서 띄울 때의 settings — 보호 훅 · pane 기록 · 끝 알림 · 자동 압축만"""
    notify_prompt, notify_stop = done_notify(hermes, agent)
    hooks = {
        "PreToolUse": pre_tool_use(hermes, agent),
        "SessionStart": [{"hooks": [pane_session(hermes)]}],
        "UserPromptSubmit": [{"hooks": [pane_session(hermes)] + notify_prompt}],
    }
    if notify_stop:
        hooks["Stop"] = notify_stop
    settings = {"hooks": hooks}
    window = auto_compact_window(hermes, agent)
    if window:
        settings["autoCompactWindow"] = window
    return settings


if __name__ == "__main__":
    mode, out, hermes_dir, agent_name = sys.argv[1:5]
    if mode != "inline":
        sys.exit(f"알 수 없는 모드: {mode}")
    pathlib.Path(out).write_text(json.dumps(inline_settings(pathlib.Path(hermes_dir).resolve(), agent_name)), encoding="utf-8")
