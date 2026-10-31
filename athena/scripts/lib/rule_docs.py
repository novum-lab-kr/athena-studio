#!/usr/bin/env python3
"""레포 규칙 문서 찾기 · 세션 글 만들기 — 찾는 규칙은 여기 한 곳이다(agent-context.py 가 import, init · sync-fingerprint 는 아래 CLI 로).

관례 이름 + 팩 ruleDocs(add · exclude)로 고른다(docs/pack.md "ruleDocs"). 경로는 레포 루트 기준 · 패턴은 받지 않는다.
결과는 네 칸:
  docs    — 세션 글에 실을 문서
  auto    — Claude Code 가 스스로 싣는 문서(루트 CLAUDE.md · .claude/CLAUDE.md · .claude/rules/*.md 와 그 @ 참조). 두 번 싣지 않는다
  missing — add 에 적었는데 없는 경로
  refused — 위험해서 뺀 경로(레포 밖 · .git 안 · 시크릿 파일)

사용: rule_docs.py list <트리> [--ref <ref>] --json '{"dirs":["","apps/web"],"add":[],"exclude":[]}'
      → {"docs":[…],"auto":[…],"missing":[…],"refused":[…]}. --ref 가 있으면 작업 트리 대신 그 ref 를 읽는다
"""
import json
import os
import posixpath
import re
import subprocess
import sys

DEFAULT_MAX_CHARS = 40000   # 레포당 전문 합계 상한(글자 수) — 팩 ruleDocs.maxChars 로 조정
MAX_IMPORT_DEPTH = 5        # Claude Code 의 @ 참조 최대 깊이
MAX_LINK_HOPS = 8

CONVENTION_FILES = ('AGENTS.md', 'WORKING-AGREEMENT.md', 'CONTRIBUTING.md', '.cursorrules', '.github/copilot-instructions.md')
CONVENTION_DIRS = (('.ai', '.md'), ('.github/agents', '.agent.md'), ('.claude/rules', '.md'))
CLAUDE_ROOTS = ('CLAUDE.md', '.claude/CLAUDE.md')

# 시크릿 파일은 팩에 적혀 있어도 세션 글에 싣지 않는다 — 시스템 프롬프트에 실리면 값이 그대로 나간다(scripts/hooks/secret-guard.py 와 같은 이름들)
SECRET_NAME = re.compile(r'(^\.npmrc$|^\.env(\.[\w-]+)*$|\.pem$|\.key$|^id_rsa|^id_ed25519|^\.netrc$|^firebase-key\.json$|^access-key\.js$)')
EXAMPLE_NAME = re.compile(r'^\.env\.(example|sample|template)$')
SECRET_PATH = re.compile(r'(^|/)(\.aws/credentials|gh/hosts\.yml)$')


def clean_path(value):
    """레포 루트 기준 평범한 경로로 — 절대 경로 · .. · .git 안 · 문자열 아님은 None"""
    if not isinstance(value, str) or not value or value.startswith(('/', '~')) or '\\' in value or '\0' in value:
        return None
    if '..' in value.split('/'):
        return None
    path = posixpath.normpath(value)
    if path == '.' or '.git' in path.split('/'):
        return None
    return path


def is_secret(path):
    name = posixpath.basename(path)
    if EXAMPLE_NAME.match(name):
        return False
    return bool(SECRET_NAME.search(name) or SECRET_PATH.search(path))


class FsTree:
    """작업 트리 — 대소문자가 다른 이름을 같은 파일로 치지 않게 폴더 목록으로 비교한다(맥 기본 파일 시스템)"""

    def __init__(self, root):
        self.root = os.path.realpath(root)

    def listdir(self, rel):
        try:
            return sorted(os.listdir(os.path.join(self.root, rel)))
        except OSError:
            return []

    def is_file(self, rel):
        current = ''
        for part in rel.split('/'):
            if part not in self.listdir(current):
                return False
            current = posixpath.join(current, part)
        return os.path.isfile(os.path.join(self.root, rel))

    def resolve(self, rel):
        """심볼릭 링크를 푼 레포 안 경로 — 레포 밖이면 None"""
        real = os.path.realpath(os.path.join(self.root, rel))
        if not real.startswith(self.root + os.sep):
            return None
        return os.path.relpath(real, self.root).replace(os.sep, '/')

    def read(self, rel):
        with open(os.path.join(self.root, rel), 'rb') as handle:
            return handle.read().decode('utf-8')


