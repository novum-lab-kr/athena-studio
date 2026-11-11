#!/usr/bin/env bash
# 대화 압축 훅 시험(scripts/hooks/compact-checkpoint.py) — 몇 초 · 임시 본체 사본 · 진짜 화면 · claude 를 부르지 않는다
#   ① 아테나 pane: 계획서 Checkpoint "- Lead pane:" 으로 묶인 진행 중 계획서를 모두 찾고(최근 순) · 묶인 이슈를 함께 알린다 · 스냅샷을 남긴다
#      일하는 pane(Work ref)은 그대로 하나 · plans/artifacts/ 와 Checkpoint 없는 md 는 후보에서 빠진다
#   ② warn: 대화 기록 마지막 응답의 문맥이 실제 압축 기준(압축 창 − 33,000)의 70% 를 넘으면 모델에게만 한 번 넣는다(사용자 화면 줄 없음) · 압축 직후(post) 다시 알릴 수 있게 된다
#      세션 첫 도구 뒤 첫 응답이 기록에 늦게 쓰여도 잠깐 기다려 알린다(2026-11-07 실측)
#   ③ scripts/transcript-search.mjs: 대화 원문에서 낱말이 든 대목만 짧게 · 비밀값 가림 · 압축 뒤 안내에 원문 자리
#   ④ scripts/lead-log.mjs: 리드 기록 덧붙이기(가림) · 압축 뒤 아테나 안내 맨 앞에 최근 줄 · 곧 압축 알림이 가리킨다
#   ⑤ Codex(--tool=codex): rollout 의 token_count · 압축 기준(codex-cli 0.166.0 소스 셈 — 설정 · 모델 limit 과 창 × 9/10 의 작은 쪽)의 70% 에서 알림 한 번 · 세션 id 로 기록 찾기 ·
#      압축 뒤 안내에 rollout 자리 · transcript-search 가 rollout 을 읽고 비밀값을 가린다(가짜 CODEX_HOME)
#   ⑥ 압축 뒤 안내 끝에 사람이 친 말 원문 최근 20개(시각 · 오래된 것부터 · 도구 결과 · 태그 글 · 이미지 · pane 알림 · 압축 요약 빼고 · 요청 답 남김 · 가림 · 글자 상한 · 4MB 1초 안) · Codex rollout 도
#   ⑦ 아테나 세션 압축 뒤 안내에 열린 요청(닫힌 것 빼고) · 에이전트 pane(셸 · 자기 pane 빼고 · 가짜 화면 CLI) · 화면 실패해도 나머지 안내
#   경계값(159,999 · 160,000 · 줄여 쓴 창 "200") · 여러 팩 구조의 리드 기록(.pack-data/state) · 안내 속 스크립트 경로가 진짜 있는지 ·
#      Codex 훅 설정(codex_dispatch)의 warn 이 --tool=codex 한 낱말 · matcher 없이 실제로 돈다 · Codex 도구 기록(function_call · custom_tool_call_output) · sk- 가림
#      (2026-11-06 망가뜨림 시험에서 못 잡은 19개 — 계획서 plans/task/20261107-…압축-대비-시험-보강…)
#
# 사용: test/compact-checkpoint-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

python3 - "$SRC" "$TMP" <<'PY'
import json, os, pathlib, re, shlex, shutil, subprocess, sys, time
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
shutil.copyfile(src / "scripts/hooks/codex-context.py", body / "scripts/hooks/codex-context.py")
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
artifact.write_text("# 검증 표\n\n## Checkpoint\n- Status: in_progress\n- Lead pane: px4\n")
(body / "plans/setup").mkdir()
(body / "plans/setup/20261025-no-checkpoint.md").write_text("# 체크포인트 없음\n")
(body / "issues/20261105-x-이슈.md").write_text("---\ntitle: 계획서가 가리키는 이슈\nstatus: open\nplan:\n---\n")
(body / "issues/20261104-y-이슈.md").write_text("---\ntitle: 계획서를 가리키는 이슈\nstatus: planned\nplan: plans/task/20261101-old.md\n---\n")
(body / "issues/20261103-z-이슈.md").write_text("---\ntitle: 끝난 이슈\nstatus: done\nplan: plans/task/20261101-old.md\n---\n")
(body / "issues/20261102-w-이슈.md").write_text("---\ntitle: 묶이지 않은 이슈\nstatus: open\nplan:\n---\n")

hook = body / "scripts/hooks/compact-checkpoint.py"
marks = tmp / "marks"
codex_home = tmp / "codex"
def run(mode, payload, pane="", env_extra=None, args=(), script=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith(("ATHENA_", "CLAUDE_CODE_AUTO_COMPACT", "CODEX_"))}
    env.update({"ATHENA_SCREEN": "studio", "ATHENA_STUDIO": "1", "ATHENA_STUDIO_PANE_ID": pane, "TMPDIR": str(marks) + "/", "CODEX_HOME": str(codex_home)})
    env.update(env_extra or {})
    command = ["python3", str(script)] if script else ["python3", str(hook), mode, *args]
    done = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=20)
    return done.returncode, done.stdout.strip()
