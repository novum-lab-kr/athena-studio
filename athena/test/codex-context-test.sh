#!/usr/bin/env bash
# 본체/위임/압축/재개의 실제 생성 입력을 확인한다. 모델의 100% 준수를 보장하는 시험은 아니다.
. "$(dirname "$0")/_lib.sh"
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - "$PWD" <<'PY'
import importlib.util,json,os,pathlib,shutil,sys,tempfile
src=pathlib.Path(sys.argv[1])
sys.path.insert(0,str(src/'scripts/lib'))
spec=importlib.util.spec_from_file_location('codex_context',src/'scripts/hooks/codex-context.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='codex-context-') as tmp:
 root=pathlib.Path(tmp);body=root/'body';work=root/'work'
 (body/'.claude/rules').mkdir(parents=True);work.mkdir()
 (body/'AGENTS.md').write_text('BODY_RULE_SENTINEL')
 (body/'.claude/rules/coding-standards.md').write_text('CODING_SENTINEL')
 shutil.copytree(src/'scripts/lib',body/'scripts/lib',ignore=shutil.ignore_patterns('__pycache__'))
 (body/'scripts/hooks').mkdir();shutil.copyfile(src/'scripts/hooks/compact-checkpoint.py',body/'scripts/hooks/compact-checkpoint.py')
 (work/'AGENTS.md').write_text('REPO_SENTINEL'*100)
 (body/'pack').mkdir();(body/'repos').mkdir();(body/'repos/work').symlink_to(work)
 (body/'athena.config.json').write_text('{"pack":"pack"}')
 # #17 — Claude 는 CLAUDE.md 의 @AGENTS.md · @docs/team-lead.md 와 그 안의 @../pack/ROUTING.md 를 본문째 받는다(실제 본체와 같은 모양)
 (body/'docs').mkdir()
 (body/'CLAUDE.md').write_text('# Athena — 팀 리드 (Claude Code)\n\n@AGENTS.md\n\n@docs/team-lead.md\n')
 (body/'docs/team-lead.md').write_text('LEAD_SENTINEL\n\n@../pack/ROUTING.md\n\nLEAD_TAIL_SENTINEL\n')
 (body/'pack/ROUTING.md').write_text('ROUTING_SENTINEL | 갈래 표\n')
 (body/'pack/pack.json').write_text(json.dumps({'repos':[{'name':'work','agents':['fe'],'ruleDocs':{'maxChars':10}}]}))
 module.ROOT=body
 saved=os.environ.pop('ATHENA_AGENT',None)
 try:
  message=module.context({'source':'startup','cwd':str(body)})
  assert message.count('CODING_SENTINEL')==1 and 'BODY_RULE_SENTINEL' not in message
  # 리드 규칙 · 라우팅 표가 "읽어라" 한 줄이 아니라 본문으로 · @ 줄은 남지 않는다 · AGENTS.md 는 Codex CLI 가 읽으니 싣지 않는다
  assert message.count('LEAD_SENTINEL')==1 and message.count('LEAD_TAIL_SENTINEL')==1 and message.count('ROUTING_SENTINEL')==1, message
  assert message.index('LEAD_SENTINEL')<message.index('ROUTING_SENTINEL')<message.index('LEAD_TAIL_SENTINEL')
  assert '@../pack/ROUTING.md' not in message and '@docs/team-lead.md' not in message
  # 없는 참조는 경로를 남겨 직접 읽게 한다
  (body/'pack/ROUTING.md').unlink()
  missing=module.context({'source':'startup','cwd':str(body)})
  assert 'LEAD_SENTINEL' in missing and 'ROUTING_SENTINEL' not in missing and f'직접 읽는다: {body}/pack/ROUTING.md)' in missing, missing
  (body/'pack/ROUTING.md').write_text('ROUTING_SENTINEL | 갈래 표\n')
  os.environ['ATHENA_AGENT']='fe'
  assert module.context({'source':'startup','cwd':str(work)})==''
  snapshot=root/'current.json';snapshot.write_text(json.dumps('CURRENT_DEVELOPER_SENTINEL'))
  os.environ['ATHENA_CODEX_CONTEXT']=str(snapshot)
  for source in ('compact','resume'):
   message=module.context({'source':source,'cwd':str(work)})
   assert 'CODING_SENTINEL' not in message and '먼저 다시 읽는다' not in message
   assert 'LEAD_SENTINEL' not in message and 'ROUTING_SENTINEL' not in message
   assert 'Checkpoint' in message and 'Next' in message and str(work/'AGENTS.md') in message
   assert '재개·압축 후 필수 규칙 재확인' in message and 'CURRENT_DEVELOPER_SENTINEL' in message
  os.environ['ATHENA_CODEX_CONTEXT']=str(root/'missing.json')
  assert 'Checkpoint' in module.context({'source':'resume','cwd':str(work)})
  hooks=json.loads((src/'.codex/hooks.json').read_text())['hooks']
  assert 'PreCompact' in hooks
  assert any('codex-context.py' in handler['command'] for entry in hooks['SessionStart'] for handler in entry['hooks'])
  # 리드 문맥은 team-lead.md · ROUTING.md 본문까지(실제 본체 12,093자 · 2026-11-04) — 위임 압축·재개 훅과 같은 한도(사용자 결정 r-20261104-134449-7fd6)
  assert all(handler.get('additionalContextLimit',0)>=100000 for entry in hooks['SessionStart'] for handler in entry['hooks'] if 'codex-context.py' in handler['command'])
 finally:
  os.environ.pop('ATHENA_CODEX_CONTEXT',None)
  if saved is None:os.environ.pop('ATHENA_AGENT',None)
  else:os.environ['ATHENA_AGENT']=saved
print('✅ Codex 본체·위임·압축·재개 필수 규칙 전달 회귀 통과')
PY
