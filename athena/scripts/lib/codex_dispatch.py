"""위임 Codex 세션 전용 CLI 설정. 기존 사용자 설정·대상 레포 파일은 고치지 않는다.

공통 규칙과 프로필은 developer_instructions 에 더한다(기본 모델 지시문 교체 금지).
보호 훅·pane 기록·끝 알림은 본체의 절대 경로를 써 워크트리에서도 동작한다.
질문·허락 팝업 연결은 별도 단계라 여기에 넣지 않는다.
"""
import json
import hashlib
import os
import pathlib
import sys
import tempfile

import agent_hooks


def toml(value):
    """CLI -c 가 받는 TOML 값. JSON 문자열 이스케이프는 TOML 기본 문자열과 호환된다."""
    if isinstance(value, dict):
        return '{' + ', '.join(json.dumps(key) + ' = ' + toml(item) for key, item in value.items()) + '}'
    if isinstance(value, list):
        return '[' + ', '.join(toml(item) for item in value) + ']'
    return json.dumps(value, ensure_ascii=False)


def settings(root, agent, role, context, definitions):
    root = pathlib.Path(root)
    guards = [] if role == 'reviewer' else [agent_hooks.hook(root, 'scripts/hooks/commit-guard.py')]
    guards += [agent_hooks.hook(root, 'scripts/hooks/secret-guard.py'), agent_hooks.hook(root, 'scripts/hooks/process-guard.py')]
    prompt, stop = agent_hooks.done_notify(root, 'reviewer' if role == 'reviewer' else agent)
    hooks = {
        'PreToolUse': [{'matcher': 'Bash', 'hooks': guards}],
        'SessionStart': [{'hooks': [agent_hooks.pane_session(root)]}],
        'UserPromptSubmit': [{'hooks': [agent_hooks.pane_session(root), agent_hooks.hook(root, 'scripts/hooks/language.py')] + prompt}],
    }
    if stop:
        hooks['Stop'] = stop
    definition = json.loads(pathlib.Path(definitions).read_text(encoding='utf-8'))[agent]
    instructions = pathlib.Path(context).read_text(encoding='utf-8')
    instructions += '\n\n# 에이전트 프로필\n' + definition['prompt']
    instructions += '\n\n현재 역할: ' + role + (' — 읽기 전용 리뷰. 코드·계획서 본문을 고치지 않는다.' if role == 'reviewer' else ' — 담당 레포 작업자.')
    return instructions, hooks


def hook_profile(root, role, hooks):
    """-c hooks 는 훅 소스로 발견되지 않는다. 전용 프로필 파일을 안정된 이름으로 만든다.

    본체·역할별로 같은 이름과 내용을 유지해 사용자의 훅 신뢰 기록을 재사용한다.
    사용자 config.toml·hooks.json 은 건드리지 않고, 우리가 만든 파일만 갱신한다.
    """
    home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
    home.mkdir(parents=True, exist_ok=True)
    name = 'athena-dispatch-' + hashlib.sha256((str(pathlib.Path(root).resolve()) + ':' + role).encode()).hexdigest()[:20]
    path = home / (name + '.config.toml')
    marker = '# Athena generated delegation hooks\n'
    content = marker + 'hooks=' + toml(hooks) + '\n'
    if path.is_symlink():
        raise ValueError('Codex 위임 프로필 자리가 링크라 쓰지 않는다')
    if path.exists():
        old = path.read_text(encoding='utf-8')
        if not old.startswith(marker):
            raise ValueError('Codex 위임 프로필 자리에 다른 파일이 있어 쓰지 않는다')
        if old == content:
            return name
    fd, temp = tempfile.mkstemp(prefix=name + '.', dir=home)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(content)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return name


if __name__ == '__main__':
    root, agent, role, context, definitions, out = sys.argv[1:7]
    instructions, hooks = settings(root, agent, role, context, definitions)
    pathlib.Path(out + '.instructions').write_text('developer_instructions=' + toml(instructions), encoding='utf-8')
    print(hook_profile(root, role, hooks))
