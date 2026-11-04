#!/usr/bin/env bash
# reviewer 자동 닫기 — scripts/review-result.sh · scripts/lib/reviewer-autoclose.sh.
# 임시 본체·가짜 화면/시계만 사용. 명령 실행기가 자신이 만든 그룹을 정리해도 감시가 남는지 확인한다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
python3 - "$PWD" <<'PY'
import json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time

source = pathlib.Path(sys.argv[1])
failed = 0

def check(label, ok):
    global failed
    print(('  ✔ ' if ok else '  ✖ ') + label, flush=True)
    failed |= not ok

with tempfile.TemporaryDirectory(prefix='reviewer-autoclose-') as temporary:
    root = pathlib.Path(temporary)
    repo = root / 'repo'; repo.mkdir()
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                    'commit', '-q', '--allow-empty', '-m', 'fixture'], check=True)

    def run(name, states, cleanup=False, seconds='60', label='🤖 reviewer · test', enabled='1', inside=True, pane_engine=None, env_engine=None):
        case = root / name; body = case / 'body'
        (body / 'scripts/lib').mkdir(parents=True)
        (body / 'plans/task').mkdir(parents=True)
        (body / 'repos').mkdir(); (body / 'repos/fixture').symlink_to(repo)
        for file in ['plan-path.sh', 'plan_update.py', 'reviewer-autoclose.sh']:
            shutil.copyfile(source / 'scripts/lib' / file, body / 'scripts/lib' / file)
        shutil.copyfile(source / 'scripts/review-result.sh', body / 'scripts/review-result.sh')
        (body / 'scripts/lib/events.mjs').write_text('')
        (body / 'plans/task/test.md').write_text('# 시험\n\n## Checkpoint\n- Work ref: fixture\n')
        if pane_engine:   # 팩 데이터의 pane 기록(scripts/hooks/pane-session.py 가 쓰는 꼴) — 본체 .pack-data 링크로 찾는다
            sessions = case / 'pack-data/state/pane-sessions'; sessions.mkdir(parents=True)
            (sessions / 'p9.json').write_text(json.dumps({'pane': 'p9', 'engine': pane_engine}))
            (body / '.pack-data').symlink_to(case / 'pack-data')
        (case / 'config').write_text(json.dumps({'states': states, 'label': label, 'inside': inside}))
        (case / 'clock').write_text('100')
        screen = body / 'scripts/screen'
        screen.write_text('''#!/usr/bin/env python3
import json,pathlib,sys,time
root=pathlib.Path(__file__).parents[2]
config=json.loads((root/'config').read_text()); args=sys.argv[1:]
if args==['inside']: sys.exit(0 if config['inside'] else 1)
if args[:1]==['self']: print("SCREEN_PANE_ID='p9'"); sys.exit(0)
if args[:2]==['pane','get']:
    first=not (root/'identified').exists()
    (root/'identified').touch()
    if not first:
        deadline=time.monotonic()+5
        while not (root/'poll-allowed').exists():
            if time.monotonic()>deadline: sys.exit(1)
            time.sleep(0.01)
        index=int((root/'polls').read_text()) if (root/'polls').exists() else 0
        (root/'polls').write_text(str(index+1))
        status=config['states'][min(index,len(config['states'])-1)]
        if status=='gone': sys.exit(1)
    else: status='idle'
    print(json.dumps({'pane':{'id':'p9','label':config['label'],'agent_status':status}}))
elif args[:2]==['pane','close']: (root/'closed').write_text((root/'clock').read_text())
''')
        screen.chmod(0o755)
        binary = case / 'bin'; binary.mkdir()
        date = binary / 'date'
        date.write_text('''#!/usr/bin/env python3
import os,pathlib,sys
if sys.argv[1:]==['+%s']: print(pathlib.Path(os.environ['TEST_CLOCK']).read_text())
else: os.execv('/bin/date',['date',*sys.argv[1:]])
'''); date.chmod(0o755)
        sleep = binary / 'sleep'
        sleep.write_text('''#!/usr/bin/env python3
import os,pathlib,time
clock=pathlib.Path(os.environ['TEST_CLOCK']);clock.write_text(str(int(clock.read_text())+5));time.sleep(0.005)
'''); sleep.chmod(0o755)
        env = dict(os.environ, PATH=str(binary)+':'+os.environ['PATH'], TEST_CLOCK=str(case/'clock'),
                   ATHENA_REVIEW_AUTOCLOSE=enabled, ATHENA_REVIEW_AUTOCLOSE_SECS=seconds)
        env.pop('ATHENA_ENGINE', None)
        if env_engine: env['ATHENA_ENGINE'] = env_engine
        process = subprocess.Popen(['bash', str(body/'scripts/review-result.sh'), '--plan', 'plans/task/test.md',
                                    '--dir', str(repo), '--verdict', '승인'], env=env, start_new_session=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = process.communicate(timeout=10)
        if cleanup:
            # 방금 만든 실행 그룹만 정리한다. 새 세션으로 분리된 감시는 이 그룹에 속하지 않는다.
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
        (case/'poll-allowed').touch()
        deadline = time.monotonic()+5
        while not (case/'closed').exists() and time.monotonic()<deadline:
            if states[-1]=='gone' and (case/'polls').exists(): break
            if '🧹' not in stdout: break
            time.sleep(0.02)
        check(name+' — 리뷰 결론 기록 성공', process.returncode==0 and 'Review result: 승인' in stdout)
        if process.returncode: print(stderr)
        (case/'stdout').write_text(stdout)
        return case

    normal = run('Claude와 같은 일반 실행', ['idle'])
    check('기본 정책 — 60초 연속 idle 뒤 닫는다', (normal/'closed').read_text()=='160')
    detached = run('Codex 명령 그룹 정리 재현', ['idle'], cleanup=True)
    check('명령 반환 후 그룹을 정리해도 감시는 살아남아 닫는다', (detached/'closed').exists())
    reset = run('작업·선택 대기 중 시간 초기화', ['idle','idle','working','idle','waiting','idle'])
    check('working·waiting 때 다시 세고 마지막 idle부터 60초', (reset/'closed').read_text()=='185')
    ordinary = run('일반 pane 제외', ['idle'], label='🤖 fe · test')
    check('reviewer 이름표가 아니면 닫지 않는다', not (ordinary/'closed').exists())
    disabled = run('자동 닫기 끔', ['idle'], enabled='0')
    check('명시적으로 껐으면 닫지 않는다', not (disabled/'closed').exists())
    outside = run('화면 계층 밖', ['idle'], inside=False)
    check('화면 계층 밖이면 닫지 않는다', not (outside/'closed').exists())
    gone = run('pane 사라짐', ['gone'])
    check('pane 조회가 실패하면 조용히 끝난다', not (gone/'closed').exists())

    # 검수 묶음 2 #4 — 리뷰한 엔진을 줄에 남긴다(pr-auto 가 그 엔진 자리로만 이어받는다 · 고치기 전: 엔진 없음 → Codex 승인이 claude 몫)
    line = lambda case: next((row for row in (case/'stdout').read_text().splitlines() if row.startswith('- Review result:')), '')
    codex = run('엔진 — pane 기록 codex', ['idle'], label='🤖 fe · test', pane_engine='codex', env_engine='claude')
    check('pane 기록이 먼저 — 🧠 codex · 브랜치 뒤', ' · 🌿 ' in line(codex) and ' · 🧠 codex · ' in line(codex))
    by_env = run('엔진 — ATHENA_ENGINE 만', ['idle'], label='🤖 fe · test', env_engine='claude')
    check('pane 기록이 없으면 ATHENA_ENGINE — 🧠 claude', ' · 🧠 claude · ' in line(by_env))
    unknown = run('엔진 — 모름', ['idle'], label='🤖 fe · test', env_engine='gemini')
    check('모르는 엔진 · 없음 → 엔진을 적지 않는다', '🧠' not in line(unknown) and '🧠' not in line(outside))

sys.exit(int(failed))
PY
