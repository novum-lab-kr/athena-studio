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
 (body/'pack/pack.json').write_text(json.dumps({'repos':[{'name':'work','agents':['fe'],'ruleDocs':{'maxChars':10}}]}))
 module.ROOT=body
 saved=os.environ.pop('ATHENA_AGENT',None)
 try:
  message=module.context({'source':'startup','cwd':str(body)})
  assert message.count('CODING_SENTINEL')==1 and 'docs/team-lead.md' in message and 'BODY_RULE_SENTINEL' not in message
  os.environ['ATHENA_AGENT']='fe'
  assert module.context({'source':'startup','cwd':str(work)})==''
  snapshot=root/'current.json';snapshot.write_text(json.dumps('CURRENT_DEVELOPER_SENTINEL'))
  os.environ['ATHENA_CODEX_CONTEXT']=str(snapshot)
  for source in ('compact','resume'):
   message=module.context({'source':source,'cwd':str(work)})
   assert 'CODING_SENTINEL' not in message and '먼저 다시 읽는다' not in message
   assert 'Checkpoint' in message and 'Next' in message and str(work/'AGENTS.md') in message
   assert '재개·압축 후 필수 규칙 재확인' in message and 'CURRENT_DEVELOPER_SENTINEL' in message
  os.environ['ATHENA_CODEX_CONTEXT']=str(root/'missing.json')
  assert 'Checkpoint' in module.context({'source':'resume','cwd':str(work)})
  hooks=json.loads((src/'.codex/hooks.json').read_text())['hooks']
  assert 'PreCompact' in hooks
  assert any('codex-context.py' in handler['command'] for entry in hooks['SessionStart'] for handler in entry['hooks'])
 finally:
  os.environ.pop('ATHENA_CODEX_CONTEXT',None)
  if saved is None:os.environ.pop('ATHENA_AGENT',None)
  else:os.environ['ATHENA_AGENT']=saved
print('✅ Codex 본체·위임·압축·재개 필수 규칙 전달 회귀 통과')
PY