marks.mkdir()

print("① 아테나 pane 이 압축된 뒤")
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="px4")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("종료 0", code == 0, code)
check("Lead pane 으로 묶인 진행 중 계획서를 모두 · 최근 순으로", "20261105-new.md" in text and "20261101-old.md" in text
      and text.index("20261105-new.md") < text.index("20261101-old.md"), text)
check("끝난 계획서 · 다른 pane(px40) 계획서는 빠진다", "20261102-done.md" not in text and "20261103-other.md" not in text, text)
check("plans/artifacts/ 는 Checkpoint · Lead pane 이 있어도 계획서가 아니다", "artifacts" not in text, text)
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

print("② 압축 기준 70% 알림")
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
# 창 200k → 실제 압축 167,000(Claude Code 2.1.319 — 창 − 20,000 − 13,000) → 70% 는 116,900
write_transcript(100000)
code, out = run("warn", payload)
check("70% 아래(100k / 기준 167,000)면 조용하다", code == 0 and out == "", out)
write_transcript(116899)
code, out = run("warn", {**payload, "session_id": "s-edge-1"})
check("70% 바로 아래(116,899 / 기준 167,000)도 조용하다", code == 0 and out == "", out)
write_transcript(116900)
code, out = run("warn", {**payload, "session_id": "s-edge-2"})
check("딱 70%(116,900 / 기준 167,000)면 알린다", "70%" in out and "167,000" in out, out)
write_transcript(150000)
code, out = run("warn", payload)
data = json.loads(out) if out else {}
check("넘으면(150k) 모델에게 넣는다 · 압축 기준 167,000 의 89%", "곧 대화가 압축된다" in data.get("hookSpecificOutput", {}).get("additionalContext", "")
      and "167,000 의 89%" in data["hookSpecificOutput"]["additionalContext"] and data["hookSpecificOutput"]["hookEventName"] == "PostToolUse", out)
check("사용자 화면 줄(systemMessage) · /new 권하기는 없다", "systemMessage" not in data and "/new" not in out, out)
# 사용자 글 뒤에 붙어도 미루지 않게 — 할 일(적기)을 답보다 먼저 시킨다 · "적기만" 으로 끝내지 않는다(2026-11-06 Codex 가 안 적음)
warn_text = data.get("hookSpecificOutput", {}).get("additionalContext", "")
check("알림은 답하기 전에 먼저 적으라고 시킨다", "답하기 전에 먼저" in warn_text and "적기만" not in warn_text
      and warn_text.index("답하기 전에 먼저") < warn_text.index("하던 일을 이어"), warn_text)
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
write_transcript(100000)
code, out = run("warn", {**payload, "session_id": "s-5b"}, env_extra={"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200"})
check("줄여 쓴 창 200 에서 100k 는 조용하다", code == 0 and out == "", out)
# 창 100k → 실제 압축 67,000 → 70% 는 46,900(80% 창 기준이던 때는 압축 뒤라 영영 안 떴다)
write_transcript(46899)
code, out = run("warn", {**payload, "session_id": "s-100a"}, env_extra={"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100k"})
check("창 100k 에서 46,899 는 조용하다", code == 0 and out == "", out)
write_transcript(46900)
code, out = run("warn", {**payload, "session_id": "s-100b"}, env_extra={"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100k"})
check("창 100k 에서 46,900(압축 67,000 전)이면 알린다", "67,000 의 70%" in out, out)
write_transcript(30000)
code, out = run("warn", {**payload, "session_id": "s-tiny"}, env_extra={"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "33000"})
check("창이 여유분(33,000) 이하면 기준을 몰라 조용하다", code == 0 and out == "", out)
write_transcript(170000)
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
check("아테나 세션 알림은 단계 끝에 lead-fresh.py --plan 으로 새로 시작하라고 한다", "lead-fresh.py" in out and "--plan" in out and "/new" not in out, out)
code, out = run("warn", {**payload, "session_id": "s-9"}, env_extra={"ATHENA_AGENT": "fe"})
check("위임 에이전트 알림은 리드 기록을 가리키지 않는다", out != "" and "lead-log.mjs" not in out, out)
check("위임 에이전트 알림은 스스로 새로 시작하라고 하지 않는다", "lead-fresh.py" not in out, out)

print("세션 첫 도구 뒤 — 첫 응답이 기록에 늦게 쓰인다")
# 2026-11-07 대화형 claude 실측: 첫 PostToolUse 훅이 돌 때 그 도구를 부른 응답이 아직 기록에 없다(60ms 뒤 쓰임) · 예전엔 56,439 를 놓쳤다
def assistant_row(tokens):
    return json.dumps({"type": "assistant", "isSidechain": False, "message": {"usage": {"input_tokens": 2, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": tokens - 1002}}}) + "\n"
late = tmp / "late.jsonl"
late.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "x"}}) + "\n")
env = {key: value for key, value in os.environ.items() if not key.startswith(("ATHENA_", "CLAUDE_CODE_AUTO_COMPACT", "CODEX_"))}
env.update({"ATHENA_SCREEN": "studio", "ATHENA_STUDIO": "1", "ATHENA_STUDIO_PANE_ID": "", "TMPDIR": str(marks) + "/", "ATHENA_AGENT": "fe"})
first = {**payload, "session_id": "s-first", "transcript_path": str(late), "tool_use_id": "toolu_first"}
proc = subprocess.Popen(["python3", str(hook), "warn"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
proc.stdin.write(json.dumps(first)); proc.stdin.close()
time.sleep(0.3)
with late.open("a") as stream:
    stream.write(assistant_row(150000))
out = proc.stdout.read().strip(); proc.wait(timeout=20)
check("첫 응답이 훅 시작 뒤 쓰여도 첫 도구 뒤에 알린다", proc.returncode == 0 and "150,000" in out, out)
late.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "x"}}) + "\n")
started = time.monotonic()
code, out = run("warn", {**first, "session_id": "s-first-none"}, env_extra={"ATHENA_AGENT": "fe"})
waited = time.monotonic() - started
check("끝내 안 쓰이면 잠깐(1초 남짓)만 기다리고 조용하다", code == 0 and out == "" and waited < 3, f"{out} · {waited:.2f}s")
started = time.monotonic()
code, out = run("warn", {**first, "session_id": "s-first-prompt", "hook_event_name": "UserPromptSubmit", "tool_use_id": ""}, env_extra={"ATHENA_AGENT": "fe"})
waited = time.monotonic() - started
check("메시지를 받을 때(도구 없음)는 기다리지 않는다", code == 0 and out == "" and waited < 0.8, f"{out} · {waited:.2f}s")

