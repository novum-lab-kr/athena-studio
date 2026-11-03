#!/usr/bin/env python3
"""백그라운드 서브에이전트의 JSONL 로그를 실시간으로 압축해 보여준다 (터미널 용 · Athena Studio 는 앱 AGENT MONITOR 칸).
사용: scripts/agent-monitor.py <jsonl...>        지정 파일들을 tail
      scripts/agent-monitor.py --recent [분]      최근 N분(기본 120) 안에 수정된 로그 자동 선택 — 10초마다 새 로그도 찾는다
        · 백그라운드 서브에이전트(subagents/agent-*.jsonl)
        · pane 세션(delegate.sh·/call) — 워크트리(.worktrees/)에서 연 세션 로그. 아테나 폴더에서 연 세션은 넣지 않는다
        · Codex 워크트리 세션(~/.codex/sessions/**/rollout-*.jsonl)도 같은 규칙으로 따라간다
      scripts/agent-monitor.py --stay --recent [분] 로그가 없어도 기다리고, 분 넘게 조용한 세션은 빼고, 10분(MONITOR_IDLE_ALERT_SEC) 조용해지면 한 줄 표시
한 줄 = [라벨] 도구 · 요약. 라벨은 서브에이전트면 첫 user 프롬프트의 대상 레포/앱, pane 세션이면 워크트리의 레포·브랜치.
"""
import sys, os, json, time, glob, re, unicodedata, shutil, fnmatch

RESET="\x1b[0m"; DIM="\x1b[2m"; BOLD="\x1b[1m"
COLORS=["\x1b[38;5;80m","\x1b[38;5;222m","\x1b[38;5;150m","\x1b[38;5;213m","\x1b[38;5;208m","\x1b[38;5;117m","\x1b[38;5;180m","\x1b[38;5;120m"]
TOOL_ICON={"Exec":"⚙","Bash":"⚙","Read":"📖","Grep":"🔍","Glob":"📁","Edit":"✏️","Write":"📝","Agent":"🤖","WebFetch":"🌐","SubagentHandback":"📨"}

def width(s): return sum(2 if unicodedata.east_asian_width(c) in ("W","F") else 1 for c in s)
def clip(s, n):
    s=" ".join(str(s).split())
    out=""; w=0
    for ch in s:
        cw=2 if unicodedata.east_asian_width(ch) in ("W","F") else 1
        if w+cw>n-1: return out+"…"
        out+=ch; w+=cw
    return out

