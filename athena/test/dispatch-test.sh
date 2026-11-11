#!/usr/bin/env bash
# delegate.sh 실제 실행기까지 가짜 화면·CLI 로 실행한다. 사용자 pane·레포·인증 정보는 읽거나 쓰지 않는다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
python3 - "$PWD" <<'PY'
import itertools, json, os, pathlib, shlex, shutil, subprocess, sys, tempfile
src = pathlib.Path(sys.argv[1])
fail = 0

def check(name, ok):
    global fail
    print(('  ✔ ' if ok else '  ✖ ') + name, flush=True)
    if not ok: fail = 1

# Python 안내 판정과 실제 JS 흐름을 기본값·엄격한 boolean 판정까지 비교한다.
sys.path.insert(0, str(src / 'scripts/lib'))
from athena_config import auto_flow, direct_merge_mode, merge_mode
entries = [dict(zip(('autoMerge', 'autoPr', 'direct', 'autoMergeManual', 'autoMergeConfirm', 'autoReview'), values), name='web')
           for values in itertools.product((None, False, True), repeat=6)]
flows = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {prFlow} from './scripts/lib/pr-auto.mjs'; let data=''; for await (const chunk of process.stdin) data+=chunk; console.log(JSON.stringify(JSON.parse(data).map(prFlow)))"],
    input=json.dumps(entries), text=True, cwd=src))
def expected_auto_flow(flow):
    if not flow['pr']: return 'off'
    if flow['merge'] != 'manual': return 'merge'
    if flow['review']: return 'manual'
    return 'off'

check('설정 729조합 → Python 안내와 JS 실제 흐름 우선순위 일치', all(
    (merge_mode({'repos':[entry]}, 'web') == flow['merge'] if entry['autoMerge'] is True and not entry['direct'] else True)
    and direct_merge_mode({'repos':[entry]}, 'web') == (flow['merge'] if flow['direct'] else '')
    and auto_flow({'repos':[entry]}, 'web') == expected_auto_flow(flow)
    for entry, flow in zip(entries, flows)))

