"""아테나 설정 읽기 — scripts/lib/config.mjs 와 같은 규칙(파이썬·bash 안의 파이썬 조각용).

athena.config.json(이 컴퓨터 설정) 에 pack 이 있으면 <pack>/pack.json(회사 팩) 위에 덮어 합친다.
repos 는 팩 것만. pack 이 없으면 athena.config.json 하나가 전부다.

bash 에서:  python3 - "$ATHENA_DIR" <<'PYEOF'
            import sys; sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
            cfg = load(sys.argv[1])
"""
import json
import os


def load(athena_dir):
    with open(os.path.join(athena_dir, 'athena.config.json'), encoding='utf-8') as config_file:
        local = json.load(config_file)
    if not local.get('pack'):
        return local
    pack_dir = os.path.normpath(os.path.join(athena_dir, local['pack']))
    pack_file = os.path.join(pack_dir, 'pack.json')
    if not os.path.isfile(pack_file):
        raise SystemExit(f'팩이 없다: {pack_file} — athena.config.json 의 pack 경로 확인')
    with open(pack_file, encoding='utf-8') as pack_json:
        pack = json.load(pack_json)
    merged = {**pack, **local}
    merged['repos'] = pack.get('repos', [])
    merged['packDir'] = pack_dir
    return merged


def needs_first_run(athena_dir):
    """새 회사 첫 실행이 필요한가 — 설정·팩이 없거나 팩에 레포가 0개면 True (docs/setup.md)."""
    if not os.path.isfile(os.path.join(athena_dir, 'athena.config.json')):
        return True
    try:
        return not load(athena_dir).get('repos')
    except (SystemExit, ValueError, OSError):
        return True


# 보호 브랜치 — 커밋·push 하지 않는 브랜치. 흔한 운영·개발 브랜치 이름 + 팩에 적힌 그 레포의 운영 기준(branch)·작업 base(prBase·extraPrBases)
# (팩이 운영 브랜치를 production 같은 이름으로 쓰면 그것도 막힌다 — commit.sh·ship.sh)
FIXED_PROTECTED = {'dev', 'develop', 'development', 'main', 'master', 'stg', 'staging', 'frz', 'prd', 'prod', 'production'}
PROTECTED_PREFIXES = ('prd-', 'dev-', 'release/')


def protected_branches(cfg, repo_name):
    names = set(FIXED_PROTECTED)
    repo = next((entry for entry in cfg.get('repos', []) if entry.get('name') == repo_name), {})
    for entry in [repo, *(repo.get('apps') or {}).values()]:
        names.update(name for name in [entry.get('branch'), entry.get('prBase'), *(entry.get('extraPrBases') or [])] if name)
    return names


def repo_entry(cfg, repo_name):
    return next((entry for entry in cfg.get('repos', []) if entry.get('name') == repo_name), {})


def is_direct(cfg, repo_name):
    """main 직접 레포인가 — 팩 pack.json 의 레포에 "direct": true. 워크트리·작업 브랜치·PR 없이 메인 체크아웃의 기준 브랜치에서 바로
    작업하고 commit.sh 로 커밋, ship.sh 가 PR 대신 origin/<prBase> 에 빨리 감기로 push 한다(docs/pack.md)."""
    return bool(repo_entry(cfg, repo_name).get('direct'))


def direct_branch(cfg, repo_name):
    """main 직접 레포가 작업·push 하는 브랜치 — prBase(없으면 branch)."""
    repo = repo_entry(cfg, repo_name)
    return repo.get('prBase') or repo.get('branch') or 'main'


def is_protected(cfg, repo_name, branch):
    # main 직접 레포는 그 작업 브랜치(prBase)에 커밋·push 한다 — 그 하나만 보호에서 뺀다(나머지 보호 이름은 그대로)
    if is_direct(cfg, repo_name) and branch == direct_branch(cfg, repo_name):
        return False
    return branch in protected_branches(cfg, repo_name) or branch.startswith(PROTECTED_PREFIXES)