def node(*args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ATHENA_")}
    done = subprocess.run(["node", *map(str, args)], capture_output=True, text=True, env=env, timeout=20)
    return done.returncode, done.stdout.strip()

print("③ 대화 원문 찾기")
secret = "ghp_" + "A1b2C3d4" * 4
long_tail = "가" * 2000
rows = [
    {"type": "user", "timestamp": "2026-11-06T00:59:00Z", "message": {"role": "user", "content": "배포 만 든 말"}},
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
      and "다른 이야기" not in out and "생각" not in out and "첨부" not in out and "만 든 말" not in out, out)
check("대목은 짧게(첫 낱말 앞뒤 --width)", all(len(line) < 200 for line in lines), [len(line) for line in lines])
check("비밀값은 가린다", secret not in out and "ghp_***" in out, out)
code, out = node(body / "scripts/transcript-search.mjs", original, "배포", "--max", "1")
check("많으면 최근 --max 개 · 생략 안내", code == 0 and "중 최근 1곳" in out and "토큰" in out and "release-version" not in out, out)
narrow = tmp / "narrow.jsonl"
narrow.write_text(json.dumps({"type": "user", "timestamp": "2026-11-06T01:00:00Z", "message": {"role": "user", "content": "a" * 30 + "longwordz" + "b" * 30}}) + "\n")
code, out = node(body / "scripts/transcript-search.mjs", narrow, "longwordz", "--width", "3")
check("대목은 첫 낱말 앞뒤로 --width(낱말 길이는 따로)", code == 0 and out.endswith(": …aaalongwordzbbb…"), out)
code, out = node(body / "scripts/transcript-search.mjs", original, "없는낱말")
check("못 찾으면 그렇다고 한다", code == 0 and "맞는 대목 없음" in out, out)
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(original)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"})
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("압축 뒤 안내에 원문 자리와 찾는 명령", str(original) in text and "transcript-search.mjs" in text and "짐작하지 말고" in text, text)
def script_in(text, name):
    found = re.search(r"node '?([^\s']*/" + re.escape(name) + r")'?", text)
    return found.group(1) if found else ""
search_script = script_in(text, "transcript-search.mjs")
check("안내의 찾는 명령 경로에 스크립트가 있다", pathlib.Path(search_script).resolve() == (body / "scripts/transcript-search.mjs").resolve() and pathlib.Path(search_script).is_file(), search_script)

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
log_script = script_in(text, "lead-log.mjs")
check("안내의 리드 기록 명령 경로에 스크립트가 있다", pathlib.Path(log_script).resolve() == (body / "scripts/lead-log.mjs").resolve() and pathlib.Path(log_script).is_file(), log_script)

print("여러 팩 구조의 리드 기록")
pack_real = tmp / "data/packs/p1"
(pack_real / "state").mkdir(parents=True)
(body / ".pack-data").symlink_to(pack_real)
for number in range(1, 18):
    node(body / "scripts/lead-log.mjs", "사실", f"팩 줄 {number:02d}")
# 훅은 본체 자리를 실제 경로(/private/var/…)로 · 활성 링크는 풀지 않고 적는다
packed = body.resolve() / ".pack-data/state/lead-log.md"
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="px4")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("팩 데이터 state/lead-log.md — lead-log.mjs 가 쓴 곳을 압축 뒤 안내가 읽는다", packed.is_file() and f"📝 리드 기록({packed})" in text
      and "팩 줄 17" in text and "두 번째 줄" not in text, text)
