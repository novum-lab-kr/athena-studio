"""아테나 설정 읽기 — scripts/lib/config.mjs 와 같은 규칙(파이썬·bash 안의 파이썬 조각용).

athena.config.json(이 컴퓨터 설정) 에 pack 이 있으면 <pack>/pack.json(팩) 위에 덮어 합친다.
repos 는 팩 것만. pack 이 없으면 athena.config.json 하나가 전부다.

bash 에서:  python3 - "$ATHENA_DIR" <<'PYEOF'
            import sys; sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
            cfg = load(sys.argv[1])
"""
import json
import os
import re

ACTIVE_LINK = '.pack-data'


def _read_json(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def body_config(athena_dir):
    return _read_json(os.path.join(athena_dir, 'athena.config.json')) or {}


def data_dir(athena_dir):
    """사용자 데이터 폴더 — ATHENA_DATA_DIR → 본체 설정 dataDir(스튜디오가 채운다) → ~/.athena-studio/data (config.mjs dataDir 와 같다)."""
    value = os.environ.get('ATHENA_DATA_DIR') or body_config(athena_dir).get('dataDir') or os.path.join(os.path.expanduser('~'), '.athena-studio', 'data')
    return os.path.normpath(os.path.join(athena_dir, os.path.expanduser(value)))


def paths(athena_dir):
    """경로 묶음 — config.mjs paths() 와 같은 모양(mode · packDir · plans · issues · state · worktrees · packId · generation)."""
    active = os.path.join(athena_dir, ACTIVE_LINK)
    data = data_dir(athena_dir)
    if not os.path.islink(active):
        local = body_config(athena_dir)
        return {
            'root': athena_dir, 'mode': 'legacy', 'dataDir': data, 'packData': None, 'packDataReal': None,
            'packDir': os.path.normpath(os.path.join(athena_dir, local['pack'])) if local.get('pack') else None,
            'plans': os.path.join(athena_dir, 'plans'), 'issues': os.path.join(athena_dir, 'issues'), 'state': athena_dir,
            'worktrees': os.environ.get('ATHENA_WORKTREE_ROOT') or os.path.join(athena_dir, '.worktrees'),
            'packId': None, 'generation': None,
        }
    real = os.path.normpath(os.path.join(athena_dir, os.readlink(active)))
    registry = _read_json(os.path.join(data, 'config.json')) or {}
    return {
        'root': athena_dir, 'mode': 'packs', 'dataDir': data, 'packData': active, 'packDataReal': real,
        'packDir': os.path.join(athena_dir, 'pack'),
        'plans': os.path.join(athena_dir, 'plans'), 'issues': os.path.join(athena_dir, 'issues'), 'state': os.path.join(active, 'state'),
        'worktrees': os.environ.get('ATHENA_WORKTREE_ROOT') or os.path.join(real, 'worktrees'),
        # 세대는 팩마다(config.mjs paths 와 같다)
        'packId': os.path.basename(real), 'generation': ((registry.get('packs') or {}).get(os.path.basename(real)) or {}).get('generation', 0),
    }


def load(athena_dir):
    where = paths(athena_dir)
    if where['mode'] == 'packs':
        # 여러 팩 구조 — 본체 설정의 pack 은 쓰지 않는다(활성 링크가 정본). 팩의 이 컴퓨터 설정은 <팩 데이터>/local.json
        local = {key: value for key, value in body_config(athena_dir).items() if key != 'pack'}
        pack_file = os.path.join(where['packDir'], 'pack.json')
        if not os.path.isfile(pack_file):
            raise SystemExit(f'팩이 아직 없다: {pack_file} — 새 팩이면 claude 를 켜고 /setup')
        with open(pack_file, encoding='utf-8') as pack_json:
            pack = json.load(pack_json)
        pack_local = _read_json(os.path.join(where['packData'], 'local.json')) or {}
        merged = {**pack, **local, **pack_local}
        merged['repos'] = pack.get('repos', [])
        merged['packDir'] = where['packDir']
        merged['packId'] = where['packId']
        return merged
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
    """새 회사 첫 실행이 필요한가 — 설정·팩이 없거나 팩에 레포가 0개면 True (docs/setup.md).
    여러 팩 구조에서는 지금 팩 자리(pack/pack.json)가 없으면(pack new 직후) 첫 실행이다."""
    if paths(athena_dir)['mode'] == 'legacy' and not os.path.isfile(os.path.join(athena_dir, 'athena.config.json')):
        return True
    try:
        return not load(athena_dir).get('repos')
    except (SystemExit, ValueError, OSError):
        return True


def switching(athena_dir):
    """이 본체의 팩에 작업 잠금이 걸려 있나(열기·업데이트 중) — <데이터>/locks/<팩 id>.lock 의 pid 가 살아 있으면 True
    (새 작업을 받지 않는다 · config.mjs isSwitching 과 같다). 다른 팩의 잠금은 이 본체를 막지 않는다."""
    where = paths(athena_dir)
    if where['mode'] != 'packs':
        return False
    lock = os.path.join(where['dataDir'], 'locks', f"{where['packId']}.lock")
    try:
        with open(os.path.join(lock, 'pid'), encoding='utf-8') as handle:
            pid = int(handle.read().strip() or 0)
    except (OSError, ValueError):
        return False
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def port_base(registry):
    """현황판 포트 기준 — 레지스트리 portBase(config.mjs portBaseOf 와 같다). 없거나 이상하면 4700."""
    value = (registry or {}).get('portBase')
    if isinstance(value, int) and not isinstance(value, bool) and 1024 <= value <= 65400:
        return value
    return 4700


def board_port(athena_dir):
    """현황판 포트 — config.mjs boardPort 와 같다. 여러 팩: 레지스트리 packs.<id>.boardPort → 본체 설정 → ATHENA_BOARD_PORT
    → 레지스트리 portBase → 4700. 옛 구조: ATHENA_BOARD_PORT → 본체 설정 → 4700."""
    where = paths(athena_dir)
    if where['mode'] == 'packs':
        registry = _read_json(os.path.join(where['dataDir'], 'config.json')) or {}
        saved = ((registry.get('packs') or {}).get(where['packId']) or {}).get('boardPort')
        return int(saved or body_config(athena_dir).get('boardPort') or os.environ.get('ATHENA_BOARD_PORT') or port_base(registry))
    return int(os.environ.get('ATHENA_BOARD_PORT') or body_config(athena_dir).get('boardPort') or 4700)


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


def auto_flow(cfg, repo_name):
    """자동 흐름이 할 일 — 'off'(없음 · draft PR 까지) · 'manual'(리뷰만) · 'merge'(머지까지). scripts/lib/pr-auto.mjs prFlow · autoMergeRepos 와 같은 기준(docs/pr-auto.md "켜기")."""
    entry = repo_entry(cfg, repo_name)
    if entry.get('autoMerge') is not True or entry.get('direct'):
        return 'off'
    if entry.get('autoPr') is False:
        return 'off'   # PR 끔 — PR 도 자동 리뷰도 없다(바로 머지는 direct_merge_mode · ship.sh --direct-merge)
    manual = entry.get('autoMergeManual') is True
    if entry.get('autoReview') is False and manual:
        return 'off'
    return 'manual' if manual else 'merge'


def direct_merge_mode(cfg, repo_name):
    """PR 끔(autoMerge true + autoPr false · main 직접 레포 제외)이면 머지 방식 'auto' · 'confirm' · 'manual', 아니면 ''.
    scripts/lib/pr-auto.mjs prFlow 와 같은 기준(docs/pr-auto.md "켜기" — PR 없이 prBase 에 바로 머지)."""
    entry = repo_entry(cfg, repo_name)
    if entry.get('autoMerge') is not True or entry.get('direct') or entry.get('autoPr') is not False:
        return ''
    if entry.get('autoMergeManual') is True:
        return 'manual'
    return 'auto' if entry.get('autoMergeConfirm') is False else 'confirm'


def direct_branch(cfg, repo_name):
    """main 직접 레포가 작업·push 하는 브랜치 — prBase(없으면 branch)."""
    repo = repo_entry(cfg, repo_name)
    return repo.get('prBase') or repo.get('branch') or 'main'


def is_protected(cfg, repo_name, branch):
    # main 직접 레포는 그 작업 브랜치(prBase)에 커밋·push 한다 — 그 하나만 보호에서 뺀다(나머지 보호 이름은 그대로)
    if is_direct(cfg, repo_name) and branch == direct_branch(cfg, repo_name):
        return False
    return branch in protected_branches(cfg, repo_name) or branch.startswith(PROTECTED_PREFIXES)


# 역할마다 Claude 모델 — 팩 pack.json 최상위 "models"(scripts/lib/models.mjs 와 같은 규칙 · docs/pack.md "pack.json")
MODEL_ROLES = ('athena', 'agent', 'agentLight', 'reviewer', 'reviewerEscalated', 'prReview', 'prReviewSecond', 'learnReview')
# fullmatch 로만 검사한다 — match 와 $ 는 끝 줄바꿈('sonnet\n')을 통과시켜 JS 판정과 갈린다
_MODEL_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:@/\[\]-]*')


