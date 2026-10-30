#!/usr/bin/env bash
# 위임 에이전트 훅 설정 시험 — delegate.sh(본체 안)와 agent-context.py(본체 밖)가 같은 훅을 만드는지(scripts/lib/agent_hooks.py 한 곳) · 몇 초
#
# 사용: test/agent-hooks-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BODY="$TMP/body"
mkdir -p "$BODY/.claude/agents" "$BODY/.claude/rules" "$BODY/scripts/lib" "$TMP/work"
cp "$SRC/scripts/agent-context.py" "$BODY/scripts/"; cp "$SRC/scripts/lib/agent_hooks.py" "$BODY/scripts/lib/"
printf '{"autoCompactWindow": 123}\n' > "$BODY/.claude/settings.json"
printf 'rules\n' > "$BODY/AGENTS.md"
for name in fe reviewer; do printf -- '---\nname: %s\ndescription: x\n---\nbody\n' "$name" > "$BODY/.claude/agents/$name.md"; done

python3 - "$SRC" "$BODY" "$TMP" <<'PY'
import json, subprocess, sys
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
check("fe — 끝 알림(prompt · stop)", [c for c in commands(fe["hooks"]["UserPromptSubmit"]) if c.startswith("agent-done-notify")] != [] and "Stop" in fe["hooks"])
sys.exit(fail)
PY
status=$?
[ $status -eq 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $status