def _label_rules():
    """지시문에서 찾을 글자 → 이름표. 설정의 레포 이름·alias·모노레포 앱(apps/<앱>)·packages/*·발행 패키지 scope 폴더"""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
        from athena_config import load
        cfg = load(os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')))
    except Exception:
        return []
    rules = []
    for repo in cfg.get('repos', []):
        alias = repo.get('alias') or repo['name']
        for app in (repo.get('apps') or {}):
            rules.append((f"apps/{app}", f"{alias} {app}"))
        if repo.get('kind') == 'monorepo':
            rules.append(("packages/*", f"{alias} packages"))
        if repo.get('scope'):
            rules.append((f"{repo['scope']}/", repo['name']))
        rules.append((repo['name'], alias))
    # 긴 글자부터 — apps/<앱> 이 레포 이름보다 먼저 걸리게
    return sorted(rules, key=lambda rule: -len(rule[0]))
LABEL_RULES = _label_rules()

def label_from_prompt(text):
    hits = [(text.find(needle), label) for needle, label in LABEL_RULES if needle in text]
    return min(hits)[1] if hits else "agent"

def cols():
    try: return max(40, shutil.get_terminal_size().columns)
    except Exception: return 100
def patch_changes(patch):
    """패치 본문을 보관하지 않고 헤더의 작업·경로만 남긴다."""
    if not isinstance(patch, str): return []
    changes, started = [], False
    for line in patch.splitlines():
        if line == "*** Begin Patch":
            started = True; continue
        if not started: continue
        if line == "*** End Patch": break
        file = re.match(r"^\*\*\* (Add|Update|Delete) File: (.+)$", line)
        move = re.match(r"^\*\*\* Move to: (.+)$", line)
        if file: changes.append({"kind": file[1], "path": file[2].strip()})
        elif move: changes.append({"kind": "Move", "path": move[1].strip()})
    return changes

def summarize_tool(name, inp):
    n = cols() - 26  # 라벨·아이콘·도구명 자리 제외
    if name=="apply_patch":
        changes = inp.get("changes") if isinstance(inp.get("changes"), list) else []
        summary = " · ".join(f"{change.get('kind', '')} {change.get('path', '')}" for change in changes if isinstance(change, dict))
        return clip(summary or "apply_patch", n)
    if name == "Exec":
        summary = inp.get('summary') or {}
        value = summary.get('value', '')
        if summary.get('kind') == 'provided': return clip(value, n)
        label = {'command': '명령 실행', 'image': '이미지 확인', 'patch': '파일 변경', 'tool': '도구 실행'}.get(summary.get('kind'), '도구 실행')
        text = f"{label} · {value}" if value else label
        count = summary.get('count', 1)
        return clip(f"{text} · 외 {count - 1}개 작업" if count > 1 else text, n)
    if name == "Bash": return clip(inp.get("description") or inp.get("command", ""), n)
    if name in ("Read",): return clip(inp.get("file_path",""), n)
    if name=="Grep": return clip(f"{inp.get('pattern','')}  in {inp.get('path','')}", n)
    if name=="Glob": return clip(f"{inp.get('pattern','')}  in {inp.get('path','')}", n)
    if name in ("Edit","Write"): return clip(inp.get("file_path",""), n)
    if name=="SubagentHandback": return "최종 보고 전송"
    return clip(json.dumps(inp, ensure_ascii=False), n)

PANE_BACKLOG=5   # pane 세션은 기록이 길어서 처음엔 마지막 몇 줄만 보여 주고 이어서 따라간다
WORKTREE_RE = re.compile(r"/(?:\.worktrees|packs/[^/]+/worktrees)/([^/]+)/")

def codex_meta(path):
    """Codex 기록 첫머리의 세션 메타데이터만 읽는다. 대화 본문은 탐색에 쓰지 않는다."""
    try:
        with open(path, encoding="utf-8") as f:
            line = f.readline(1024 * 1024 + 1)
            if not line.endswith("\n") or len(line.encode("utf-8")) > 1024 * 1024: return {}
            first = json.loads(line)
        if first.get("type") == "session_meta" and isinstance(first.get("payload"), dict):
            return first["payload"]
    except (OSError, ValueError, AttributeError): pass
    return {}

def pane_label(path):
    """pane 세션 로그의 cwd·gitBranch 로 '레포·브랜치' 라벨을 만든다"""
    try:
        with open(path,"r",encoding="utf-8") as f:
            for line in f:
                try: d=json.loads(line)
                except Exception: continue
                if d.get("type") == "session_meta":
                    d = d.get("payload") or {}
                    branch = (d.get("git") or {}).get("branch")
                else:
                    branch = d.get("gitBranch")
                cwd=d.get("cwd") or ""
                if not cwd: continue
                m=WORKTREE_RE.search(cwd)   # 본체 안 .worktrees · 여러 팩 구조의 packs/<팩>/worktrees
                folder=os.path.basename(cwd)
                if not m and d.get("cwd") and re.search(r"/\.athena-studio/bodies/[^/]+(?:/|$)", cwd) and "git" in d:
                    folder="athena"
                repo=m.group(1) if m else folder
                branch=branch or folder
                return f"{repo}·{branch}"
    except Exception: pass
    return "pane"

class Tail:
    def __init__(self, path, idx, pane=False):
        self.path=path; self.f=open(path,"r",encoding="utf-8"); self.color=COLORS[idx%len(COLORS)]
        self.pane=pane; self.label=pane_label(path) if pane else None
        self.done=False; self.tools=0; self.model=None
    def read_new(self):
        lines=[]
        while True:
            line=self.f.readline()
            if not line: break
            if not line.endswith("\n"):  # 부분 줄 — 되감기
                self.f.seek(self.f.tell()-len(line.encode("utf-8"))); break
            lines.append(line)
        return lines

def exec_text(value):
    # 리터럴 제어 문자를 터미널에 그대로 보내지 않는다.
    return re.sub(r'[\x00-\x1f\x7f-\x9f]', '', ' '.join((value or '').split()))

def exec_summary(code):
    """단순 도구 호출의 리터럴만 읽는다. 코드를 실행하거나 동적인 값을 추측하지 않는다."""
    fallback = {'kind': 'command', 'value': '', 'count': 1}
    if not isinstance(code, str) or len(code) > 64000: return fallback
    pattern = r'''//[^\r\n]*|/\*[\s\S]*?\*/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]'''
    tokens = []
    for match in re.finditer(pattern, code):
        raw = match[0]
        if raw.startswith(("//", "/*")): continue
        text = None
        if len(raw) >= 2 and raw[0] in "\"'`" and raw[-1] == raw[0]:
            if raw[0] == '`' and '${' in raw: return fallback
            valid = [True]
            def decode(escaped):
                part = escaped[1]
                escapes = {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'", '`': '`', '\n': ''}
                if re.fullmatch(r'(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})', part): return chr(int(part[1:], 16))
                if part in escapes: return escapes[part]
                valid[0] = False
                return ''
            text = re.sub(r'\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])', decode, raw[1:-1])
            if not valid[0]: return fallback
        tokens.append({'raw': raw, **({'text': text} if text is not None else {})})
    index, summaries = 0, []
    def peek(): return tokens[index]['raw'] if index < len(tokens) else None
    def take(raw):
        nonlocal index
        if peek() != raw: return False
        index += 1
        return True
    while index < len(tokens):
        wrapped = take('text')
        if wrapped and not take('('): return fallback
        take('await')
        if not take('tools') or not take('.'): return fallback
        method = peek()
        index += 1
        if not method or not re.fullmatch(r'[\w$]+', method) or not take('('): return fallback
        patch = tokens[index].get('text') if index < len(tokens) else None
        if patch is not None: index += 1
        elif not take('{'): return fallback
        fields = {}
        while patch is None and peek() != '}':
            if index >= len(tokens): return fallback
            key = tokens[index].get('text', tokens[index]['raw'])
            index += 1
            if not re.fullmatch(r'[\w$]+', key) or not take(':'): return fallback
            start, closing = index, []
            while index < len(tokens):
                lexeme = tokens[index]
                raw = lexeme['raw']
                if 'text' not in lexeme:
                    if not closing and raw in (',', '}'): break
                    if raw in ('(', '[', '{'): closing.append({'(': ')', '[': ']', '{': '}'}[raw])
                    elif raw in (')', ']', '}') and (not closing or closing.pop() != raw): return fallback
                index += 1
            if closing or index == start: return fallback
            literal = tokens[start].get('text') if index == start + 1 else None
            fields.pop(key, None)
            if literal is not None: fields[key] = literal
            if not take(','): break
        if (patch is None and not take('}')) or not take(')') or (wrapped and not take(')')): return fallback
        take(';')
        title = exec_text(fields.get('title') or fields.get('description'))[:120]
        if method in ('exec_command', 'shell_command', 'shell'):
            command = exec_text(re.split(r'\r?\n', fields.get('cmd') or fields.get('command') or '')[0])[:120]
            summaries.append({'kind': 'command', 'value': title or command})
        elif method == 'view_image':
            file = exec_text(fields.get('path'))[:120]
            summaries.append({'kind': 'image', 'value': title or file})
        elif method == 'apply_patch':
            changes = ' · '.join(f"{change['kind']} {exec_text(change['path'])}" for change in patch_changes(patch))[:120]
            summaries.append({'kind': 'patch', 'value': changes})
        else: summaries.append({'kind': 'tool', 'value': title})
    return {**summaries[0], 'count': len(summaries)} if summaries else fallback

def codex_model(d):
    """모델 문맥이 없는 줄은 None, 명시적으로 비었으면 빈 문자열로 이전 모델을 지운다."""
    if not isinstance(d, dict) or not isinstance(d.get("payload"), dict): return None
    p = d["payload"]
    context = p if d.get("type") == "turn_context" else p.get("thread_settings") if d.get("type") == "event_msg" and p.get("type") == "thread_settings_applied" else None
    if not isinstance(context, dict) or "model" not in context: return None
    model = context["model"]
    return model if isinstance(model, str) and re.match(r"^[a-z]", model, re.I) else ""

def tool_icon(name, inp):
    if name == "apply_patch" and isinstance(inp.get("changes"), list) and inp["changes"]:
        return TOOL_ICON["Write"] if all(change.get("kind") == "Add" for change in inp["changes"]) else TOOL_ICON["Edit"]
    return TOOL_ICON.get(name, "•")

def codex_message(d, model=None):
    """실측한 response_item을 기존 렌더러 입력으로 바꾼다. event_msg는 중복이라 표시하지 않는다."""
    if not isinstance(d, dict): return {}
    p = d.get("payload")
    if not isinstance(p, dict): return {}
    if d.get("type") == "session_meta":
        git = p.get("git") if isinstance(p.get("git"), dict) else {}
        return {"cwd": p.get("cwd"), "gitBranch": git.get("branch")}
    if d.get("type") != "response_item": return {}
    stamp = {"timestamp": d["timestamp"]} if isinstance(d.get("timestamp"), str) else {}
    model_part = {"model": model} if isinstance(model, str) and re.match(r"^[a-z]", model, re.I) else {}
    kind = p.get("type")
    if kind == "message" and p.get("role") in ("user", "assistant"):
        content = p.get("content")
        if not isinstance(content, list): return {}
        text = "\n".join(block.get("text", "") for block in content
                         if isinstance(block, dict) and block.get("type") in ("input_text", "output_text") and isinstance(block.get("text"), str))
        return {**stamp, "type": p["role"], "message": {**(model_part if p["role"] == "assistant" else {}), "content": text if p["role"] == "user" else [{"type": "text", "text": text}]}}
    if kind not in ("function_call", "custom_tool_call"): return {}
    name = p.get("name") if isinstance(p.get("name"), str) and p["name"] else "tool"
    if kind == "function_call":
        try:
            inp = p.get("arguments")
            if inp is None: inp = {}
            if isinstance(inp, str): inp = json.loads(inp)
        except ValueError: return {}
        if not isinstance(inp, dict): return {}
    else:
        inp = {"input": p.get("input") if p.get("input") is not None else ""}
    if name.rsplit(".", 1)[-1] == "apply_patch":
        name = "apply_patch"
        patch = inp.get("patch") if inp.get("patch") is not None else inp.get("input")
        inp = {"changes": patch_changes(patch)}
    elif name.rsplit(".", 1)[-1] == "exec":
        name = "Exec"
        title = next((value for value in (inp.get("title"), inp.get("description"), p.get("title"), p.get("description")) if isinstance(value, str) and value.strip()), '')
        inp = {"summary": {"kind": "provided", "value": exec_text(title)[:160], "count": 1} if title else exec_summary(inp.get("input", inp.get("code")))}
    elif name.rsplit(".", 1)[-1] in ("exec_command", "shell_command", "shell"):
        name = "Bash"
        command = inp.get("cmd") or inp.get("command") or ""
        if isinstance(command, list): command = " ".join(str(part) for part in command)
        inp = {"command": command, "description": inp.get("description") or inp.get("title")}
    elif inp.get("title"):
        # code-mode 등은 실행 코드 전체 대신 도구가 제공한 짧은 설명을 쓴다.
        inp = {"title": inp["title"]}
    return {**stamp, "type": "assistant", "message": {**model_part, "content": [{"type": "tool_use", "name": name, "input": inp}]}}

def render(tails, line):
    try: d=json.loads(line)
    except Exception: return []
    if not isinstance(d, dict): return []
    model = codex_model(d)
    if model is not None: tails.model = model or None
    is_codex = d.get("type") == "response_item"
    if is_codex: d = codex_message(d, tails.model)
    out=[]
    msg=d.get("message") or {}
    content=msg.get("content")
    model_text=(msg.get("model") + " ") if is_codex and isinstance(msg.get("model"), str) else ""
    t=tails
    if d.get("type")=="user" and t.label is None and isinstance(content,str):
        t.label=label_from_prompt(content); out.append(f"{t.color}{BOLD}[{t.label}]{RESET} {DIM}시작{RESET}")
        return out
    # pane 세션 — 사용자가 pane 에 입력한 지시(시스템·명령 메시지는 '<' 로 시작하므로 뺀다)
    if t.pane and d.get("type")=="user" and isinstance(content,str) and not d.get("isMeta") and not d.get("isCompactSummary"):
        txt=content.strip()
        if txt and not txt.startswith("<"): out.append(f"{t.color}{BOLD}[{t.label}]{RESET} 👤 {clip(txt, cols()-22)}")
        return out
    if not isinstance(content,list): return out
    for block in content:
        bt=block.get("type")
        if bt=="tool_use":
            t.tools+=1; name=block.get("name",""); icon=tool_icon(name, block.get("input") or {})
            out.append(f"{t.color}[{t.label or 'agent'}]{RESET} {icon} {name:<6} {DIM}{model_text}{summarize_tool(name, block.get('input') or {})}{RESET}")
            if name=="SubagentHandback": t.done=True
        elif bt=="text" and d.get("type")=="assistant":
            txt=block.get("text","").strip()
            if txt and len(txt)>3: out.append(f"{t.color}[{t.label or 'agent'}]{RESET} 💬 {model_text}{clip(txt, cols()-22)}")
    return out

PANE_PROJECT_PATTERNS = ("*--worktrees-*", "*-packs-*-worktrees-*")

def project_dir_name(cwd):
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)

def terminal_project_matches(name, active_names):
    """터미널 모니터는 기존대로 모든 팩 워크트리와 활성 에이전트 pane을 본다."""
    return name in active_names or any(fnmatch.fnmatchcase(name, pattern) for pattern in PANE_PROJECT_PATTERNS)

def active_agent_cwds():
    """앱과 같은 화면 계층의 agent·foreground_cwd/cwd만 읽는다. 화면 밖이면 워크트리 탐색을 계속한다."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
        import screen
        return [pane.get("foreground_cwd") or pane.get("cwd") for pane in screen.list_panes(timeout=3)
                if pane.get("agent") and isinstance(pane.get("foreground_cwd") or pane.get("cwd"), str)]
    except Exception: return []

def codex_session_matches(cwd, body, worktrees, active=()):
    """터미널의 Claude 선택 규칙. 앱의 팩 창 범위와 구분해 fixture로 비교한다."""
    if not cwd: return False
    active_names = {project_dir_name(value) for value in active if not body or os.path.realpath(value) != os.path.realpath(body)}
    return terminal_project_matches(project_dir_name(cwd), active_names)

def find_recent(mins):
    """최근 mins 분 안에 바뀐 (경로, pane 세션 여부) 목록"""
    root=os.path.expanduser("~/.claude/projects")
    subagents=[(p,False) for p in glob.glob(f"{root}/*/*/subagents/agent-*.jsonl")]
    athena_root=os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
    active=active_agent_cwds()
    active_names={project_dir_name(cwd) for cwd in active if os.path.realpath(cwd) != athena_root}
    # 기존 모든 팩 워크트리 패턴 + 화면 계층에서 받은 일반 에이전트 pane 폴더.
    panes=[(p,True) for project in glob.glob(f"{root}/*")
           if terminal_project_matches(os.path.basename(project), active_names)
           for p in glob.glob(f"{project}/*.jsonl")]
    panes=list(dict.fromkeys(panes))
    now=time.time()
    found=[(p,pane) for p,pane in subagents+panes if now-os.path.getmtime(p) < mins*60]
    codex_root=os.path.expanduser("~/.codex/sessions")
    worktrees_root=os.path.realpath(os.path.join(athena_root, ".worktrees"))
    for p in glob.iglob(f"{codex_root}/**/rollout-*.jsonl", recursive=True):
        try:
            if now-os.path.getmtime(p) >= mins*60: continue
            cwd=codex_meta(p).get("cwd")
            if isinstance(cwd, str) and codex_session_matches(cwd, athena_root, worktrees_root, active):
                found.append((p, True))
        except OSError: continue   # 탐색 도중 지워진 기록은 다음 주기에 다시 본다
    found.sort(key=lambda item: os.path.getmtime(item[0]))
    return found

def open_tail(path, pane, idx):
    t=Tail(path, idx, pane)
    rows=[row for line in t.read_new() for row in render(t, line)]
    if pane: rows=rows[-PANE_BACKLOG:]
    for row in rows: print(row)
    return t

IDLE_ALERT_SEC=int(os.environ.get("MONITOR_IDLE_ALERT_SEC","600"))   # --stay: 이만큼 아무 로그도 안 바뀌면 pane 에 한 줄 표시(macOS 알림은 보내지 않는다) — 다시 움직였다 조용해질 때까지 또 알리지 않는다(0 이면 끔)

def main():
    args=sys.argv[1:]
    # --stay: 로그가 없어도 끝내지 않고 기다리며, 끝난 세션은 빼고, 조용하면 알린다(monitor-pane.sh 가 붙인다)
    stay="--stay" in args; args=[a for a in args if a!="--stay"]
    recent = not args or args[0]=="--recent"
    if recent:
        mins=int(args[1]) if len(args)>1 else 120
        files=find_recent(mins)
    else:
        files=[(p,False) for p in args]
    if not files and not stay: print("모니터할 로그가 없습니다."); return 3   # 3 = 모니터할 것 없음
    alert=f" · {IDLE_ALERT_SEC//60}분 조용하면 표시" if stay and IDLE_ALERT_SEC else ""
    print(f"{BOLD}🛰  에이전트 모니터{RESET} {DIM}— {len(files)}개 로그(pane 세션 {sum(1 for _,pane in files if pane)}){alert} · Ctrl+C 로 종료{RESET}\n")
    if not files: print(f"{DIM}{time.strftime('%H:%M')} 돌고 있는 에이전트 없음 — 뜨면 붙습니다{RESET}")
    tails=[open_tail(p,pane,i) for i,(p,pane) in enumerate(files)]
    last_scan=time.time()
    last_activity=max([os.path.getmtime(t.path) for t in tails] or [time.time()])
    last_alert=0.0
    try:
        while True:
            any_new=False
            for t in tails:
                for line in t.read_new():
                    for row in render(t, line): print(row); any_new=True
            # 새로 뜬 에이전트도 잡는다
            if recent and time.time()-last_scan > 10:
                last_scan=time.time(); known={t.path for t in tails}
                for p,pane in find_recent(mins):
                    if p not in known:
                        tails.append(open_tail(p,pane,len(tails))); any_new=True
                if stay:
                    # mins 분 넘게 조용한 세션은 뺀다
                    for t in [t for t in tails if time.time()-os.path.getmtime(t.path) > mins*60]:
                        t.f.close(); tails.remove(t); print(f"{DIM}{time.strftime('%H:%M')} [{t.label}] {mins}분 조용해서 뺐습니다{RESET}")
            if any_new: last_activity=time.time(); last_alert=0.0
            if stay:
                # 조용해지면 한 번만 알린다 — 계속 조용하면(퇴근 뒤 등) 되풀이하지 않고, 에이전트가 다시 움직이면 초기화
                idle=time.time()-last_activity
                if IDLE_ALERT_SEC and idle >= IDLE_ALERT_SEC and not last_alert:
                    last_alert=time.time()
                    text=f"{int(idle//60)}분째 돌고 있는 에이전트가 없습니다" + (f" (붙어 있는 세션 {len(tails)}개 — 입력을 기다리는지 확인)" if tails else "")
                    print(f"{BOLD}🔔 {time.strftime('%H:%M')} {text}{RESET}")
            # 서브에이전트만 있고 모두 끝나면 끝낸다(--stay 면 계속 기다린다). pane 세션은 사용자가 계속 지시하므로 끝나지 않는다
            elif tails and all(t.done for t in tails) and not any(t.pane for t in tails):
                print(f"\n{BOLD}✅ 모두 완료{RESET} " + " · ".join(f"{t.color}{t.label}{RESET}({t.tools}개 도구)" for t in tails)); break
            if not any_new: time.sleep(0.7)
    except KeyboardInterrupt:
        print(f"\n{DIM}종료. 진행 요약: " + " · ".join(f"{t.label}={t.tools}" for t in tails) + RESET)

if __name__=="__main__": sys.exit(main() or 0)