class GitTree:
    """ref 의 트리 — 작업 트리를 건드리지 않는다(sync 는 기준 브랜치를 읽는다)"""

    def __init__(self, repo_dir, ref):
        self.repo_dir = repo_dir
        self.entries = {}
        out = subprocess.run(['git', '-C', repo_dir, 'ls-tree', '-r', '-z', ref], capture_output=True, check=True).stdout.decode('utf-8')
        for row in out.split('\0'):
            if row:
                meta, path = row.split('\t', 1)
                mode, _kind, blob = meta.split()
                self.entries[path] = (mode, blob)

    def blob(self, rel):
        return subprocess.run(['git', '-C', self.repo_dir, 'cat-file', 'blob', self.entries[rel][1]], capture_output=True, check=True).stdout.decode('utf-8')

    def listdir(self, rel):
        prefix = f'{rel}/' if rel else ''
        return sorted({path[len(prefix):].split('/')[0] for path in self.entries if path.startswith(prefix)})

    def is_file(self, rel):
        return rel in self.entries and self.entries[rel][0] != '160000'

    def resolve(self, rel):
        current = rel
        for _hop in range(MAX_LINK_HOPS):
            if current not in self.entries:
                return None
            if self.entries[current][0] != '120000':
                return current
            target = self.blob(current)
            if target.startswith('/'):
                return None
            current = posixpath.normpath(posixpath.join(posixpath.dirname(current), target))
            if current.startswith('..'):
                return None
        return None

    def read(self, rel):
        return self.blob(self.resolve(rel) or rel)


def imports_of(text):
    """본문의 @ 참조 — Claude Code 처럼 코드 블록 · 인라인 코드 안은 무시한다"""
    without_fences = re.sub(r'```.*?```', '', text, flags=re.S)
    without_code = re.sub(r'`[^`\n]*`', '', without_fences)
    return re.findall(r'(?:^|\s)@(\S+)', without_code)


def claude_auto(tree):
    """Claude Code 가 스스로 싣는 문서의 실제 경로 — 루트 CLAUDE.md 들과 rules, 그 @ 참조(전이)"""
    rules = [f'.claude/rules/{name}' for name in tree.listdir('.claude/rules') if name.endswith('.md')]
    queue = [(path, 0) for path in [*CLAUDE_ROOTS, *rules]]
    seen = set()
    while queue:
        path, depth = queue.pop()
        if not tree.is_file(path):
            continue
        real = tree.resolve(path)
        if real is None or real in seen:
            continue
        seen.add(real)
        if depth >= MAX_IMPORT_DEPTH:
            continue
        try:
            text = tree.read(real)
        except (UnicodeDecodeError, OSError, subprocess.CalledProcessError):
            continue
        for target in imports_of(text):
            joined = posixpath.normpath(posixpath.join(posixpath.dirname(real), target))
            if not target.startswith(('/', '~')) and not joined.startswith('..'):
                queue.append((joined, depth + 1))
    return seen


def convention_paths(tree, folder):
    paths = [posixpath.join(folder, name) for name in CONVENTION_FILES]
    for sub, suffix in CONVENTION_DIRS:
        where = posixpath.join(folder, sub)
        paths += [posixpath.join(where, name) for name in tree.listdir(where) if name.endswith(suffix)]
    return paths


def discover(tree, dirs=('',), add=(), exclude=()):
    """규칙 문서 찾기 — exclude 가 관례 이름 · add 보다 먼저다. 같은 실제 파일은 한 번만"""
    excluded = {clean_path(path) for path in exclude} - {None}
    auto_real = claude_auto(tree)
    found = {'docs': [], 'auto': [], 'missing': [], 'refused': []}
    candidates = [*sorted(auto_real), *[path for folder in dirs for path in convention_paths(tree, folder)]]
    wanted = [clean_path(path) for path in add]
    seen_real = set()
    for path, raw in [*[(path, None) for path in candidates], *zip(wanted, add)]:
        if path is None:
            found['refused'].append(str(raw))
            continue
        if path in excluded:
            continue
        if is_secret(path):
            found['refused'].append(path)
            continue
        if not tree.is_file(path):
            if raw is not None:
                found['missing'].append(path)
            continue
        real = tree.resolve(path)
        if real is None or is_secret(real) or '.git' in real.split('/'):
            found['refused'].append(path)
            continue
        if real in excluded or real in seen_real:
            continue
        seen_real.add(real)
        found['auto' if real in auto_real else 'docs'].append(path)
    return found


def apply_limit(loaded, max_chars):
    """상한을 넘으면 큰 파일부터 목록으로 — (전문으로 실을 것, 목록으로 돌린 것). 순서는 찾은 순서 그대로"""
    total = sum(len(text) for _path, text in loaded)
    moved = set()
    for path, text in sorted(loaded, key=lambda item: len(item[1]), reverse=True):
        if total <= max_chars:
            break
        moved.add(path)
        total -= len(text)
    return [item for item in loaded if item[0] not in moved], [item for item in loaded if item[0] in moved]


def section(repo, work_dir, kept, listed, max_chars):
    """세션 글 절 — 전문은 원문 그대로(요약 · 번역 없음)"""
    if not kept and not listed:
        return ''
    parts = ['# 레포 규칙 문서']
    for path, text in kept:
        parts += ['', f'## {repo}/{path}', '', text.rstrip('\n')]
    if listed:
        parts += ['', f'## 먼저 읽어라 — 합계 {max_chars}자 상한을 넘어 전문을 싣지 않은 문서', '']
        parts += [f'- `{os.path.join(work_dir, path)}` ({len(text)}자)' for path, text in listed]
    return '\n'.join(parts) + '\n'