check("최근 15줄만 — 앞 줄은 빠진다", "팩 줄 03" in text and "팩 줄 02" not in text and "팩 줄 01" not in text, text)
write_transcript(170000)
code, out = run("warn", {**payload, "session_id": "s-pack"})
check("곧 압축 알림도 같은 리드 기록 자리를 가리킨다", str(packed) in out, out)
(body / ".pack-data").unlink()

print("⑤ Codex")
codex = ["--tool=codex"]
sid = "01a1b0e5-8485-7511-93d3-07a159f7aa3a"
day = codex_home / "sessions/2026/11/06"
day.mkdir(parents=True)
rollout = day / f"rollout-2026-11-06T21-46-34-{sid}.jsonl"
(codex_home / "models_cache.json").write_text(json.dumps({"models": [{"slug": "m-500", "context_window": 500000, "max_context_window": 800000, "effective_context_window_percent": 95},
                                                                     {"slug": "m-own", "context_window": 500000, "auto_compact_token_limit": 300000},
                                                                     {"slug": "m-noeff", "context_window": 500000},
                                                                     {"slug": "m-nowin", "auto_compact_token_limit": 300000}]}))
def write_rollout(tokens, model="m-500"):
    rows = [
        {"type": "session_meta", "payload": {"id": sid, "session_id": sid}},
        {"type": "turn_context", "payload": {"model": model}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": tokens - 100, "output_tokens": 100, "total_tokens": tokens}, "model_context_window": 475000}}},
        # info 가 null 인 token_count(요금 한도만) · 다른 줄은 문맥 크기로 치지 않는다
        {"type": "event_msg", "payload": {"type": "token_count", "info": None}},
        {"type": "response_item", "payload": {"type": "reasoning", "summary": [], "encrypted_content": "y" * 300000}},
    ]
    rollout.write_text("".join(json.dumps(row) + "\n" for row in rows))
cpay = {"session_id": sid, "hook_event_name": "PostToolUse", "cwd": str(body)}
write_rollout(300000)
code, out = run("warn", cpay, args=codex)
write_rollout(314999)
code, out = run("warn", cpay, args=codex)
check("70% 바로 아래(314,999 / 기준 450,000)는 조용하다", code == 0 and out == "", out)
write_rollout(315000)
code, out = run("warn", {**cpay, "session_id": "s-c70", "transcript_path": str(rollout)}, args=codex)
check("딱 70%(315,000 / 기준 450,000)면 알린다", "450,000 의 70%" in out, out)
write_rollout(300000)
code, out = run("warn", cpay, args=codex)
check("70% 아래(300k / 기준 450k = 500k 의 90%)면 조용하다", code == 0 and out == "", out)
write_rollout(380000)
code, out = run("warn", cpay, args=codex)
data = json.loads(out) if out else {}
context_text = data.get("hookSpecificOutput", {}).get("additionalContext", "")
check("넘으면(380k) transcript_path 없이 세션 id 로 기록을 찾아 모델에게만 · 84%", "곧 대화가 압축된다" in context_text and "84%" in context_text
      and "450,000" in context_text and data["hookSpecificOutput"]["hookEventName"] == "PostToolUse" and "systemMessage" not in data, out)
code, out = run("warn", {**cpay, "hook_event_name": "UserPromptSubmit"}, args=codex)
check("같은 세션 두 번째는 조용하다", code == 0 and out == "", out)
code, out = run("post", {"source": "compact", "session_id": sid, "cwd": str(body)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"}, args=codex)
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("압축 뒤 안내에 Codex 기록(rollout) 자리와 찾는 명령", str(rollout) in text and "transcript-search.mjs" in text, text)
code, out = run("", {"source": "compact", "session_id": sid, "cwd": str(body)}, pane="px4", script=body / "scripts/hooks/codex-context.py")
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("Codex 세션 시작 훅(codex-context.py)의 압축 뒤 안내에도 rollout 자리 — transcript_path 없이 세션 id 로", str(rollout) in text, text)
code, out = run("warn", cpay, args=codex)
check("압축 직후(post) 뒤에는 다시 알린다", out != "", out)
other = tmp / "other-rollout.jsonl"
shutil.copyfile(rollout, other)
write_rollout(10000)
code, out = run("warn", {**cpay, "session_id": "s-c1", "transcript_path": str(other)}, args=codex)
check("훅 입력 transcript_path 가 있으면 그 기록을 먼저", out != "", out)
older = codex_home / "sessions/2026/11/05" / rollout.name
older.parent.mkdir(parents=True)
write_rollout(10000)
shutil.copyfile(rollout, older)
write_rollout(380000)
stamp = time.time() - 3600
os.utime(older, (stamp, stamp))
code, out = run("warn", {**cpay, "session_id": sid, "hook_event_name": "UserPromptSubmit"}, args=codex)
run("post", {"source": "compact", "session_id": sid, "cwd": str(body)}, args=codex)
code, out = run("warn", cpay, args=codex)
check("같은 세션 id 기록이 둘이면 최근에 고친 것(380k)을 읽는다", "84%" in out, out)
older.unlink()
# 압축 기준 셈 — codex-cli 0.166.0 소스(compact-checkpoint.py codex_compact_limit 주석의 파일 · 줄)와 같은 값인지
def limit_case(label, config_text, tokens, expect, model="m-500"):
    if config_text is None:
        (codex_home / "config.toml").unlink(missing_ok=True)
    else:
        (codex_home / "config.toml").write_text(config_text)
    write_rollout(tokens, model)
    code, out = run("warn", {**cpay, "session_id": f"s-{len(label)}-{abs(hash(label)) % 10**8}", "transcript_path": str(rollout)}, args=codex)
    if expect is None:
        check(f"{label} — 조용하다", code == 0 and out == "", out)
    else:
        check(f"{label} — 기준 {expect:,}", f"{expect:,}" in out, out)
limit_case("설정 limit 이 창의 90% 보다 크면 90%(min)", "model = \"m-500\"\nmodel_auto_compact_token_limit = 600_000\n\n[tui]\nx = 1\n", 380000, 450000)
limit_case("설정 limit 이 더 작으면 그 값", "model_auto_compact_token_limit = 360_000\n", 300000, 360000)
limit_case("설정 model_context_window 는 모델 max_context_window 로 자른다", "model_context_window = 1_000_000\n", 600000, 720000)
limit_case("설정 model_context_window 272k → 244,800", "model_context_window = 272000\n", 230000, 244800)
limit_case("턴 끝 압축 % — 창 × 95% × 70%", "model_post_turn_compact_threshold_percent = 70\n", 300000, 332500)
limit_case("scope = total 은 기본과 같다", "model_auto_compact_token_limit_scope = \"total\"\n", 380000, 450000)
limit_case("scope = body_after_prefix 는 앞부분 크기를 몰라", "model_auto_compact_token_limit_scope = \"body_after_prefix\"\n", 380000, None)
limit_case("features.token_budget 이 켜져 있으면 여유 토큰을 몰라", "[features]\ntoken_budget = true\n", 380000, None)
limit_case("[features.token_budget] 표도 같다", "[features.token_budget]\nenabled = true\n", 380000, None)
limit_case("features.token_budget = false 는 기본과 같다", "[features]\ntoken_budget = false\n", 380000, 450000)
limit_case("표 안의 같은 키는 맨 위 설정으로 치지 않는다", "[profiles.x]\nmodel_auto_compact_token_limit = 100\n", 380000, 450000)
limit_case("모델마다 정한 auto_compact_token_limit 도 min", None, 380000, 300000, model="m-own")
limit_case("설정 값 뒤 주석은 값이 아니다", "model_auto_compact_token_limit = 360_000 # 주석\n", 300000, 360000)
limit_case("모델에 effective_context_window_percent 가 없으면 95 — 창 × 95% × 70%", "model_post_turn_compact_threshold_percent = 70\n", 300000, 332500, model="m-noeff")
limit_case("창을 모르는 모델은 auto_compact_token_limit 그대로", None, 280000, 300000, model="m-nowin")
limit_case("모델이 models_cache 에 없으면", None, 380000, None, model="m-none")
code, out = run("warn", {**cpay, "session_id": "없는-세션-0000"}, args=codex)
check("기록을 못 찾아도 종료 0 · 조용하다", code == 0 and out == "", out)

print("Codex 훅 설정의 warn")
(codex_home / "config.toml").unlink(missing_ok=True)
write_rollout(380000)
sys.path.insert(0, str(body / "scripts/lib"))
import codex_dispatch
(tmp / "context.md").write_text("문맥")
(tmp / "agents.json").write_text(json.dumps({"fe": {"prompt": "프로필"}}))
_, dispatched = codex_dispatch.settings(body, "fe", "agent", tmp / "context.md", tmp / "agents.json")
lead_hooks = json.loads((src / ".codex/hooks.json").read_text())["hooks"]
def warn_handlers(hooks, event):
    return [(entry, handler) for entry in hooks.get(event, []) for handler in entry["hooks"] if "compact-checkpoint.py" in handler["command"] and " warn" in handler["command"]]
for name, hooks in (("위임", dispatched), ("아테나", lead_hooks)):
    for event in ("UserPromptSubmit", "PostToolUse"):
        found = warn_handlers(hooks, event)
        check(f"{name} {event} — warn 이 --tool=codex 한 낱말로", len(found) == 1 and shlex.split(found[0][1]["command"])[-2:] == ["warn", "--tool=codex"], found)
    post = warn_handlers(hooks, "PostToolUse")
    check(f"{name} PostToolUse warn — matcher 없이 모든 도구 뒤", len(post) == 1 and "matcher" not in post[0][0], post)
run("post", {"source": "compact", "session_id": sid, "cwd": str(body)}, args=codex)
for event in ("UserPromptSubmit", "PostToolUse"):
    handler = warn_handlers(dispatched, event)[0][1]
    env = {key: value for key, value in os.environ.items() if not key.startswith(("ATHENA_", "CODEX_"))}
    env.update({"ATHENA_SCREEN": "studio", "ATHENA_STUDIO": "1", "ATHENA_STUDIO_PANE_ID": "", "ATHENA_AGENT": "fe", "TMPDIR": str(marks) + "/", "CODEX_HOME": str(codex_home)})
    done = subprocess.run(["bash", "-c", handler["command"]], input=json.dumps({**cpay, "session_id": sid, "hook_event_name": event}), capture_output=True, text=True, env=env, timeout=20)
    check(f"위임 {event} warn 명령을 그대로 돌리면 Codex 기록으로 알린다", done.returncode == 0 and "450,000" in done.stdout, done.stdout + done.stderr)
    run("post", {"source": "compact", "session_id": sid, "cwd": str(body)}, args=codex)

openai_key = "sk-" + "Q9w8E7r6" * 3
crows = [
    {"type": "session_meta", "payload": {"id": sid}},
    {"type": "response_item", "timestamp": "2026-11-06T01:00:00Z", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "배포 태그 지시문"}]}},
    {"type": "response_item", "timestamp": "2026-11-06T01:00:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "배포 태그를 정한다"}]}},
    {"type": "response_item", "timestamp": "2026-11-06T01:01:00Z", "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "배포 태그 생각"}]}},
    {"type": "response_item", "timestamp": "2026-11-06T01:01:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "다른 이야기"}]}},
    {"type": "response_item", "timestamp": "2026-11-06T01:02:00Z", "payload": {"type": "custom_tool_call", "name": "exec", "input": "git tag -d v1 // 배포 태그 지우기"}},
    {"type": "response_item", "timestamp": "2026-11-06T01:03:00Z", "payload": {"type": "function_call_output", "output": [{"type": "input_text", "text": f"배포 태그 토큰 {secret} 끝"}]}},
    {"type": "response_item", "timestamp": "2026-11-06T01:03:10Z", "payload": {"type": "function_call", "name": "shell", "arguments": json.dumps({"cmd": "배포 태그 함수인자"}, ensure_ascii=False)}},
    {"type": "response_item", "timestamp": "2026-11-06T01:03:20Z", "payload": {"type": "custom_tool_call_output", "output": f"배포 태그 커스텀결과 {openai_key}"}},
    {"type": "compacted", "timestamp": "2026-11-06T01:04:00Z", "payload": {"message": "배포 태그 요약", "replacement_history": []}},
    {"type": "event_msg", "timestamp": "2026-11-06T01:05:00Z", "payload": {"type": "agent_message", "message": "배포 태그 이벤트(같은 말이 response_item 에도 있다)"}},
]
crollout = tmp / "codex-original.jsonl"
crollout.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in crows))
code, out = node(body / "scripts/transcript-search.mjs", crollout, "배포", "태그")
lines = out.splitlines()
check("Codex 기록 — 말 · 도구 입력 · 도구 결과 · 압축 요약만(지시문 · 생각 · 이벤트 · 다른 말 제외)", code == 0 and len(lines) == 6
      and "지시문" not in out and "생각" not in out and "이벤트" not in out and "다른 이야기" not in out
      and "user: 배포 태그를" in out and "[exec]" in out and "[결과]" in out and "압축 요약: 배포 태그 요약" in out, out)
check("Codex 함수 호출 인자(function_call arguments) · 사용자 도구 결과(custom_tool_call_output)도 읽는다", "[shell]" in out and "함수인자" in out and "[결과] 배포 태그 커스텀결과" in out, out)
check("Codex 기록도 비밀값은 가린다(ghp_ · sk-)", secret not in out and "ghp_***" in out and openai_key not in out and "sk-***" in out, out)

print("⑥ 압축 뒤 안내 — 최근 사용자 말 원문")
def human(text, minute, **extra):
    return {"type": "user", "timestamp": f"2026-11-07T03:{minute:02d}:00Z", "origin": {"kind": "human"}, "promptSource": "typed",
            "message": {"role": "user", "content": text}, **extra}
wrows = [human(f"옛 말 {index}", index) for index in range(10)]
wrows += [
    human("사람 말 하나 — 정정: 문구는 짧게", 20),
    {"type": "user", "timestamp": "2026-11-07T03:21:00Z", "isMeta": True, "message": {"role": "user", "content": "[Image: original 2800x1800]"}},
    {"type": "user", "timestamp": "2026-11-07T03:22:00Z", "message": {"role": "user", "content": [{"type": "tool_result", "content": "도구결과글"}]}},
    {"type": "user", "timestamp": "2026-11-07T03:23:00Z", "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": "작업알림글"}},
    human("<system-reminder>태그글</system-reminder>", 24),
    human("<command-name>/clear</command-name>", 25),
    human("[athena-studio-fe → 아테나] 알림만 든 글", 26),
    human("근데 이것도 봐줘[athena-studio-fe → 아테나] ⏸ 멈춤 뒤에 붙은 알림", 27),
    {"type": "user", "timestamp": "2026-11-07T03:28:00Z", "isCompactSummary": True, "message": {"role": "user", "content": "압축요약글"}},
    human("[요청 r-20261107-033000-ab12] 어느 쪽? — 답: 추천대로", 30),
    human(f"키는 {secret} 이거야", 31),
    human("긴 말 " + "가" * 600, 32),
    {"type": "user", "timestamp": "2026-11-07T03:33:00Z", "origin": {"kind": "human"},
     "message": {"role": "user", "content": [{"type": "text", "text": "그림 붙인 말 [Image #1]"}, {"type": "image", "source": {}}]}},
    {"type": "assistant", "timestamp": "2026-11-07T03:34:00Z", "message": {"content": [{"type": "text", "text": "응답글"}]}},
]
wrows += [human(f"새 말 {index}", 40 + index) for index in range(8)]
words_transcript = tmp / "words.jsonl"
words_transcript.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in wrows))
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(words_transcript)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"})
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
block = text[text.index("💬"):] if "💬" in text else ""
listed = [line for line in block.splitlines() if line.startswith("- ")]
check("기존 안내(계획서 다시 읽기 · 원문 찾기)는 그대로 · 그 뒤에 사용자 말 묶음", code == 0 and text.startswith("🔄") and "transcript-search.mjs" in text
      and text.index("transcript-search.mjs") < text.index("💬"), text)
