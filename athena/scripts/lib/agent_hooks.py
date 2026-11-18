"""위임 에이전트에 거는 Claude 훅 설정의 한 곳 — delegate.sh(본체 안 작업) 와 agent-context.py(워크트리 등 본체 밖 작업)가 같이 쓴다.

훅을 더하거나 바꿀 때는 여기만 고친다. 두 경로가 각자 목록을 만들면 한쪽만 고친 뒤 다른 경로로 뜬 에이전트에는 훅이 안 걸린다.
reviewer 는 읽기 전용이라 commit-guard · 고르기 질문 · 자동 압축에서 빠지고 secret-guard · process-guard 만 건다(권한 확인 알림 · 끝 알림은 reviewer 도 건다 — 끝 알림은 계획서 결정 D2).

CLI(delegate.sh): python3 agent_hooks.py inline <출력 json> <athena 루트> <에이전트>  — 본체 안(프로젝트 설정이 실리는 곳)용 settings 전체
"""
import json, pathlib, shlex, sys

import athena_config


def command(path):
    """훅 명령 한 줄 — 경로에 공백 · ' 가 있어도 깨지지 않게 셸 따옴표로 감싼다"""
    return "python3 " + shlex.quote(str(path))


def hook(hermes, rel, args=""):
    return {"type": "command", "command": command(pathlib.Path(hermes) / rel) + (f" {args}" if args else "")}


def pre_tool_use(hermes, agent):
    """Bash 보호 훅(commit-guard · secret-guard · process-guard · server-guard) + 고르기 질문 → 요청(ask-to-request) — reviewer 는 secret · process · server 만"""
    bash_hooks = [] if agent == "reviewer" else [hook(hermes, "scripts/hooks/commit-guard.py")]
    bash_hooks += [hook(hermes, "scripts/hooks/secret-guard.py"), hook(hermes, "scripts/hooks/process-guard.py"), hook(hermes, "scripts/hooks/server-guard.py")]
    entries = [{"matcher": "Bash", "hooks": bash_hooks}]
    if agent != "reviewer":
        entries.append({"matcher": "AskUserQuestion", "hooks": [hook(hermes, "scripts/hooks/ask-to-request.py")]})
    return entries


def permission_request(hermes):
    """권한 확인 창 → [작업] 알림(permission-to-request.py) — reviewer 포함 모든 에이전트. 허용 · 거부는 하지 않고 창을 알리기만 한다"""
    return [{"hooks": [hook(hermes, "scripts/hooks/permission-to-request.py")]}]


def pane_session(hermes):
    return hook(hermes, "scripts/hooks/pane-session.py")


def done_notify(hermes, agent):
    """끝 알림 — (UserPromptSubmit 에 더할 훅 목록, Stop 훅 항목 목록). reviewer 도 같다(결정 D2 — 끝나면 아테나에 알린다).
    Codex 는 이 훅이 공통 훅 뒤 같은 자리라 역할이 달라도 믿음 키가 겹치지 않는다(codex_dispatch.settings)"""
    return [hook(hermes, "scripts/hooks/agent-done-notify.py", "prompt")], [{"hooks": [hook(hermes, "scripts/hooks/agent-done-notify.py", "stop")]}]


def auto_compact_window(hermes, agent):
    """자동 압축 시점 — 값은 본체 .claude/settings.json 한 곳. reviewer 는 짧게 끝나 없다"""
    if agent == "reviewer":
        return None
    return json.loads((pathlib.Path(hermes) / ".claude/settings.json").read_text(encoding="utf-8")).get("autoCompactWindow")


def permissions_allow(hermes, agent):
    """이 에이전트가 맡은 레포의 팩 "permissionsAllow"(Claude Code permissions.allow 규칙) — 설정을 못 읽으면 없는 것으로(권한을 넓히지 않는 쪽)"""
    try:
        cfg = athena_config.load(str(hermes))
    except (SystemExit, ValueError, OSError):
        return []
    rules = []
    for entry in cfg.get("repos", []):
        apps = (entry.get("apps") or {}).values()
        if agent in (entry.get("agents") or []) or entry.get("packagesAgent") == agent or any(app.get("agent") == agent for app in apps):
            rules += [rule for rule in entry.get("permissionsAllow") or [] if isinstance(rule, str) and rule]
    return rules


def link_dirs(hermes):
    """본체의 pack · plans · issues 링크가 가리키는 본체 밖 실제 폴더(여러 팩 구조 — <데이터>/packs/<id>/…).
    링크가 아니거나(옛 구조) 본체 안으로 풀리면 빼고, 못 풀면 건너뛴다"""
    root = pathlib.Path(hermes).resolve()
    found = []
    for name in ("pack", "plans", "issues"):
        link = root / name
        if not link.is_symlink():
            continue
        try:
            real = link.resolve(strict=True)
        except OSError:
            continue
        if real.is_dir() and not real.is_relative_to(root):
            found.append(str(real))
    return found


def add_link_dirs(settings, hermes):
    """링크 폴더를 Claude Code 설정 permissions.additionalDirectories 로 — 계획서 쓰기 · 지식 읽기에서 권한을 묻고 멈추지 않게(2026-10-25 시험).
    --add-dir 로 넘기면 Claude Code 2.1.326 부터 아직 안 믿은 폴더마다 폴더 확인 창이 떠 멈춘다(공식 CHANGELOG 2.1.326 · 2026-11-18 실측 3번).
    설정 파일의 additionalDirectories 는 창 없이 파일 접근만 연다(공식 문서 permissions "Working directories" · 같은 날 실측 0번)"""
    dirs = link_dirs(hermes)
    if dirs:
        settings.setdefault("permissions", {})["additionalDirectories"] = dirs
    return settings


def inline_settings(hermes, agent):
    """본체 안(hermes 프로젝트 설정이 실리는 곳)에서 띄울 때의 settings — 보호 훅 · pane 기록 · 끝 알림 · 자동 압축 · 팩이 허용한 권한만"""
    notify_prompt, notify_stop = done_notify(hermes, agent)
    hooks = {
        "PreToolUse": pre_tool_use(hermes, agent),
        "PermissionRequest": permission_request(hermes),
        "SessionStart": [{"hooks": [pane_session(hermes)]}],
        "UserPromptSubmit": [{"hooks": [pane_session(hermes)] + notify_prompt}],
    }
    if notify_stop:
        hooks["Stop"] = notify_stop
    settings = {"hooks": hooks}
    window = auto_compact_window(hermes, agent)
    if window:
        settings["autoCompactWindow"] = window
    allow = permissions_allow(hermes, agent)
    if allow:
        settings["permissions"] = {"allow": allow}
    return add_link_dirs(settings, hermes)


if __name__ == "__main__":
    if sys.argv[1:2] == ["link-dirs"]:
        # Codex 의 --add-dir(쓰기 자리 · 확인 창 없음)에 같은 목록을 쓴다 — 한 줄에 하나
        print("\n".join(link_dirs(sys.argv[2])))
        sys.exit(0)
    mode, out, hermes_dir, agent_name = sys.argv[1:5]
    if mode != "inline":
        sys.exit(f"알 수 없는 모드: {mode}")
    pathlib.Path(out).write_text(json.dumps(inline_settings(pathlib.Path(hermes_dir).resolve(), agent_name)), encoding="utf-8")