def app_scope(entry, agent):
    """모노레포 — (대상 앱들, 대상 밖 앱들). 그 앱 담당이면 그 앱만 · 패키지 담당이면 앱 없음 · 담당을 모르면(reviewer 등) 전부"""
    apps = entry.get('apps') if isinstance(entry.get('apps'), dict) else {}
    own = [name for name, spec in apps.items() if agent in (spec, spec.get('agent') if isinstance(spec, dict) else None)]
    if not own and entry.get('packagesAgent') != agent:
        own = list(apps)
    return own, [name for name in apps if name not in own]


def targets(entry, agent):
    """(찾을 폴더들, 대상 밖 앱 폴더 머리) — 루트 · appDir · 대상 앱"""
    dirs = ['']
    app_dir = entry.get('appDir')
    if isinstance(app_dir, str) and clean_path(app_dir):
        dirs.append(clean_path(app_dir))
    own, others = app_scope(entry, agent)
    return dirs + [f'apps/{name}' for name in own], tuple(f'apps/{name}/' for name in others)


def read_settings(entry, notes):
    """팩 ruleDocs 칸 — (add, exclude, 상한). 모양이 이상하면 관례 이름 · 기본값으로 가고 알린다"""
    settings = entry.get('ruleDocs')
    if settings is None:
        return [], [], DEFAULT_MAX_CHARS
    if not isinstance(settings, dict):
        notes.append('팩 ruleDocs 모양이 이상해 관례 이름만 찾았다 — docs/pack.md "ruleDocs"')
        return [], [], DEFAULT_MAX_CHARS
    lists = []
    for key in ('add', 'exclude'):
        value = settings.get(key, [])
        if not isinstance(value, list):
            notes.append(f'팩 ruleDocs.{key} 는 경로 목록이어야 한다 — 무시했다')
            value = []
        lists.append(value)
    max_chars = settings.get('maxChars', DEFAULT_MAX_CHARS)
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars <= 0:
        notes.append(f'팩 ruleDocs.maxChars 가 이상해 기본값 {DEFAULT_MAX_CHARS}자로 — 양의 정수여야 한다')
        max_chars = DEFAULT_MAX_CHARS
    return lists[0], lists[1], max_chars


def repo_entry_for(athena_dir, work_dir):
    """작업 트리의 (레포 이름, 팩 항목). 설정 · 팩이 없으면 폴더 이름과 빈 항목(관례 이름만 찾는다)"""
    import athena_config
    name = athena_config._tree_repo_branch(athena_dir, work_dir)[0] or os.path.basename(work_dir.rstrip('/'))
    try:
        return name, athena_config.repo_entry(athena_config.load(athena_dir), name)
    except (SystemExit, ValueError, OSError):
        return name, {}


def prepare(athena_dir, agent, work_dir):
    """에이전트 세션에 실을 것 — { section: 절 글, listed: 목록으로 돌린 절대 경로들, notes: 디스패치 보고에 낼 줄들 }"""
    repo, entry = repo_entry_for(athena_dir, work_dir)
    notes = []
    add, exclude, max_chars = read_settings(entry, notes)
    dirs, other_apps = targets(entry, agent)
    # 다른 앱 담당의 문서는 이 에이전트의 일이 아니다 — 팩 목록에 앱 문서가 함께 적혀 있어도 그 앱 것만
    add = [path for path in add if not (isinstance(path, str) and path.startswith(other_apps))] if other_apps else add
    tree = FsTree(work_dir)
    found = discover(tree, dirs, add, exclude)
    loaded = []
    for path in found['docs']:
        try:
            loaded.append((path, tree.read(path)))
        except (UnicodeDecodeError, OSError):
            found['refused'].append(path)
    kept, listed = apply_limit(loaded, max_chars)
    if listed:
        names = ', '.join(path for path, _text in listed)
        notes.append(f'합계 {max_chars}자 상한을 넘어 전문 대신 "먼저 읽어라" 목록으로: {names}')
    if found['missing']:
        notes.append(f'팩 ruleDocs.add 에 있는데 없는 문서: {", ".join(found["missing"])}')
    if found['refused']:
        notes.append(f'위험하거나 읽을 수 없어 뺀 문서: {", ".join(found["refused"])}')
    return {
        'section': section(repo, work_dir, kept, listed, max_chars),
        'listed': [os.path.join(work_dir, path) for path, _text in listed],
        'notes': [f'   📄 레포 규칙 문서 — {note}' for note in notes],
    }


def main(argv):
    if len(argv) < 2 or argv[0] != 'list':
        raise SystemExit("사용: rule_docs.py list <트리> [--ref <ref>] --json '{\"dirs\":[],\"add\":[],\"exclude\":[]}'")
    options = argv[2:]
    def option(name):
        return options[options.index(name) + 1] if name in options else None
    spec = json.loads(option('--json') or '{}')
    ref = option('--ref')
    tree = GitTree(argv[1], ref) if ref else FsTree(argv[1])
    print(json.dumps(discover(tree, spec.get('dirs', ['']), spec.get('add', []), spec.get('exclude', [])), ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
