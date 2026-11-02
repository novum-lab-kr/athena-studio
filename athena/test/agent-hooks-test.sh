#!/usr/bin/env bash
# 위임 에이전트 훅 설정 시험 — delegate.sh(본체 안)와 agent-context.py(본체 밖)가 같은 훅을 만드는지(scripts/lib/agent_hooks.py 한 곳) · 몇 초
#
# 사용: test/agent-hooks-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BODY="$TMP/body"
mkdir -p "$BODY/.claude/agents" "$BODY/.claude/rules" "$BODY/scripts/lib" "$TMP/work"
cp "$SRC/scripts/agent-context.py" "$BODY/scripts/"; cp "$SRC/scripts/lib/agent_hooks.py" "$SRC/scripts/lib/rule_docs.py" "$SRC/scripts/lib/athena_config.py" "$BODY/scripts/lib/"
printf '{"autoCompactWindow": 123}\n' > "$BODY/.claude/settings.json"
printf 'rules\n' > "$BODY/AGENTS.md"
for name in fe reviewer; do printf -- '---\nname: %s\ndescription: x\n---\nbody\n' "$name" > "$BODY/.claude/agents/$name.md"; done

python3 - "$SRC" "$BODY" "$TMP" <<'PY'
import json, os, pathlib, shutil, subprocess, sys
src, body, tmp = sys.argv[1:4]
fail = 0
def check(label, ok, detail=""):
    global fail
    print(("  ✔ " if ok else "  ✖ ") + label + ("" if ok else f" — {detail}"))
    fail |= 0 if ok else 1
def settings(mode, agent):
    out = f"{tmp}/{mode}-{agent}.json"
    if mode == "inline":
        subprocess.run(["python3", f"{src}/scripts/lib/agent_hooks.py", "inline", out, body, agent], check=True)
    else:
        subprocess.run(["python3", f"{body}/scripts/agent-context.py", agent, body, f"{tmp}/work", f"{tmp}/a.json", f"{tmp}/c.md", out], check=True)
    return json.load(open(out))
def commands(entries):
    return [hook["command"].rsplit("/", 1)[-1] for entry in entries for hook in entry["hooks"]]
for agent in ("fe", "reviewer"):
    inline, outside = settings("inline", agent), settings("context", agent)
    for event in ("PreToolUse", "Stop"):
        check(f"{agent} — {event} 훅이 두 경로에서 같다", inline["hooks"].get(event) == outside["hooks"].get(event), f"{inline['hooks'].get(event)} ≠ {outside['hooks'].get(event)}")
    check(f"{agent} — 자동 압축 시점이 두 경로에서 같다", inline.get("autoCompactWindow") == outside.get("autoCompactWindow"))
    check(f"{agent} — 알림 · pane 기록 훅이 두 경로에 모두 있다", all(
        name in commands(config["hooks"]["UserPromptSubmit"]) + commands(config["hooks"]["SessionStart"])
        for config in (inline, outside) for name in ["pane-session.py"]))
pre = commands(settings("inline", "fe")["hooks"]["PreToolUse"])
check("fe — commit-guard · secret-guard · process-guard · ask-to-request", pre == ["commit-guard.py", "secret-guard.py", "process-guard.py", "ask-to-request.py"], pre)
pre = commands(settings("inline", "reviewer")["hooks"]["PreToolUse"])
check("reviewer — secret-guard · process-guard 만(commit-guard · ask-to-request 없음)", pre == ["secret-guard.py", "process-guard.py"], pre)
reviewer = settings("inline", "reviewer")
check("reviewer — 끝 알림 · 자동 압축 없음", "Stop" not in reviewer["hooks"] and "autoCompactWindow" not in reviewer)
fe = settings("inline", "fe")
for agent in ("fe", "reviewer"):
    for mode in ("inline", "context"):
        check(f"{agent} — {mode} 에 권한 확인 알림(PermissionRequest) 훅", commands(settings(mode, agent)["hooks"].get("PermissionRequest", [])) == ["permission-to-request.py"])