def model_of(cfg, role):
    """역할의 모델 이름 — 없으면 ''. 형식이 이상하면(모르는 역할 · 문자열 아님 · 빈 값 · 공백 · 따옴표 등) ValueError(무시하지 않는다)."""
    if role not in MODEL_ROLES:
        raise ValueError(f'모르는 모델 역할: {role}')
    models = cfg.get('models')
    if models is None:
        return ''
    if not isinstance(models, dict):
        raise ValueError('pack.json "models" 는 { "<역할>": "<모델>" } 모양이어야 한다')
    for key, value in models.items():
        if key not in MODEL_ROLES:
            raise ValueError(f'pack.json "models" 에 모르는 역할: {key}(가능: {" · ".join(MODEL_ROLES)})')
        if not isinstance(value, str) or not _MODEL_NAME.fullmatch(value):
            raise ValueError(f'pack.json "models.{key}" 모델 이름이 이상하다: {json.dumps(value, ensure_ascii=False)}')
    return models.get(role, '')


def profile_model(profile_path):
    """에이전트 프로필 frontmatter 의 model: 값 — 없거나 inherit 면 ''(inherit 는 띄운 쪽 모델을 따른다는 뜻이라 팩 값을 쓴다)."""
    try:
        with open(profile_path, encoding='utf-8') as handle:
            text = handle.read()
    except OSError:
        return ''
    if not text.startswith('---'):
        return ''
    front = text.split('---', 2)[1] if text.count('---') >= 2 else ''
    for line in front.splitlines():
        match = re.match(r'^model:\s*(.*?)\s*$', line)
        if match:
            value = match.group(1).strip('\'"')
            return '' if value in ('', 'inherit') else value
    return ''


