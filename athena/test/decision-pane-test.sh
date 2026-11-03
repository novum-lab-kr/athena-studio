#!/usr/bin/env bash
# scripts/lib/screen.py · scripts/lib/screen.mjs · scripts/plan-html.mjs 회귀: 오래된 self, 명시한 대상, 다른 포커스, 화면 밖.
. "$(dirname "$0")/_lib.sh"
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
python3 - "$SRC" <<'PY'
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

source = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('screen', source / 'scripts/lib/screen.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

class DecisionPaneTest(unittest.TestCase):
    def test_self_keeps_offline_environment_contract(self):
        backend = screen.StudioBackend()
        backend.get_pane = lambda pane: self.fail('self는 오프라인 대화 기록에서도 사용한다')
        with unittest.mock.patch.dict(os.environ, {'ATHENA_STUDIO': '1', 'ATHENA_STUDIO_PANE_ID': 'po2'}):
            self.assertEqual(backend.self_info()['pane_id'], 'po2')
        with unittest.mock.patch.dict(os.environ, {'ATHENA_STUDIO': '0'}):
            self.assertEqual(backend.self_info()['pane_id'], '')

    def test_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(source / 'scripts', root / 'scripts')
            shutil.copytree(source / 'docs', root / 'docs')
            (root / 'plans/task').mkdir(parents=True)
            plan = root / 'plans/task/test.md'
            plan.write_text('# 회귀 시험\n')
            data = root / 'data.json'
            fake = root / 'scripts/screen'
            fake.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log: log.write(json.dumps(args) + '\\n')
mode = os.environ['SELF_MODE']
if args == ['self']:
    if mode == 'error': sys.exit(1)
    print(json.dumps({'inside': mode != 'outside', 'pane_id': {'stale': 'po2', 'valid': 'pu9'}.get(mode, '')}))
elif args[:2] == ['pane', 'get']:
    if args[2] != 'pu9': sys.exit(1)
    print(json.dumps({'pane': {'id': 'pu9'}}))
elif args == ['pane', 'current']:
    print(json.dumps({'pane': {'id': 'focused-other'}}))
else:
    sys.exit(1)
''')
            fake.chmod(0o755)
            log = root / 'calls.jsonl'
            env = dict(os.environ, ATHENA_AGENT='test', CALL_LOG=str(log))
            def caller(mode):
                log.write_text('')
                result = subprocess.run(['node', '--input-type=module', '-e', "import { callerPane } from './scripts/lib/screen.mjs'; console.log(JSON.stringify(callerPane()))"], cwd=root, env=dict(env, SELF_MODE=mode), capture_output=True, text=True, check=True)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                return json.loads(result.stdout), calls
            for mode in ['stale', 'error', 'empty']:
                with self.subTest(mode=mode):
                    selected, calls = caller(mode)
                    self.assertEqual(selected, '')
                    self.assertNotIn(['pane', 'current'], calls)
            self.assertEqual(caller('valid')[0], 'pu9')
            self.assertEqual(caller('outside')[0], 'focused-other')
            def generate(mode, saved='', explicit='', add=False):
                data.write_text(json.dumps({'title': '회귀 시험', 'leadPane': saved, 'decisions': []}))
                args = ['node', 'scripts/plan-html.mjs', str(plan), '--data', str(data)]
                if explicit: args += ['--pane', explicit]
                if add:
                    added = root / 'add.json'
                    added.write_text('[]')
                    args += ['--add', str(added)]
                result = subprocess.run(args, cwd=root, env=dict(env, SELF_MODE=mode), capture_output=True, text=True)
                return result
            for add in [False, True]:
                for mode in ['stale', 'error']:
                    with self.subTest(mode=mode, add=add):
                        plan.with_suffix('.html').unlink(missing_ok=True)
                        result = generate(mode, saved='po2', add=add)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(json.loads(re.search(r'const PLAN = ([\s\S]*?)\n</script>', plan.with_suffix('.html').read_text()).group(1))['leadPane'], '')
                self.assertEqual(generate('stale', explicit='pu9', add=add).returncode, 0)
                self.assertIn('"leadPane": "pu9"', plan.with_suffix('.html').read_text())
            self.assertEqual(generate('error', saved='pu9', add=True).returncode, 0)
            self.assertIn('"leadPane": ""', plan.with_suffix('.html').read_text())
            self.assertEqual(generate('error', saved='pu9').returncode, 0)
            self.assertIn('"leadPane": "pu9"', plan.with_suffix('.html').read_text())
            before = plan.with_suffix('.html').read_text()
            self.assertNotEqual(generate('valid', explicit='po2').returncode, 0)
            self.assertEqual(plan.with_suffix('.html').read_text(), before)

from unittest import mock
unittest.main(argv=[sys.argv[0]], verbosity=2)
PY