check("최근 20개만 · 오래된 것부터", len(listed) == 20 and bool(listed) and "새 말 7" in listed[-1] and "옛 말 3" not in block
      and listed[0].endswith("옛 말 4"), block)
check("사람 말 · 요청 답은 남는다 · 시각이 붙는다", "정정: 문구는 짧게" in block and "[요청 r-20261107-033000-ab12] 어느 쪽? — 답: 추천대로" in block
      and re.search(r"^- 2026-11-07 \d\d:\d\d ", block, re.M) is not None, block)
check("이미지 · 도구 결과 · 작업 알림 · 태그 글 · 압축 요약 · 응답은 뺀다", all(word not in block for word in
      ("Image", "도구결과글", "작업알림글", "태그글", "/clear", "압축요약글", "응답글")) and "그림 붙인 말" in block, block)
check("pane 알림은 빼고, 사람 글 뒤에 붙은 알림은 그 앞까지", "알림만 든 글" not in block and "근데 이것도 봐줘" in block and "멈춤 뒤에 붙은" not in block, block)
check("비밀값은 가린다", secret not in text and "ghp_***" in block, block)
long_line = next((line for line in listed if "긴 말" in line), "")
check("한 개 글자 상한(300)", long_line.endswith("…") and len(long_line) < 340, long_line)
check("일하는 pane 에는 열린 요청 · pane 목록이 없다", "📮" not in text and "🧩" not in text, text)

