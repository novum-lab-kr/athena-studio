#!/usr/bin/env bash
# 대화 압축 훅 시험(scripts/hooks/compact-checkpoint.py) — 몇 초 · 임시 본체 사본 · 진짜 화면 · claude 를 부르지 않는다
#   ① 아테나 pane: 계획서 Checkpoint "- Lead pane:" 으로 묶인 진행 중 계획서를 모두 찾고(최근 순) · 묶인 이슈를 함께 알린다 · 스냅샷을 남긴다
#      일하는 pane(Work ref)은 그대로 하나 · plans/artifacts/ 와 Checkpoint 없는 md 는 후보에서 빠진다
#   ② warn: 대화 기록 마지막 응답의 문맥이 압축 창의 80% 를 넘으면 모델에게만 한 번 넣는다(사용자 화면 줄 없음) · 압축 직후(post) 다시 알릴 수 있게 된다
#   ③ scripts/transcript-search.mjs: 대화 원문에서 낱말이 든 대목만 짧게 · 비밀값 가림 · 압축 뒤 안내에 원문 자리
#   ④ scripts/lead-log.mjs: 리드 기록 덧붙이기(가림) · 압축 뒤 아테나 안내 맨 앞에 최근 줄 · 곧 압축 알림이 가리킨다
#
# 사용: test/compact-checkpoint-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

python3 - "$SRC" "$TMP" <<'PY'
import json, os, pathlib, shutil, subprocess, sys, time
src, tmp = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
fail = 0
def check(label, ok, detail=""):
    global fail
    print(("  ✔ " if ok else "  ✖ ") + label + ("" if ok else f" — {detail}"))
    fail |= 0 if ok else 1

body = tmp / "body"
(body / "scripts/hooks").mkdir(parents=True)
shutil.copytree(src / "scripts/lib", body / "scripts/lib", ignore=shutil.ignore_patterns("__pycache__"))
shutil.copyfile(src / "scripts/hooks/compact-checkpoint.py", body / "scripts/hooks/compact-checkpoint.py")
for name in ("transcript-search.mjs", "lead-log.mjs"):
    shutil.copyfile(src / "scripts" / name, body / "scripts" / name)
(body / ".claude").mkdir()
(body / ".claude/settings.json").write_text(json.dumps({"autoCompactWindow": 200000}))
for folder in ("plans/task", "plans/feature", "plans/artifacts/20261103-x", "issues"):
    (body / folder).mkdir(parents=True)
work = tmp / "work"
work.mkdir()
subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
subprocess.run(["git", "-C", str(work), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "처음"], check=True)

def plan(rel, status, extra, age):
    path = body / rel
    path.write_text(f"# {rel}\n\n## Checkpoint\n- Updated: 2026-11-06\n- Status: {status}\n{extra}\n\n## 지시\n검사\n")
    stamp = time.time() - age
    os.utime(path, (stamp, stamp))
    return path

old = plan("plans/task/20261101-old.md", "in_progress", "- Lead pane: px4\n- Work ref: " + str(work) + " · 🌿 main · pane p20 (fe)", 300)
new = plan("plans/task/20261105-new.md", "ready_for_review", "- Issue: issues/20261105-x-이슈.md\n- Lead pane: px4\n- Work ref: " + str(work) + " · 🌿 main · pane p21 (fe)", 100)
plan("plans/task/20261102-done.md", "done — 커밋", "- Lead pane: px4", 50)
plan("plans/task/20261103-other.md", "in_progress", "- Lead pane: px40\n- Work ref: /tmp · pane p22 (fe)", 10)
artifact = body / "plans/artifacts/20261103-x/README.md"
artifact.write_text("# 검증 표\n- Status: in_progress\n")
(body / "plans/setup").mkdir()
(body / "plans/setup/20261025-no-checkpoint.md").write_text("# 체크포인트 없음\n")
(body / "issues/20261105-x-이슈.md").write_text("---\ntitle: 계획서가 가리키는 이슈\nstatus: open\nplan:\n---\n")
(body / "issues/20261104-y-이슈.md").write_text("---\ntitle: 계획서를 가리키는 이슈\nstatus: planned\nplan: plans/task/20261101-old.md\n---\n")
(body / "issues/20261103-z-이슈.md").write_text("---\ntitle: 끝난 이슈\nstatus: done\nplan: plans/task/20261101-old.md\n---\n")
(body / "issues/20261102-w-이슈.md").write_text("---\ntitle: 묶이지 않은 이슈\nstatus: open\nplan:\n---\n")

hook = body / "scripts/hooks/compact-checkpoint.py"
marks = tmp / "marks"
def run(mode, payload, pane="", env_extra=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith(("ATHENA_", "CLAUDE_CODE_AUTO_COMPACT"))}
    env.update({"ATHENA_SCREEN": "studio", "ATHENA_STUDIO": "1", "ATHENA_STUDIO_PANE_ID": pane, "TMPDIR": str(marks) + "/"})
    env.update(env_extra or {})
    done = subprocess.run(["python3", str(hook), mode], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=20)
    return done.returncode, done.stdout.strip()
