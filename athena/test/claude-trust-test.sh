#!/usr/bin/env bash
# 위임 에이전트 워크트리 믿음 미리 적기 시험 — scripts/lib/claude_trust.py(delegate.sh 가 Claude 를 띄우기 전에 부른다) · 몇 초
# 가짜 HOME 의 ~/.claude.json 만 건드린다(진짜 claude 를 부르지 않는다).
#   없음 → 적음 · 이미 있음 → 그대로 · 깨진 JSON → 안 건드림 · 팩 밖 경로 → 안 함 · 파일 없음 → 만들지 않음 · 링크 파일 → 링크 유지
#
# 사용: test/claude-trust-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
TMP="$(cd "$TMP" && pwd -P)"

python3 - "$SRC" "$TMP" <<'PY'
import json, os, stat, subprocess, sys
src, tmp = sys.argv[1:3]
fail = 0
def check(label, ok, detail=""):
    global fail
    print(("  ✔ " if ok else "  ✖ ") + label + ("" if ok else f" — {detail}"))
    fail |= 0 if ok else 1

home = os.path.join(tmp, 'home'); os.makedirs(home)
config = os.path.join(home, '.claude.json')
env = {key: value for key, value in os.environ.items() if not key.startswith(('ATHENA_', 'CLAUDE'))}
env['HOME'] = home

def worktree(path):
    """연결 워크트리 흉내 — .git 이 파일"""
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, '.git'), 'w') as handle: handle.write('gitdir: /nowhere\n')
    return path