# 같은 글이 거듭된 기록(이어 붙인 세션 사본) · 전체 글자 상한 · 4MB 기록 빠르기
many = [human("되풀이된 말", 1), human("되풀이된 말", 2)] + [human(f"{index}번 " + "나" * 290, 3 + index % 50) for index in range(30)]
big = tmp / "big.jsonl"
filler = json.dumps({"type": "attachment", "attachment": {"x": "y" * 4000}})
with big.open("w") as stream:
    stream.write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in many[:2]))
    for _ in range(1000):
        stream.write(filler + "\n")
    stream.write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in many[2:5]))
started = time.monotonic()
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(big)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"})
elapsed = time.monotonic() - started
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check(f"4MB 기록도 1초 안에 끝까지 거꾸로 읽는다({elapsed:.2f}초)", big.stat().st_size > 4_000_000 and elapsed < 1.0 and "되풀이된 말" in text, f"{elapsed:.2f}초")
check("같은 글은 하나만", text.count("되풀이된 말") == 1, text)
full = tmp / "full.jsonl"
full.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in many))
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(full)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"})
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
block = text[text.index("💬"):] if "💬" in text else ""
check("묶음 전체 글자 상한(4,000 — 오래된 것부터 빠진다) · 안내 전체 상한(9,000)", 0 < len(block) < 4300 and "29번" in block and "되풀이된 말" not in block
      and len(text) <= 9000, f"{len(block)} · {len(text)}")

