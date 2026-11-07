"""위임 Codex 세션 전용 CLI 설정. 기존 사용자 설정·대상 레포 파일은 고치지 않는다.

공통 규칙과 프로필은 developer_instructions 에 더한다(기본 모델 지시문 교체 금지).
보호 훅·pane 기록·끝 알림은 본체의 절대 경로를 써 워크트리에서도 동작한다.
질문은 같은 요청 훅으로 [작업] 에 올린다.
"""
import json
import hashlib
import os
import pathlib
import re
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
    # 서버 중계 훅은 sessionFlags 출처라 믿음 키가 `<session-flags>/config.toml:<이벤트>:<묶음>:<순번>` 뿐이다
    # (본체 · 역할 구분 없음). 역할마다 같은 자리에 다른 명령이 오면 서로의 믿음을 modified 로 덮으니
    # 공통 훅을 앞에, 역할 전용 훅(commit-guard · 끝 알림 · ask-to-request)을 뒤에 둔다 — test/codex-approvals-test.sh
    guards = [agent_hooks.hook(root, 'scripts/hooks/secret-guard.py'), agent_hooks.hook(root, 'scripts/hooks/process-guard.py')]
    if role != 'reviewer':
        guards.append(agent_hooks.hook(root, 'scripts/hooks/commit-guard.py'))
    prompt, stop = agent_hooks.done_notify(root, 'reviewer' if role == 'reviewer' else agent)
    hooks = {
        'PreToolUse': [{'matcher': 'Bash', 'hooks': guards}],
        'PermissionRequest': agent_hooks.permission_request(root),
        'PreCompact': [{'hooks': [agent_hooks.hook(root, 'scripts/hooks/compact-checkpoint.py', 'pre')]}],
        'SessionStart': [{'hooks': [agent_hooks.pane_session(root)]},
                         {'matcher': 'compact|resume', 'hooks': [{**agent_hooks.hook(root, 'scripts/hooks/codex-context.py'), 'additionalContextLimit': 100000}]}],
        'UserPromptSubmit': [{'hooks': [agent_hooks.pane_session(root), agent_hooks.hook(root, 'scripts/hooks/language.py')] + prompt}],
    }
    if role != 'reviewer':
        hooks['PreToolUse'].append({'matcher': '^request_user_input$', 'hooks': [agent_hooks.hook(root, 'scripts/hooks/ask-to-request.py')]})
    if stop:
        hooks['Stop'] = stop
    # 압축이 가까우면(압축 기준의 70%) 모델에게만 한 번 알림 — Claude 위임과 같이 reviewer 는 빼고, 끝 알림 뒤(새 자리)에 둬 이미 믿은 자리를 옮기지 않는다
    if role != 'reviewer':
        warn = agent_hooks.hook(root, 'scripts/hooks/compact-checkpoint.py', 'warn --tool=codex')
        hooks['UserPromptSubmit'][0]['hooks'].append(warn)
        hooks['PostToolUse'] = [{'hooks': [warn]}]
    definition = json.loads(pathlib.Path(definitions).read_text(encoding='utf-8'))[agent]
    instructions = pathlib.Path(context).read_text(encoding='utf-8')
    instructions += '\n\n# 에이전트 프로필\n' + definition['prompt']
    instructions += '\n\n현재 역할: ' + role + (' — 읽기 전용 리뷰. 코드·계획서 본문을 고치지 않는다. 쓰기 영역은 계획서 폴더 · 팩 state · git 객체 · 임시 폴더뿐이라 대상 트리에 쓰는 명령(전체 검증 등)은 sandbox 에 막힌다 — 그때는 승인을 요청해 다시 돌린다.' if role == 'reviewer' else ' — 담당 레포 작업자.')
    return instructions, hooks


def hook_profile(root, role, hooks):
    """TUI 전용 프로필 파일을 안정된 이름으로 만든다. 서버 중계에는 같은 훅을 sessionFlags로 전달한다.

    본체·역할별로 같은 이름과 내용을 유지해 사용자의 훅 신뢰 기록을 재사용한다.
    사용자 config.toml·hooks.json 은 건드리지 않고, 우리가 만든 파일만 갱신한다.
    """
    home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
    home.mkdir(parents=True, exist_ok=True)
    name = 'athena-dispatch-' + hashlib.sha256((str(pathlib.Path(root).resolve()) + ':' + role).encode()).hexdigest()[:20]
    path = home / (name + '.config.toml')
    marker = '# Athena generated delegation hooks\n'
    # Codex 는 신뢰 저장 때 TOML 을 표로 다시 쓴다. 루트 inline table 은
    # 앞 주석까지 표 이름으로 옮길 수 있으므로 처음부터 [hooks] 표를 쓴다.
    content = marker + '[hooks]\n' + ''.join(key + ' = ' + toml(value) + '\n' for key, value in hooks.items())
    if path.is_symlink():
        raise ValueError('Codex 위임 프로필 자리가 링크라 쓰지 않는다')
    if path.exists():
        old = path.read_text(encoding='utf-8')
        # 옛 판(표식 뒤 `hooks=` 인라인 표)은 Codex 0.166 이 신뢰를 저장하며
        # 첫 줄을 `[# Athena generated delegation hooks` / `hooks]` 로 깨뜨렸다.
        # 그 모양도 우리가 만든 파일로 알아보고 고쳐 쓴다.
        if not (old.startswith(marker) or old.startswith('[' + marker + 'hooks]\n')):
            raise ValueError('Codex 위임 프로필 자리에 다른 파일이 있어 쓰지 않는다')
        # 신뢰 해시([hooks.state…])·화면 설정([tui]) 같은 Codex 가 덧붙인 절은
        # 그대로 두고 우리 훅 정의만 새로 쓴다(정의가 바뀌면 신뢰 재확인은 Codex 가 해시로 판단한다).
        sections = re.split(r'(?=^\[)', old, flags=re.M)
        # 첫 조각은 표식 주석, `[hooks]` 와 깨진 머리(`[# …`)는 우리 훅 정의라 새로 쓴다.
        kept = ''.join(section for section in sections if section.startswith('[') and not re.match(r'\[(?:hooks\]\s*$|#)', section.split('\n', 1)[0]))
        if kept:
            content += '\n' + kept.lstrip('\n')
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
    pathlib.Path(out + '.context.json').write_text(json.dumps(instructions, ensure_ascii=False), encoding='utf-8')
    os.chmod(out + '.context.json', 0o600)
    pathlib.Path(out + '.hooks').write_text(json.dumps(hooks, ensure_ascii=False), encoding='utf-8')
    pathlib.Path(out + '.instructions').write_text('developer_instructions=' + toml(instructions), encoding='utf-8')
    print(hook_profile(root, role, hooks))