marks.mkdir()

print("① 아테나 pane 이 압축된 뒤")
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="px4")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("종료 0", code == 0, code)
check("Lead pane 으로 묶인 진행 중 계획서를 모두 · 최근 순으로", "20261105-new.md" in text and "20261101-old.md" in text
      and text.index("20261105-new.md") < text.index("20261101-old.md"), text)
check("끝난 계획서 · 다른 pane(px40) 계획서는 빠진다", "20261102-done.md" not in text and "20261103-other.md" not in text, text)
check("묶인 이슈 — 계획서 Issue 줄 · 이슈 plan 칸(끝난 · 묶이지 않은 이슈는 빠진다)", "issues/20261105-x-이슈.md" in text and "issues/20261104-y-이슈.md" in text
      and "20261103-z" not in text and "20261102-w" not in text, text)
check("찾지 못했다는 안내가 아니다", "찾지 못했다" not in text, text)

code, _ = run("pre", {"trigger": "auto", "cwd": str(body)}, pane="px4")
check("압축 직전 — 묶인 계획서마다 스냅샷", code == 0 and all("- Auto snapshot:" in path.read_text() for path in (old, new)))

print("일하는 pane 은 그대로")
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"})
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("Work ref 의 pane — 그 계획서 하나 · 기존 안내", text.startswith("🔄") and "plans/task/20261105-new.md 의 Checkpoint" in text and "20261101-old.md" not in text, text)
check("일하는 pane 에도 묶인 이슈", "issues/20261105-x-이슈.md" in text, text)
check("일하는 pane 에는 리드 기록이 없다", "리드 기록" not in text, text)

print("못 찾은 아테나 세션의 후보")
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="p99")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("후보에 plans/artifacts/ · Checkpoint 없는 md 가 없다", "찾지 못했다" in text and "artifacts" not in text and "no-checkpoint" not in text, text)
check("후보에 진행 중 계획서는 있다", "plans/task/20261105-new.md" in text, text)