print("Codex 기록의 사용자 말")
crows = [
    {"type": "response_item", "timestamp": "2026-11-07T04:00:00Z", "payload": {"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "# AGENTS.md instructions\n<INSTRUCTIONS>지시문</INSTRUCTIONS>"}, {"type": "input_text", "text": "<environment_context>환경</environment_context>"}]}},
    {"type": "response_item", "timestamp": "2026-11-07T04:01:00Z", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "개발자글"}]}},
    {"type": "response_item", "timestamp": "2026-11-07T04:02:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "코덱스 사람 말"}]}},
    {"type": "response_item", "timestamp": "2026-11-07T04:03:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": " <in-app-browser-context>앱글</in-app-browser-context>"}]}},
    {"type": "response_item", "timestamp": "2026-11-07T04:04:00Z", "payload": {"type": "function_call_output", "output": "코덱스도구결과"}},
    {"type": "compacted", "timestamp": "2026-11-07T04:05:00Z", "payload": {"message": "", "replacement_history": [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "압축사본말"}]}]}},
    {"type": "response_item", "timestamp": "2026-11-07T04:06:00Z", "payload": {"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "[아테나 pw3 → 다이어그램 담당 아테나 pw0] 코덱스 pane 알림"}]}},
    {"type": "response_item", "timestamp": "2026-11-07T04:07:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "코덱스응답"}]}},
]
words_rollout = tmp / "words-rollout.jsonl"
words_rollout.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in crows))
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(words_rollout)}, pane="p21", env_extra={"ATHENA_AGENT": "fe"}, args=codex)
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
block = text[text.index("💬"):] if "💬" in text else ""
check("Codex — response_item user 의 사람 말만(지시문 · 환경 · 개발자 · 도구 결과 · 압축 사본 · pane 알림 · 응답 제외)",
      "코덱스 사람 말" in block and all(word not in block for word in ("지시문", "환경", "개발자글", "앱글", "코덱스도구결과", "압축사본말", "코덱스 pane 알림", "코덱스응답")), block)