check("fe — 끝 알림(prompt · stop)", [c for c in commands(fe["hooks"]["UserPromptSubmit"]) if c.startswith("agent-done-notify")] != [] and "Stop" in fe["hooks"])
# 팩 permissionsAllow — 키가 없으면 permissions 칸이 없고, 있으면 그 레포 담당 에이전트에게만 두 경로 모두 들어간다
for mode in ("inline", "context"):
    check(f"permissionsAllow 없음 — {mode} 에 permissions 없음", "permissions" not in settings(mode, "fe"))
rule = "Bash(node scripts/publish-release.js:*)"
os.makedirs(f"{body}/testpack")
json.dump({"pack": "testpack"}, open(f"{body}/athena.config.json", "w"))
json.dump({"repos": [{"name": "app", "agents": ["fe"], "permissionsAllow": [rule]}, {"name": "other", "agents": ["be"]}]}, open(f"{body}/testpack/pack.json", "w"))
for mode in ("inline", "context"):
    check(f"permissionsAllow 있음 — {mode} 담당 에이전트에 allow", settings(mode, "fe").get("permissions") == {"allow": [rule]}, settings(mode, "fe").get("permissions"))
    check(f"permissionsAllow 있음 — {mode} reviewer 에는 없음", "permissions" not in settings(mode, "reviewer"))
# Codex는 exec_command도 Bash · tool_input.command로 전달한다(공식 Hooks 문서).
# 실제 설정의 명령을 공백 든 경로·하위 폴더에서 실행해 git 루트 경로 해석도 확인한다.
codex_body = pathlib.Path(tmp) / "codex body"
(codex_body / "scripts/hooks").mkdir(parents=True)
(codex_body / "nested").mkdir()
subprocess.run(["git", "init", "-q", str(codex_body)], check=True)
for name in ("secret-guard.py", "process-guard.py", "commit-guard.py"):
    shutil.copyfile(f"{src}/scripts/hooks/{name}", codex_body / "scripts/hooks" / name)
    pathlib.Path(body, "scripts/hooks").mkdir(exist_ok=True)
    shutil.copyfile(f"{src}/scripts/hooks/{name}", pathlib.Path(body, "scripts/hooks", name))
codex = json.loads(pathlib.Path(src, ".codex/hooks.json").read_text())
entries = codex["hooks"].get("PreToolUse", [])
check("Codex — Bash 실행 전 훅으로 연결", len(entries) == 1 and entries[0].get("matcher") == "Bash", entries)
handlers = [hook for entry in entries for hook in entry["hooks"]]
check("Codex — secret · process만 연결(commit은 기존 위임 설정에만)",
      [hook["command"].split("/")[-1].rstrip('"') for hook in handlers] == ["secret-guard.py", "process-guard.py"])
for name, denied, allowed in (
    ("secret-guard.py", "cat .env", "ps -axo pid=,comm="),
    ("process-guard.py", "pkill example", "echo pkill"),
    ("commit-guard.py", "git commit -m example", "git status --short"),
):
    # commit은 Codex 공통 설정에 추가하지 않고 기존 위임 대상(fe)의 훅으로만 시험한다.
    configured = [hook["command"] for hook in handlers if name in hook["command"]]
    command = configured[0] if configured else None
    if name == "commit-guard.py":
        command = next(hook["command"] for entry in fe["hooks"]["PreToolUse"] for hook in entry["hooks"] if name in hook["command"])
    for text, expected in ((denied, 2), (allowed, 0)):
        payload = {"session_id": "codex-test", "turn_id": "turn-test", "tool_use_id": "call-test",
                   "hook_event_name": "PreToolUse", "tool_name": "Bash",
                   "cwd": str(codex_body / "nested"), "permission_mode": "default",
                   "tool_input": {"command": text}}
        result = subprocess.run(command, shell=True, cwd=codex_body / "nested", input=json.dumps(payload),
                                text=True, capture_output=True) if command else None
        check(f"Codex 입력 — {name} {expected=}", result is not None and result.returncode == expected)
        if expected == 2:
            check(f"Codex 입력 — {name} 차단 이유는 stderr", result is not None and bool(result.stderr.strip()))
sys.exit(fail)
PY
status=$?
[ $status -eq 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $status