def _tree_repo_branch(athena_dir, work_dir):
    """작업 트리의 (레포, 브랜치) — scripts/review-result.sh 가 "- Review result:" 줄에 적는 📦 · 🌿 와 같은 방법.
    레포는 워크트리의 메인 체크아웃을 가리키는 repos/<이름> 링크, 못 찾으면 메인 체크아웃 폴더 이름. git 이 아니면 ('', '')."""
    import subprocess
    def git(*args):
        result = subprocess.run(['git', '-C', work_dir, *args], capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None
    if not work_dir or git('rev-parse', '--short', 'HEAD') is None:
        return '', ''
    branch = git('symbolic-ref', '--short', '-q', 'HEAD') or 'detached'
    listing = git('worktree', 'list', '--porcelain') or ''
    main = next((row[len('worktree '):] for row in listing.splitlines() if row.startswith('worktree ')), '')
    main = os.path.realpath(main) if main and os.path.isdir(main) else ''
    repo = os.path.basename(main or work_dir.rstrip('/'))
    links = os.path.join(athena_dir, 'repos')
    for name in sorted(os.listdir(links)) if os.path.isdir(links) else []:
        if main and os.path.realpath(os.path.join(links, name)) == main:
            repo = name
    return repo, branch


def review_needs_fix(plan_text, repo, branch):
    """계획서의 같은 레포 · 브랜치 "- Review result:" 마지막 줄이 수정 필요인가(scripts/review-wait.sh 와 같은 줄 고르기)."""
    if not repo or not branch:
        return False
    mark = f'📦 {repo} · 🌿 {branch} '
    rows = [row for row in plan_text.splitlines() if row.startswith('- Review result:') and mark in row]
    return bool(rows) and rows[-1][len('- Review result:'):].lstrip().startswith('수정 필요')


def model_role(athena_dir, agent, plan='', work_dir=''):
    """(역할, 대신 쓸 역할) — reviewer 는 같은 레포 · 브랜치 리뷰 결론이 수정 필요면 reviewerEscalated(없으면 reviewer),
    그 밖의 에이전트는 경량 계획서(plans/task/…)면 agentLight(없으면 agent). 그 밖은 대신 쓸 역할 없음(계획서 2026-10-29 D1 · D2)."""
    if agent == 'reviewer':
        if plan:
            try:
                with open(os.path.join(athena_dir, plan), encoding='utf-8') as handle:
                    text = handle.read()
            except OSError:
                text = ''
            if review_needs_fix(text, *_tree_repo_branch(athena_dir, work_dir)):
                return 'reviewerEscalated', 'reviewer'
        return 'reviewer', None
    if plan.startswith('plans/task/'):
        return 'agentLight', 'agent'
    return 'agent', None


def agent_model(athena_dir, agent, plan='', work_dir=''):
    """delegate.sh 가 붙일 --model 값 — 프로필 frontmatter model: 이 있으면 그 값(프로필이 이긴다), 없으면 팩 models 의
    model_role 역할 값(비었으면 대신 쓸 역할 값), 그것도 없으면 ''(--model 을 붙이지 않는다).
    plan 은 본체 기준 논리 경로(plans/…md), work_dir 은 띄울 작업 트리(reviewer 의 리뷰 결론을 레포 · 브랜치로 고른다).
    프로필 값도 --model 로 넘긴다 — 워크트리에서 띄우면 프로필을 --agents JSON 으로 다시 만들어 넘기는데(agent-context.py) 거기에는 model 이 없다."""
    # 팩 models 는 프로필 값이 있어도 먼저 전체를 검사한다 — 잘못된 값이 프로필 뒤에 숨어 그냥 넘어가지 않게
    cfg = load(athena_dir)
    role, fallback = model_role(athena_dir, agent, plan, work_dir)
    pack_model = model_of(cfg, role) or (model_of(cfg, fallback) if fallback else '')
    profile = os.path.join(athena_dir, '.claude', 'agents', f'{agent}.md')
    own = profile_model(profile)
    if own:
        if not _MODEL_NAME.fullmatch(own):
            raise ValueError(f'{profile} 의 model: 이름이 이상하다: {json.dumps(own, ensure_ascii=False)}')
        return own
    return pack_model
