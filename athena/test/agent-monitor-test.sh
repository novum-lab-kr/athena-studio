#!/usr/bin/env bash
# 가짜 Claude·Codex 기록만으로 탐색·라벨·실시간 렌더링·시간 규칙을 확인한다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$SRC" <<'PY'
import contextlib, importlib.util, io, json, os, pathlib, sys, tempfile, types
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitor", pathlib.Path(sys.argv[1], "scripts/agent-monitor.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
fail = 0
def check(label, ok):
    global fail
    print(("  ✔ " if ok else "  ✖ ") + label)
    fail |= not ok
def row(kind, payload):
    return json.dumps({"type": kind, "payload": payload}, ensure_ascii=False) + "\n"

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    now = 2000000000
    claude = root / ".claude/projects"
    codex = root / ".codex/sessions/2026/11/03"
    codex.mkdir(parents=True)
    body = root / "body"
    (body / "scripts").mkdir(parents=True)
    worktrees = root / "packs/demo/worktrees"
    worktrees.mkdir(parents=True)
    (body / ".worktrees").symlink_to(worktrees, target_is_directory=True)
    cwd = str(worktrees / "shop/fix-monitor")
    meta = row("session_meta", {"cwd": cwd, "git": {"branch": "fix/monitor"}})
    def write(path, text, age=0):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        os.utime(path, (now-age, now-age))
        return str(path)
    active = write(codex / "rollout-active.jsonl", meta)
    old = write(codex / "rollout-old.jsonl", meta, 7201)
    lead = write(codex / "rollout-lead.jsonl", row("session_meta", {"cwd": str(body)}))
    legacy = write(codex / "rollout-legacy.jsonl", row("session_meta", {"cwd": str(body / ".worktrees/shop/fix-old")}))
    ordinary = str(root / "plain/shop")
    plain = write(codex / "rollout-plain.jsonl", row("session_meta", {"cwd": ordinary}))
    other_cwd = str(root / "packs/other/worktrees/shop/fix")
    other = write(codex / "rollout-other.jsonl", row("session_meta", {"cwd": other_cwd}))
    def claude_session(cwd):
        name = m.re.sub(r"[^A-Za-z0-9]", "-", cwd)
        return write(claude / name / "session.jsonl", json.dumps({"cwd": cwd})+"\n")
    pairs = [(lead, claude_session(str(body))), (plain, claude_session(ordinary)), (other, claude_session(other_cwd))]
    broken = write(codex / "rollout-broken.jsonl", "{unfinished")
    claude_pane = write(claude / "tmp-packs-demo-worktrees-shop-fix-x/a.jsonl", json.dumps({"cwd": cwd, "gitBranch": "fix/claude"})+"\n")
    claude_sub = write(claude / "project/session/subagents/agent-a.jsonl", "")
    with patch.object(m, "active_agent_cwds", return_value=[ordinary, str(body)], create=True), patch.object(m, "__file__", str(body / "scripts/agent-monitor.py")), patch.object(m.os.path, "expanduser", side_effect=lambda p: str(root / p.removeprefix("~/"))), patch.object(m.time, "time", return_value=now):
        found = dict(m.find_recent(120))
    check("Codex 워크트리 세션 탐색", found.get(active) is True)
    check("옛 .worktrees 경로 탐색", found.get(legacy) is True)
    check("2시간 지난 세션 제외", old not in found)
    check("아테나 본체·깨진 기록 제외", lead not in found and broken not in found)
    check("Claude pane·서브에이전트 탐색 유지", found.get(claude_pane) is True and found.get(claude_sub) is False)
    check("Python — 일반 pane 포함·다른 팩 포함", plain in found and other in found)
    check("Python — 본체/일반 pane/다른 팩의 Claude·Codex 실제 탐색 일치", all((codex_path in found) == (claude_path in found) for codex_path, claude_path in pairs))
    check("Codex 레포·브랜치 라벨", m.pane_label(active) == "shop·fix/monitor")
    check("Claude 라벨 유지", m.pane_label(claude_pane) == "shop·fix/claude")
    t = m.Tail(active, 0, True)
    try:
        t.read_new()
        command = row("response_item", {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "git status --short"})})
        rows = m.render(t, command)
        check("Codex 도구 한 줄·라벨·요약", len(rows) == 1 and "[shop·fix/monitor]" in rows[0] and "Bash" in rows[0] and "git status --short" in rows[0])
        user = row("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "모니터를 고쳐 주세요"}]})
        m.render(t, row("turn_context", {"model": "codex-model-a"}))
        check("Codex 모델 문맥 뒤 명령에 모델 표시", any("codex-model-a" in x and "⚙" in x for x in m.render(t, command)))
        m.render(t, row("event_msg", {"type": "thread_settings_applied", "thread_settings": {"model": "codex-model-b"}}))
        check("Codex 모델 변경 뒤 요약에 모델 표시", any("codex-model-b" in x for x in m.render(t, row("response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "모델 변경 확인"}]}))))
        check("Codex 사용자 지시", any("👤" in x and "모니터" in x for x in m.render(t, user)))
        assistant = row("response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "수정을 확인했습니다"}]})
        check("Codex 에이전트 요약", any("💬" in x and "확인" in x for x in m.render(t, assistant)))
        custom = row("response_item", {"type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: demo.py\n*** End Patch"})
        check("Codex 자유 형식 도구", any("apply_patch" in x and "Update demo.py" in x and "✏️" in x and "codex-model-b" in x for x in m.render(t, custom)))
        added = row("response_item", {"type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Add File: new.txt\n+FAKE_PATCH_MARKER\n*** End Patch"})
        check("Codex 파일 추가는 Write 아이콘", any("📝" in x for x in m.render(t, added)))
        m.render(t, row("turn_context", {"model": None}))
        check("기록에 모델이 비면 이전 모델 미표시", all("codex-model" not in x for x in m.render(t, command)))
        patch_text = "*** Begin Patch\n*** Add File: new.txt\n+FAKE_PATCH_MARKER\n*** Update File: old.txt\n@@\n-FAKE_PATCH_MARKER\n+changed\n*** Move to: moved.txt\n*** Delete File: gone.txt\n*** End Patch"
        for kind in ("custom_tool_call", "function_call"):
            payload = {"type": kind, "name": "apply_patch"}
            payload.update({"input": patch_text} if kind == "custom_tool_call" else {"arguments": json.dumps({"patch": patch_text})})
            normalized = m.codex_message({"type": "response_item", "payload": payload})
            rendered = " ".join(m.render(t, row("response_item", payload)))
            check(f"{kind} 추가·수정·이동·삭제 경로만 남김", normalized["message"]["content"][0]["input"] == {"changes": [{"kind": "Add", "path": "new.txt"}, {"kind": "Update", "path": "old.txt"}, {"kind": "Move", "path": "moved.txt"}, {"kind": "Delete", "path": "gone.txt"}]})
            check(f"{kind} 패치 본문 비노출", "FAKE_PATCH_MARKER" not in json.dumps(normalized) and "FAKE_PATCH_MARKER" not in rendered and "changed" not in rendered)
            summary = m.summarize_tool("apply_patch", normalized["message"]["content"][0]["input"])
            check(f"{kind} 작업·경로 요약", summary.startswith("Add new.txt") and "Update old.txt" in summary)
        malformed = row("response_item", {"type": "custom_tool_call", "name": "apply_patch", "input": "FAKE_PATCH_MARKER"})
        check("잘못된 패치도 본문 비노출", "FAKE_PATCH_MARKER" not in " ".join(m.render(t, malformed)))
        check("Codex 잘못된 arguments는 건너뜀", m.render(t, row("response_item", {"type": "function_call", "name": "exec_command", "arguments": "{"})) == [])
        check("Codex 도구 출력·이벤트 중복은 표시 안 함", m.render(t, row("response_item", {"type": "function_call_output", "output": "가짜 출력"})) == [] and m.render(t, row("event_msg", {"type": "item_completed", "item": {"type": "AgentMessage", "text": "중복"}})) == [])
        with open(active, "a") as f: f.write(command[:-1])
        check("부분 줄은 다음 입력까지 대기", t.read_new() == [])
        with open(active, "a") as f: f.write("\n")
        check("이어 쓴 줄을 실시간으로 한 번 읽음", len(t.read_new()) == 1 and t.read_new() == [])
    finally:
        t.f.close()
    c = m.Tail(claude_pane, 1, True)
    try:
        check("Claude 도구 렌더링 유지", any("Bash" in x and "git status" in x for x in m.render(c, json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "git status"}}]}}))))
    finally: c.f.close()
    fake_screen = types.SimpleNamespace(list_panes=lambda timeout: [
        {"agent": "codex", "cwd": "/tmp/repo", "foreground_cwd": "/tmp/repo/src"},
        {"agent": "claude", "cwd": "/tmp/other"}, {"agent": None, "cwd": "/tmp/shell"}])
    if hasattr(m, "active_agent_cwds"):
        with patch.dict(sys.modules, {"screen": fake_screen}):
            check("화면 계층의 활성 에이전트 경로 전달", m.active_agent_cwds() == ["/tmp/repo/src", "/tmp/other"])
        def unavailable(timeout): raise RuntimeError("가짜 화면 연결 실패")
        with patch.dict(sys.modules, {"screen": types.SimpleNamespace(list_panes=unavailable)}):
            check("화면 연결 실패 때 워크트리 탐색 계속", m.active_agent_cwds() == [])
    else: check("화면 계층의 활성 에이전트 경로 전달", False)
    clock = [now]
    def tick(_):
        if clock[0] > now: raise KeyboardInterrupt
        clock[0] += 601
    output = io.StringIO()
    with patch.object(sys, "argv", ["agent-monitor.py", "--stay", "--recent"]), patch.object(m, "find_recent", return_value=[]), patch.object(m.time, "time", side_effect=lambda: clock[0]), patch.object(m.time, "sleep", side_effect=tick), patch.object(m, "IDLE_ALERT_SEC", 600), contextlib.redirect_stdout(output):
        m.main()
    check("10분 조용하면 알림 한 번", output.getvalue().count("🔔") == 1)

print("✅ 통과" if not fail else "❌ 실패")
sys.exit(int(fail))
PY