def run(body, workdir):
    result = subprocess.run(['python3', f'{src}/scripts/lib/claude_trust.py', body, workdir], env=env, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def write(text, mode=0o600):
    if os.path.lexists(config): os.unlink(config)
    with open(config, 'w') as handle: handle.write(text)
    os.chmod(config, mode)

def read():
    with open(config) as handle: return handle.read()

# 옛 본체(.worktrees 자리)
legacy = os.path.join(tmp, 'legacy'); os.makedirs(legacy)
with open(os.path.join(legacy, 'athena.config.json'), 'w') as handle: handle.write('{}\n')
inside = worktree(os.path.join(legacy, '.worktrees', 'shop', 'fix-a'))

# 1. 칸 없음 → 적음 · 다른 칸 · 권한 그대로
original = {'numStartups': 3, 'secretLike': 'keep-me', 'projects': {'/other': {'allowedTools': ['x'], 'hasTrustDialogAccepted': False}}}
write(json.dumps(original, indent=2), 0o600)
code, out, err = run(legacy, inside)
data = json.loads(read())
check('칸 없음 → marked · 종료 0', code == 0 and out == 'marked', (code, out, err))
check('그 워크트리 실제 경로에 hasTrustDialogAccepted: true', data['projects'].get(os.path.realpath(inside)) == {'hasTrustDialogAccepted': True}, data['projects'].keys())
check('다른 칸은 그대로', data['numStartups'] == 3 and data['secretLike'] == 'keep-me' and data['projects']['/other'] == original['projects']['/other'], data)
check('파일 권한 그대로(0600)', stat.S_IMODE(os.stat(config).st_mode) == 0o600, oct(os.stat(config).st_mode))
check('임시 파일이 남지 않는다', not [name for name in os.listdir(home) if name.startswith('.claude.json.')], os.listdir(home))
check('출력에 파일 내용이 없다', 'keep-me' not in out + err, out + err)

# 2. 이미 있음 → 그대로(파일을 다시 쓰지 않는다)
before, inode = read(), os.stat(config).st_ino
code, out, _ = run(legacy, inside)
check('이미 믿음 → already · 파일 안 바뀜', out == 'already' and read() == before and os.stat(config).st_ino == inode, out)

# 2-1. 칸은 있는데 false · 다른 값이 있으면 그 칸만 true
write(json.dumps({'projects': {os.path.realpath(inside): {'hasTrustDialogAccepted': False, 'lastCost': 1.5}}}))
code, out, _ = run(legacy, inside)
entry = json.loads(read())['projects'][os.path.realpath(inside)]
check('false → marked · 같은 칸의 다른 값 유지', out == 'marked' and entry == {'hasTrustDialogAccepted': True, 'lastCost': 1.5}, (out, entry))

# 3. 깨진 JSON → 안 건드림
write('{"projects": {', 0o600)
code, out, _ = run(legacy, inside)
check('깨진 JSON → skip · 내용 그대로 · 종료 0', code == 0 and out.startswith('skip:') and read() == '{"projects": {', out)

# 3-1. 모양이 다름(projects 가 목록) → 안 건드림
write('{"projects": []}')
code, out, _ = run(legacy, inside)
check('projects 모양이 다름 → skip · 그대로', out.startswith('skip:') and read() == '{"projects": []}', out)

# 4. 팩 밖 경로 → 안 함
write('{"projects": {}}')
outside = worktree(os.path.join(tmp, 'elsewhere', 'repo-wt'))
code, out, _ = run(legacy, outside)
check('팩 worktrees 밖 → skip:outside · 그대로', out == 'skip:outside' and read() == '{"projects": {}}', out)
# 자리 안이어도 워크트리 맨 위가 아니면(레포 폴더 · 하위 폴더) 안 함
os.makedirs(os.path.join(inside, 'sub'), exist_ok=True)
code1, out1, _ = run(legacy, os.path.join(legacy, '.worktrees', 'shop'))
code2, out2, _ = run(legacy, os.path.join(inside, 'sub'))
check('자리 안의 레포 폴더 · 워크트리 하위 폴더 → skip:outside', out1 == 'skip:outside' and out2 == 'skip:outside' and read() == '{"projects": {}}', (out1, out2))
# 링크로 자리 밖을 가리키는 워크트리 경로 → 실제 경로로 보고 안 함
os.symlink(outside, os.path.join(legacy, '.worktrees', 'shop', 'sneaky'))
code, out, _ = run(legacy, os.path.join(legacy, '.worktrees', 'shop', 'sneaky'))
check('자리 밖을 가리키는 링크 → skip:outside', out == 'skip:outside' and read() == '{"projects": {}}', out)

# 5. 파일 없음 → 만들지 않음
os.unlink(config)
code, out, _ = run(legacy, inside)
check('~/.claude.json 없음 → skip · 파일을 만들지 않는다', out.startswith('skip:') and not os.path.lexists(config), out)

# 6. ~/.claude.json 이 링크(dotfiles) → 링크 유지 · 가리키는 파일에 적음
real = os.path.join(tmp, 'dotfiles', 'claude.json'); os.makedirs(os.path.dirname(real))
with open(real, 'w') as handle: handle.write('{"projects": {}}')
os.symlink(real, config)
code, out, _ = run(legacy, inside)
check('링크 파일 → marked · 링크 그대로 · 실제 파일에 적힘', out == 'marked' and os.path.islink(config)
      and json.load(open(real))['projects'].get(os.path.realpath(inside)) == {'hasTrustDialogAccepted': True}, out)
os.unlink(config)

# 7. 여러 팩 본체(.pack-data → <데이터>/packs/<id>) — 지금 팩 worktrees 만
body = os.path.join(tmp, 'body'); os.makedirs(body)
pack_data = os.path.join(tmp, 'data', 'packs', 'acme'); os.makedirs(pack_data)
os.symlink(pack_data, os.path.join(body, '.pack-data'))
with open(os.path.join(body, 'athena.config.json'), 'w') as handle: handle.write('{}\n')
mine = worktree(os.path.join(pack_data, 'worktrees', 'shop', 'feat-b'))
other_pack = worktree(os.path.join(tmp, 'data', 'packs', 'globex', 'worktrees', 'shop', 'feat-c'))
write('{"projects": {}}')
code, out, _ = run(body, mine)
code2, out2, _ = run(body, other_pack)
projects = json.loads(read())['projects']
check('여러 팩 — 지금 팩 워크트리 marked · 다른 팩 워크트리 skip:outside', out == 'marked' and out2 == 'skip:outside'
      and list(projects) == [os.path.realpath(mine)], (out, out2, list(projects)))

# 8. delegate.sh 가 Claude 엔진에서 실행기를 만들기 전에 부른다(Codex 는 부르지 않는다)
text = open(f'{src}/scripts/delegate.sh', encoding='utf-8').read()
call = text.find('scripts/lib/claude_trust.py')
check('delegate.sh — Claude 일 때 pane 실행 전에 claude_trust.py 를 부른다', call > 0 and call < text.find('pane run "$PANE"')
      and '[ "$ENGINE" = codex ] || python3 "$ATHENA_DIR/scripts/lib/claude_trust.py"' in text, call)

sys.exit(fail)
PY