with tempfile.TemporaryDirectory(prefix='dispatch-test-') as tmp:
    root = pathlib.Path(tmp); core = root / 'core'; work = root / "repo with ' quote"
    shutil.copytree(src / 'scripts', core / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(src / '.claude', core / '.claude')
    shutil.copy(src / 'test/fixtures/lead-screen.py', core / 'scripts/lib/screen.py')
    shutil.copy(src / 'AGENTS.md', core / 'AGENTS.md')
    work.mkdir(); (core / 'repos').mkdir(); (core / 'repos/web').symlink_to(work)
    (work / 'CLAUDE.md').write_text('@AGENTS.md\nCLAUDE_RULE_SENTINEL\n')
    (work / 'AGENTS.md').write_text('# REPO_RULE_SENTINEL\n레포 원문 규칙\n')
    (core / '.claude/agents/fe.md').write_text('---\nname: fe\ndescription: 시험\nmodel: sonnet\ncodexModel: gpt-test-profile\n---\nPROFILE_SENTINEL\n')
    (core / 'plans/task').mkdir(parents=True)
    plan = core / 'plans/task/test.md'
    (root / 'data').mkdir(); (core / '.pack-data').symlink_to(root / 'data')
    bin_dir = root / 'bin'; bin_dir.mkdir()
    cli = '''#!/usr/bin/env python3
import json, os, pathlib, sys
engine = pathlib.Path(sys.argv[0]).name
if sys.argv[1:3] in (['auth', 'status'], ['login', 'status']):
    sys.exit(0 if engine in os.environ['READY_TOOLS'].split(',') else 1)
if engine == 'codex' and sys.argv[1:2] == ['app-server']:
    for line in sys.stdin: pass
    sys.exit(0)
args = sys.argv[1:]
remote = '--remote' in args
if remote:
    index = args.index('--remote'); del args[index:index+2]
pathlib.Path(os.environ['CAPTURE']).write_text(json.dumps({'engine':engine, 'args':args, 'remote':remote, 'role':os.environ.get('ATHENA_ROLE'), 'agent':os.environ.get('ATHENA_AGENT'), 'bootstrap':os.environ.get('ATHENA_NOTIFY_BOOTSTRAP')}))
'''
    for tool in ('claude', 'codex'):
        p = bin_dir / tool; p.write_text(cli); p.chmod(0o755)
    screen = '''#!/usr/bin/env python3
import json, os, pathlib, shlex, subprocess, sys
a=sys.argv[1:]
with open(os.environ['SCREEN_LOG'], 'a') as f: f.write(json.dumps(a)+'\\n')
if a == ['inside']: sys.exit(0)
if a[:1] == ['self']: print('SCREEN_PANE_ID=lead1'); sys.exit(0)
if a == ['workspace','list']: print(json.dumps({'workspaces':[{'id':'web-ws','label':'web'}]}))
elif a[:2] == ['workspace','get']: print(json.dumps({'workspace':{'active_tab_id':'web-tab'}}))
elif a[:2] == ['pane','list']: print(json.dumps({'panes':[{'id':'web-pane','tab_id':'web-tab','cols':100,'rows':30}]}))
elif a[:2] == ['pane','split']: print(json.dumps({'pane':{'id':'new-pane'}}))
elif a[:2] == ['pane','run']:
    # 실행기 내용도 남긴다(reviewer 쓰기 자리 확인용) — 실행이 끝나면 delegate.sh 가 지운다
    with open(os.environ['SCREEN_LOG'], 'a') as f: f.write(json.dumps({'runner': pathlib.Path(shlex.split(a[3])[-1]).read_text()})+'\\n')
    sys.exit(subprocess.run(['bash','-c',a[3]]).returncode)
'''
    (core / 'scripts/screen').write_text(screen); (core / 'scripts/screen').chmod(0o755)
    capture = root / 'capture.json'; log = root / 'screen.jsonl'
    codex_home = root / 'codex-home'; codex_home.mkdir()
    (codex_home / 'config.toml').write_text('# USER_CONFIG_SENTINEL\n')
    (codex_home / 'hooks.json').write_text('{"hooks":{}}\n')
    profiles = {}
    env = dict(os.environ, PATH=str(bin_dir)+':'+os.environ['PATH'], CAPTURE=str(capture), SCREEN_LOG=str(log), ATHENA_TEST_NO_RECORD='1', TMPDIR=str(root)+'/', CODEX_HOME=str(codex_home))
    env.pop('ATHENA_AGENT', None)
    env.pop('CODEX_THREAD_ID', None)
    env['FAKE_LEAD_PANE'] = 'lead1'
    cfg = {'repos':[{'name':'web','agents':['fe'],'prBase':'main','autoMerge':True,'autoPr':False,'ruleDocs':{'add':['AGENTS.md']}}], 'models':{'agentLight':{'claude':'opus','codex':'gpt-test-pack'},'reviewer':{'claude':'sonnet','codex':'gpt-test-review'}}}
    (core / 'pack').mkdir()
    (core / 'pack/pack.json').write_text(json.dumps(cfg))
    (core / 'athena.config.json').write_text(json.dumps({'dataDir': str(root / 'data')}))
    def run(ready, remembered=None, extra=(), prompt="TASK_SENTINEL", issue=False, order=''):
        plan.write_text('# 시험\n\n## Checkpoint\n- Status: in_progress\n- Work ref: pending\n' + order)
        if issue:
            # issue 가 글이면 그대로 Issue 줄(묶음) — 줄에 적힌 이슈 중 '-없음' 으로 끝나지 않는 것만 파일을 만든다
            line = issue if isinstance(issue, str) else 'issues/test.md'
            (core / 'issues').mkdir(exist_ok=True)
            for name in [part for part in line.replace('·', ' ').replace(',', ' ').split() if part.startswith('issues/') and not part.endswith('-없음.md')]:
                (core / name).write_text('# 연결 이슈\n')
            plan.write_text(plan.read_text() + '- Issue: ' + line + '\n')
        capture.unlink(missing_ok=True); log.write_text('')
        saved = core / '.athena-main-tool.json'
        if remembered: saved.write_text(json.dumps({'main':remembered}))
        else: saved.unlink(missing_ok=True)
        env['READY_TOOLS'] = ready
        result = subprocess.run(['bash',str(core/'scripts/delegate.sh'),'fe',*([prompt] if prompt is not None else []), '--plan','plans/task/test.md','--cwd',str(work),*extra],env=env,cwd=core,capture_output=True,text=True)
        return result, json.loads(capture.read_text()) if capture.exists() else None, [json.loads(line) for line in log.read_text().splitlines()]
    for ready, remembered, expected in [('claude',None,'claude'),('codex',None,'codex'),('claude,codex',None,'claude'),('claude,codex','claude','claude'),('claude,codex','codex','codex')]:
        result, got, calls = run(ready, remembered)
        name = ready + ' / ' + str(remembered)
        check(name+' → 엔진·작업자·프로필 분리', result.returncode == 0 and got and got['engine']==expected and got['role']=='agent' and got['agent']=='fe')
        check(name+' → 담당 레포 workspace 에 분할', any(a[:2]==['pane','split'] and a[a.index('--target')+1]=='web-pane' for a in calls))
        if not got: continue
        args = got['args']; prompt = args[-1]
        check(name+' → 같은 계획서·완료 순서·아테나 보고 지시', all(s in prompt for s in ['TASK_SENTINEL','plans/task/test.md','commit.sh','ship.sh','--direct-merge','lead1','묻지 않고']))
        check(name+' → 프로필 모델 전달', args[args.index('--model')+1] == ('sonnet' if expected=='claude' else 'gpt-test-profile'))
        if expected=='codex':
            profile = args[args.index('--profile')+1]
            check('Codex → 본체·역할별 프로필 이름 유지', not profiles or profiles.get('agent') == profile)
            profiles['agent'] = profile
            settings = [args[i+1] for i,a in enumerate(args[:-1]) if a=='-c']
            inst = next(v for v in settings if v.startswith('developer_instructions='))
            text = json.loads(inst.split('=',1)[1])
            check('Codex → 공통 규칙·프로필·레포 원문', all(s in text for s in ['# 레포 규칙 문서','REPO_RULE_SENTINEL','PROFILE_SENTINEL','CLAUDE_RULE_SENTINEL','## 5.']))
            check('Codex → 보호 훅·기록·끝 알림 전달', all(s in (codex_home / (args[args.index('--profile')+1]+'.config.toml')).read_text() for s in ['commit-guard.py','secret-guard.py','process-guard.py','pane-session.py','agent-done-notify.py']))
            check('Codex → 질문·허락 요청 훅 전달', all(value in (codex_home / (profile+'.config.toml')).read_text() for value in ['request_user_input', 'ask-to-request.py', 'PermissionRequest', 'permission-to-request.py']))
            check('Codex → 압축 전 기록·압축 후 재확인 전달', all(value in (codex_home / (profile+'.config.toml')).read_text() for value in ['PreCompact', 'compact-checkpoint.py', 'codex-context.py', 'compact|resume']))
            check('Codex → 전용 remote 연결로 공유 서버를 재사용하지 않음', got.get('remote') is True and '--no-daemon' not in args and '--add-dir' not in args)
            check('Codex → Claude 전용 인자 없음', '--agent' not in args and '--settings' not in args and '--append-system-prompt-file' not in args)
        if remembered is None:
            check(name+' → 실제 주 도구 기록을 새로 쓰지 않는다', not (core / '.athena-main-tool.json').exists())
        check(name+' → 임시 실행기·컨텍스트 정리', not any(root.glob('hermes-*')))
    profile_path = codex_home / (profiles['agent'] + '.config.toml')
    with profile_path.open('a') as handle:
        handle.write('\n[hooks.state."fixture"]\ntrusted_hash = "test-hash"\n')
    result, got, calls = run('codex', None)
    regenerated = profile_path.read_text()
    check('Codex 재디스패치 → [hooks] 표·마커·믿음 기록 유지', result.returncode == 0 and regenerated.startswith('# Athena generated delegation hooks\n[hooks]\n') and '[hooks.state."fixture"]\ntrusted_hash = "test-hash"' in regenerated)
    before = profile_path.stat().st_mtime_ns
    run('codex', None)
    check('같은 훅·믿음 기록이면 프로필을 다시 쓰지 않는다', profile_path.stat().st_mtime_ns == before)
    # Codex 가 덧붙이는 [tui] 같은 다른 절도 남겨야 띄울 때마다 다시 쓰지 않는다
    with profile_path.open('a') as handle:
        handle.write('\n[tui]\nscreen_reader_detection_done = true\n')
    run('codex', None)
    before = profile_path.stat().st_mtime_ns
    run('codex', None)
    check('Codex 가 덧붙인 [tui] 절 유지·다시 쓰지 않음', '[tui]\nscreen_reader_detection_done = true' in profile_path.read_text() and profile_path.stat().st_mtime_ns == before)
    # 그 프로필로 뜬 Codex 창에서 폴더를 믿으면 Codex 가 이 파일에 [projects."<경로>"] 를 쓴다 — 서버 연결이 그 절로 거절되면 안 된다
    def server_args(extra):
        """codex-session.py server_args 를 이 시험 본체 · CODEX_HOME 으로 불러 결과(통과 / 오류 글)를 돌려준다."""
        content = profile_path.read_text()
        profile_path.write_text(content + extra)
        code = "import importlib.util,sys;spec=importlib.util.spec_from_file_location('cs',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\ntry:\n module.server_args(['--profile',sys.argv[2]]);print('ok')\nexcept ValueError as error:print(error)"
        result = subprocess.run([sys.executable, '-c', code, str(core/'scripts/codex-session.py'), profiles['agent']], env=dict(env, ATHENA_ROLE='agent'), capture_output=True, text=True)
        profile_path.write_text(content)
        return result.stdout.strip() or result.stderr.strip()
    trust = '\n[projects."/tmp/novum-web"]\ntrust_level = "trusted"\n'
    check('Codex 가 덧붙인 폴더 믿음 절 → 서버 연결 통과', server_args(trust) == 'ok')
    check('폴더 믿음 절에 다른 키가 섞이면 거절', server_args('\n[projects."/tmp/novum-web"]\ntrust_level = "trusted"\nsandbox_mode = "danger-full-access"\n') == '지원하지 않는 위임 프로필 설정')
    check('그 밖의 절은 여전히 거절', server_args('\n[sandbox_workspace_write]\nnetwork_access = true\n') == '지원하지 않는 위임 프로필 설정')
    with profile_path.open('a') as handle:
        handle.write(trust)
    run('codex', None)
    before = profile_path.stat().st_mtime_ns
    run('codex', None)
    check('폴더 믿음 절 유지·다시 쓰지 않음', trust.strip() in profile_path.read_text() and profile_path.stat().st_mtime_ns == before)
    # 옛 판(hooks= 인라인)을 Codex 0.166 이 신뢰 저장하며 깨뜨린 머리 — 우리 파일로 알아보고 회복한다
    hooks_lines = regenerated.split('[hooks]\n', 1)[1].split('\n[', 1)[0]
    profile_path.write_text('[# Athena generated delegation hooks\nhooks]\n' + hooks_lines + '\n[hooks.state]\n\n[hooks.state."fixture"]\ntrusted_hash = "test-hash"\n')
    result, got, calls = run('codex', None)
    recovered = profile_path.read_text()
    check('깨진 옛 프로필 → 표식 머리로 회복·믿음 기록 유지', result.returncode == 0 and recovered.startswith('# Athena generated delegation hooks\n[hooks]\n') and '[#' not in recovered and '[hooks.state."fixture"]\ntrusted_hash = "test-hash"' in recovered)
    profile_path.write_text('[other]\nkey = 1\n')
    result, got, calls = run('codex', None)
    check('표식 없는 다른 파일은 덮지 않는다', result.returncode != 0 and profile_path.read_text() == '[other]\nkey = 1\n')
    profile_path.write_text(recovered)
    result, got, calls = run('', None)
    check('기록 없음 · 둘 다 없음 → 안내하고 pane 생성 전 거부', result.returncode==2 and got is None and not calls and '설치·로그인된 위임 도구가 없다' in result.stderr)
    result, got, calls = run('claude,codex','claude',('--engine','codex','--role','reviewer','--model','gpt-test-override'))
    check('명시 엔진·리뷰 역할·모델 우선', result.returncode==0 and got and got['engine']=='codex' and got['role']=='reviewer' and got['args'][got['args'].index('--model')+1]=='gpt-test-override')
    if got:
        args = got['args']
        runner = next(call['runner'] for call in calls if isinstance(call, dict))
        line = next((text for text in runner.splitlines() if 'codex-session.py' in text), '')
        roots = [str((core/'plans').resolve()), str((root/'data/state').resolve())]
        check('Codex 리뷰 → 쓰기 자리만 넘기고 본체 --add-dir 없음', '--add-dir' not in runner and all(f"--athena-review-root {path}" in ' '.join(shlex.split(line)) for path in roots) and '--athena-review-root' not in ' '.join(args) and '--add-dir' not in args)
        settings = (codex_home / (args[args.index('--profile')+1]+'.config.toml')).read_text()
        check('Codex 리뷰 → commit 보호 없음, 끝 알림(결정 D2)·시크릿·프로세스 보호 있음', 'commit-guard.py' not in settings and 'agent-done-notify.py' in settings and 'secret-guard.py' in settings and 'process-guard.py' in settings)
        check('리뷰 → 작업자 Work ref 유지', '- Work ref: pending' in plan.read_text() and '- Review:' in plan.read_text())
    # pane 밖(plain) 경로 — reviewer 는 공식 --sandbox read-only, 작업자는 그대로
    for review, expected in ((True, ['--sandbox','read-only','-c','x=1']), (False, ['-c','x=1'])):
        capture.unlink(missing_ok=True)
        plain_env = {key: value for key, value in env.items() if key != 'FAKE_LEAD_PANE'}
        extra_args = ['--athena-review-root', str(root/'data')] if review else []
        subprocess.run(['python3', str(core/'scripts/codex-session.py'), *extra_args, '-c', 'x=1'], env=plain_env, cwd=work, capture_output=True, text=True)
        got = json.loads(capture.read_text()) if capture.exists() else None
        check('plain 경로 → ' + ('reviewer 읽기 전용' if review else '작업자 sandbox 그대로'), got and got['args'] == expected)
    for name in ('sonnet', 'opus[1m]', 'claude-opus-5-5'):
        result, got, calls = run('claude,codex', None, ('--engine','codex','--model',name))
        check(f'Codex 엔진 + Claude 모델 {name} → pane 생성 전 거부', result.returncode==2 and got is None and not calls and 'Claude 모델이라 Codex 엔진으로 띄우지 않는다' in result.stderr)
    result, got, calls = run('claude,codex', None, ('--engine','claude','--model','sonnet'))
    check('Claude 엔진 + sonnet 은 그대로', result.returncode==0 and got and got['engine']=='claude' and got['args'][got['args'].index('--model')+1]=='sonnet')
    result, got, calls = run('claude,codex','codex',('--engine','claude'))
    check('명시 Claude 엔진은 기록한 Codex 보다 먼저', result.returncode==0 and got and got['engine']=='claude')
    result, got, calls = run('claude',None,('--engine','codex'))
    check('명시 엔진이 로그인 안 됨 → pane 생성 없음', result.returncode==2 and not calls)
    result, got, calls = run('codex',None,('--resume','11111111-2222-3333-4444-555555555555'))
    check('Codex resume → 세션 전달·첫 지시 재전송 없음', result.returncode==0 and got and got.get('remote') is True and got['args'][:2]==['resume','11111111-2222-3333-4444-555555555555'] and 'TASK_SENTINEL' not in got['args'][-1])
    for engine in ('claude', 'codex'):
        for prompt, issue, bootstrap in ((None, False, '1'), (None, True, '0'), ('실제 요청', False, '0')):
            result, got, calls = run(engine, prompt=prompt, issue=issue)
            check(f'{engine} — {prompt=}, {issue=} → 시작 안내 표시 {bootstrap}', result.returncode == 0 and got and got['bootstrap'] == bootstrap)
    # 묶음 — Issue 줄의 이슈 경로를 모두 지시문에 싣는다(한글 이름 · · , 구분 · 없는 파일은 뺀다)
    result, got, calls = run('claude', prompt=None, issue='issues/20261110-web-가나.md · issues/20261110-web-다라.md, issues/20261110-web-없음.md')
    text = got['args'][-1] if got else ''
    check('Issue 줄에 이슈 여럿 → 있는 이슈 모두 지시문에 · 없는 파일은 뺌', result.returncode == 0 and got and got['bootstrap'] == '0'
          and str(core / 'issues/20261110-web-가나.md') in text and str(core / 'issues/20261110-web-다라.md') in text and '20261110-web-없음' not in text
          and '이슈 issues/20261110-web-가나.md · issues/20261110-web-다라.md 처리' in text)
    # 계획서 '## 지시' 가 이미 채워졌으면(new-plan.mjs --prompt-file 등) 지시문이 없어도 기다리지 않고 진행한다(2026-11-11 p4a 가 27분 기다림)
    for engine in ('claude', 'codex'):
        result, got, calls = run(engine, prompt=None, order='\n## 지시\n> ORDER_SENTINEL 고치기\n\n## 결과\n- \n')
        text = got['args'][-1] if got else ''
        check(f'{engine} — 채워진 지시 절 · 지시문 없음 → 기다리지 않고 진행', result.returncode == 0 and got and got['bootstrap'] == '0'
              and '지금은 지시가 없다' not in text and "'## 지시' 절이 할 일이다" in text)
        result, got, calls = run(engine, prompt=None, order='\n## 지시\n> (지시문 없음 — pane 에서 대화로 지시)\n\n## 결과\n- \n')
        text = got['args'][-1] if got else ''
        check(f'{engine} — 빈 틀 지시 절 → 요청을 기다린다', result.returncode == 0 and got and got['bootstrap'] == '1' and '지금은 지시가 없다' in text)
    result, got, calls = run('codex', prompt=None, extra=('--resume', '11111111-2222-3333-4444-555555555555'))
    check('지시 없는 resume 은 다음 실제 요청을 시작 안내로 보지 않는다', result.returncode == 0 and got and got['bootstrap'] == '0')
    # 같은 팩 설정을 바꿔 재디스패치한다 — 새 pane / 재사용 pane · 두 엔진에 같은 안내가 실려야 한다.
    (core / 'scripts/reuse-pane.mjs').write_text('console.log(JSON.stringify({pane:"web-pane",cwd:process.env.REUSE_CWD}))\n')
    env['REUSE_CWD'] = str(work.resolve())
    records = root / 'data/state/pane-sessions'
    records.mkdir(parents=True, exist_ok=True)
    (records / 'web-pane.json').write_text(json.dumps({'pane':'web-pane', 'agent':'fe', 'plan':'plans/task/test.md'}))
    for engine in ('claude', 'codex'):
        for reuse in (False, True):
            for manual, confirm, mode_text in ((False, False, '확인 없이 자동 머지'), (False, True, '확인 후 머지'), (True, False, '사람이 직접 머지')):
                for review in (True, False):
                    repo = cfg['repos'][0]
                    repo.update(autoPr=True, autoMergeManual=manual, autoMergeConfirm=confirm, autoReview=review)
                    (core / 'pack/pack.json').write_text(json.dumps(cfg))
                    extra = ('--reuse-pane', 'web-pane') if reuse else ()
                    result, got, calls = run(engine, extra=extra)
                    sent = next((call[3] for call in calls if call[:2] == ['pane', 'send-text']), '') if reuse else (got['args'][-1] if got else '')
                    line = f"올리는 방식: 끝나면 저절로 draft PR({'자동 리뷰' if review else '리뷰 끔'} · {mode_text})"
                    ok = result.returncode == 0 and line in result.stdout and line in sent
                    check(f'{engine} / 재사용={reuse} / {manual=} / {confirm=} / {review=} → 현재 설정 안내', ok)
                    if not ok: print(f'{result.returncode=}\n{result.stdout[-600:]}\n{result.stderr[-600:]}\n전송문: {sent[-600:]}', flush=True)
    env['FAKE_LEAD_CLOSED'] = '1'
    result, got, calls = run('codex')
    check('닫힌 발신자는 실제 위임 경로에서 pane 생성 전 거부', result.returncode == 1 and got is None and not calls and '아테나 발신자를 확인하지 못해' in result.stderr)
    env.pop('FAKE_LEAD_CLOSED')
    check('기존 사용자 설정·훅 파일 유지', (codex_home / 'config.toml').read_text() == '# USER_CONFIG_SENTINEL\n' and (codex_home / 'hooks.json').read_text() == '{"hooks":{}}\n')
sys.exit(fail)
PY