print("② 압축 창 80% 알림")
transcript = tmp / "t.jsonl"
def write_transcript(tokens):
    rows = [
        {"type": "user", "message": {"role": "user", "content": "x"}},
        {"type": "assistant", "isSidechain": False, "message": {"model": "m", "usage": {"input_tokens": 2, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": tokens - 1002, "output_tokens": 5}}},
        # 하위 에이전트 · 합성 응답은 문맥 크기로 치지 않는다
        {"type": "assistant", "isSidechain": True, "message": {"usage": {"input_tokens": 1, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 10}}},
        {"type": "assistant", "message": {"model": "<synthetic>", "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}},
        {"type": "attachment", "attachment": {"x": "y" * 300000}},
    ]
    transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
payload = {"session_id": "s-1", "transcript_path": str(transcript), "hook_event_name": "PostToolUse", "cwd": str(body)}
write_transcript(150000)
code, out = run("warn", payload)
check("80% 아래(150k/200k)면 조용하다", code == 0 and out == "", out)
write_transcript(170000)
code, out = run("warn", payload)
data = json.loads(out) if out else {}
check("80% 넘으면(170k/200k) 모델에게 넣는다 · 85%", "곧 대화가 압축된다" in data.get("hookSpecificOutput", {}).get("additionalContext", "")
      and "85%" in data["hookSpecificOutput"]["additionalContext"] and data["hookSpecificOutput"]["hookEventName"] == "PostToolUse", out)
check("사용자 화면 줄(systemMessage) · /new 권하기는 없다", "systemMessage" not in data and "/new" not in out, out)
code, out = run("warn", {**payload, "hook_event_name": "UserPromptSubmit"})
check("같은 세션 두 번째는 조용하다", code == 0 and out == "", out)
code, out = run("warn", {**payload, "session_id": "s-2"})
check("다른 세션은 따로 알린다", out != "", out)
code, out = run("warn", {**payload, "agent_id": "a1", "session_id": "s-3"})
check("하위 에이전트(agent_id) 훅은 조용하다", out == "", out)
run("post", {"source": "compact", "session_id": "s-1", "cwd": str(body)})
code, out = run("warn", payload)
check("압축 직후(post) 뒤에는 다시 알린다", out != "", out)
write_transcript(20000)
run("warn", payload)
write_transcript(170000)
code, out = run("warn", payload)
check("문맥이 줄었다 다시 차면(post 훅이 못 돌았어도) 다시 알린다", out != "", out)
code, out = run("warn", {**payload, "session_id": "s-4"}, env_extra={"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400k"})
check("환경 변수 창(400k)이 먼저 — 170k 는 조용하다", out == "", out)
code, out = run("warn", {**payload, "session_id": "s-5"}, env_extra={"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200"})
check("줄여 쓴 창 200 = 200k", out != "", out)
(body / ".claude/settings.json").write_text(json.dumps({}))
code, out = run("warn", {**payload, "session_id": "s-6"})
check("창 값이 없으면(auto) 짐작하지 않고 조용하다", code == 0 and out == "", out)
code, out = run("warn", {**payload, "session_id": "s-7", "transcript_path": str(tmp / "없음.jsonl")})
check("기록이 없어도 종료 0 · 조용하다", code == 0 and out == "", out)
code, _ = run("warn", "깨진 입력")
check("깨진 입력에도 종료 0", code == 0)
(body / ".claude/settings.json").write_text(json.dumps({"autoCompactWindow": 200000}))
code, out = run("warn", {**payload, "session_id": "s-8"})
check("아테나 세션 알림은 리드 기록을 가리킨다", "lead-log.mjs" in out and "리드 기록" in out, out)
code, out = run("warn", {**payload, "session_id": "s-9"}, env_extra={"ATHENA_AGENT": "fe"})
check("위임 에이전트 알림은 리드 기록을 가리키지 않는다", out != "" and "lead-log.mjs" not in out, out)

def node(*args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ATHENA_")}
    done = subprocess.run(["node", *map(str, args)], capture_output=True, text=True, env=env, timeout=20)
    return done.returncode, done.stdout.strip()

print("③ 대화 원문 찾기")
secret = "ghp_" + "A1b2C3d4" * 4
long_tail = "가" * 2000
rows = [
    {"type": "user", "timestamp": "2026-11-06T01:00:00Z", "message": {"role": "user", "content": "release-version.js 를 읽고 배포 태그를 정한다 " + long_tail}},
    {"type": "assistant", "timestamp": "2026-11-06T01:01:00Z", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "배포 태그 생각"},
        {"type": "text", "text": "알겠다 — 다른 이야기"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "git tag -d v1 # 배포 태그 지우기"}}]}},
    {"type": "user", "timestamp": "2026-11-06T01:02:00Z", "message": {"role": "user", "content": [
        {"type": "tool_result", "content": [{"type": "text", "text": f"배포 태그 토큰 {secret} 끝"}]}]}},
    {"type": "attachment", "attachment": {"text": "배포 태그 첨부"}},
    "깨진 줄",
]
original = tmp / "original.jsonl"
original.write_text("".join((row if isinstance(row, str) else json.dumps(row, ensure_ascii=False)) + "\n" for row in rows))
code, out = node(body / "scripts/transcript-search.mjs", original, "배포", "태그", "--width", "40")
lines = out.splitlines()
check("낱말이 모두 든 대목만(말 · 도구 입력 · 도구 결과 — 생각 · 첨부 · 다른 말 제외)", code == 0 and len(lines) == 3
      and "다른 이야기" not in out and "생각" not in out and "첨부" not in out, out)
check("대목은 짧게(첫 낱말 앞뒤 --width)", all(len(line) < 200 for line in lines), [len(line) for line in lines])
check("비밀값은 가린다", secret not in out and "ghp_***" in out, out)
code, out = node(body / "scripts/transcript-search.mjs", original, "배포", "--max", "1")
check("많으면 최근 --max 개 · 생략 안내", code == 0 and "중 최근 1곳" in out and "토큰" in out and "release-version" not in out, out)
code, out = node(body / "scripts/transcript-search.mjs", original, "없는낱말")
check("못 찾으면 그렇다고 한다", code == 0 and "맞는 대목 없음" in out, out)
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(original)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"})
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("압축 뒤 안내에 원문 자리와 찾는 명령", str(original) in text and "transcript-search.mjs" in text and "짐작하지 말고" in text, text)

print("④ 리드 기록")
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="px4")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("기록이 비었으면 적는 법을 알린다", text.startswith("📝 리드 기록") and "아직 비었다" in text and "lead-log.mjs" in text, text)
code, out = node(body / "scripts/lead-log.mjs", "정정", "태그는 지우지 않는다 —\n release-version.js 가 다시 만든다", f"token={secret}")
log = body / ".lead-log.md"
saved = log.read_text() if log.exists() else ""
check("덧붙이기 — 한 줄로 · 종류 표시 · 비밀값 가림", code == 0 and saved.count("\n") == 1 and "[정정] 태그는 지우지 않는다 — release-version.js" in saved
      and secret not in saved, saved)
node(body / "scripts/lead-log.mjs", "결정", "두 번째 줄")
code, _ = node(body / "scripts/lead-log.mjs", "아무거나", "x")
check("모르는 종류는 거절(종료 2)", code == 2, code)
code, out = node(body / "scripts/lead-log.mjs", "--tail", "1")
check("--tail 최근 줄", out.endswith("[결정] 두 번째 줄") and "정정" not in out, out)
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="px4")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("압축 뒤 아테나 안내 맨 앞에 리드 기록 최근 줄 · 그다음 계획서", text.startswith("📝 리드 기록") and "[정정] 태그는" in text and "[결정] 두 번째 줄" in text
      and text.index("두 번째 줄") < text.index("20261105-new.md"), text)
sys.exit(fail)
PY
code=$?
[ "$code" = 0 ] && echo "✅ 통과"
exit "$code"