print("⑦ 아테나 세션 — 열린 요청 · 에이전트 pane")
shutil.copyfile(src / "scripts/athena.mjs", body / "scripts/athena.mjs")
def athena_cli(*args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ATHENA_")}
    return subprocess.run(["node", str(body / "scripts/athena.mjs"), *args], capture_output=True, text=True, env=env, cwd=str(body), timeout=20)
opened = athena_cli("request", "open", "--kind", "question", "--title", f"배포 순서를 정해 주세요 토큰 {secret}", "--pane", "p30", "--json")
first_id = json.loads(opened.stdout)["request"]["id"] if opened.returncode == 0 else ""
closed = athena_cli("request", "open", "--kind", "decision", "--title", "취소될 요청", "--json")
closed_id = json.loads(closed.stdout)["request"]["id"] if closed.returncode == 0 else ""
athena_cli("request", "cancel", closed_id)
fixture = tmp / "screen-fixture"
fixture.mkdir()
(fixture / "pane_list.json").write_text(json.dumps({"panes": [
    {"id": "px4", "label": "아테나", "agent": "claude", "agent_status": "idle"},
    {"id": "p30", "label": "🤖 athena-studio-fe · fix/x", "agent": "claude", "agent_status": "working"},
    {"id": "p31", "label": "빈 셸", "agent": None, "agent_status": None},
    {"id": "p32", "label": "🤖 reviewer", "agent": "codex", "agent_status": "blocked"},
]}, ensure_ascii=False))
fake_cli = {"ATHENA_STUDIO_CLI": str(src / "scripts/screen-check/fake-bin/athena-studio-cli"), "ATHENA_STUDIO_SOCKET": str(tmp / "no.sock"),
            "FAKE_SCREEN_FIXTURE": str(fixture)}
code, out = run("post", {"source": "compact", "cwd": str(body), "transcript_path": str(words_transcript)}, pane="px4", env_extra=fake_cli)
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("요청 시험 준비(request open)", bool(first_id) and bool(closed_id), opened.stderr + closed.stderr)
check("아테나 안내 — 리드 기록 · 계획서 목록은 그대로 · 사용자 말 · 열린 요청 · pane 이 이어 붙는다", code == 0 and text.startswith("📝") and "20261105-new.md" in text
      and text.index("💬") < text.index("📮") < text.index("🧩"), text)
requests_block = text[text.index("📮"):text.index("🧩")] if "📮" in text and "🧩" in text else ""
check("열린 요청 — id · 종류 · 상태 · pane · 제목 한 줄(닫힌 것은 빠진다 · 비밀값 가림)", f"{first_id} · question · open · pane p30 — 배포 순서를 정해 주세요" in requests_block
      and closed_id not in requests_block and secret not in requests_block and "ghp_***" in requests_block, requests_block)
panes_block = text[text.index("🧩"):] if "🧩" in text else ""
check("에이전트 pane — id · 상태 · 이름표(셸 pane · 이 아테나 pane 은 뺀다)", "- p30 · working · 🤖 athena-studio-fe · fix/x" in panes_block
      and "- p32 · blocked · 🤖 reviewer" in panes_block and "p31" not in panes_block and "px4" not in panes_block, panes_block)
fail_fixture = tmp / "screen-fail"
fail_fixture.mkdir()
(fail_fixture / "any.exit").write_text("3")
code, out = run("post", {"source": "compact", "cwd": str(body)}, pane="px4", env_extra={**fake_cli, "FAKE_SCREEN_FIXTURE": str(fail_fixture)})
text = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""
check("화면을 못 읽어도 나머지 안내는 낸다 · 종료 0", code == 0 and text.startswith("📝") and "📮" in text and "🧩" not in text, text)
sys.exit(fail)
PY
code=$?
[ "$code" = 0 ] && echo "✅ 통과"
exit "$code"
