# 검증 표준

에이전트와 reviewer는 **같은 스크립트**를 기준으로 하고 그 출력 표를 보고서의 "검증 결과"에 그대로 붙인다. reviewer·`commit.sh` 는 `scripts/verify/reuse.sh` 로 부른다 — 같은 트리로 이미 통과했으면 다시 돌리지 않는다(아래 "재사용").

레포별 명령(`scripts/verify/<레포>.sh [인자]`)은 팩 `pack/ROUTING.md` "검증 스크립트", 레포 고유 사정(테스트가 dev 자원에 붙는 레포·알려진 환경 이슈)은 **`docs/knowledge/company/verify.md`**(팩) 에 있다. 함께 읽는다.

## 실행 전 확인
- **워크트리 대상**: 스크립트는 기본으로 메인 체크아웃(`repos/<레포>`)을 검증한다. 워크트리를 검증하려면 `ATHENA_VERIFY_DIR=<워크트리> scripts/verify/<레포>.sh`. `delegate.sh <에이전트> --cwd <워크트리>`로 띄운 pane(reviewer 포함)은 이 값이 이미 들어 있다. 다른 레포의 워크트리를 가리키면 (일반 모드) 경고를 내고 메인 체크아웃을 검증하므로, 여러 레포를 리뷰할 때는 호출마다 붙인다. 결과 표 제목의 브랜치로 어느 트리를 검증했는지 확인한다
- **Node 버전**: 레포 `.nvmrc`와 현재 `node -v`가 같아야 한다. 스크립트가 다르면 경고 단계로 표시한다. 맞추는 법은 `nvm use <버전>`. 값은 각 레포 `.nvmrc`(지문 `.sync/snapshots/<레포>.json` 의 `nvmrc`). `.nvmrc` 가 없으면 검사가 조용히 생략된다
- **작업 base 최신 여부**: 작업 브랜치가 `origin/<prBase>` 보다 뒤처졌으면(`git log --oneline HEAD..origin/<prBase>`) 검증 실패가 내 변경 때문이 아닐 수 있다. 반영이 필요하면 사용자에게 묻는다. 메인 체크아웃을 pull 하지 않는다
- **생성물**: Orval(`__generated__/`)·Relay 아티팩트가 없으면 타입 검사가 실패하거나 건너뛴다. 스크립트가 유무를 확인해 이유를 표시한다
- **타입 검사 단계**(`scripts/verify/_lib.sh` `typecheck_step` — 공용 `_generic.sh` 가 부르고, 레포 스크립트도 부를 수 있다): 지금 폴더에 `tsconfig.json` · `jsconfig.json` · pyright 설정(`pyrightconfig.json` · `pyproject.toml` 의 `[tool.pyright]`)이 있을 때만 줄이 생긴다 — 없으면 그 레포 검증은 지금과 같다. 순수 TS(`allowJs` · `checkJs` 없음)는 오류 하나라도 실패, 섞어 쓰는 중(`allowJs` · `checkJs` · `jsconfig`) · pyright 는 **바뀐 파일**(기준 `origin/<prBase>` merge-base 대비 커밋 + 미커밋 + 미추적)의 오류만 실패이고 전체 오류 수는 결과 칸에 숫자로만 남는다. 레포 스크립트는 `typecheck_step <레포> --all|--changed` 로 정해 부를 수 있다. 기준 ref 를 못 찾으면 미커밋 파일만 보고 그 사실을 결과 칸에 적는다

## 결과 해석
| 표시 | 뜻 |
|---|---|
| ✅ 통과 | 그대로 보고 |
| ❌ 실패 | 마지막 40줄 로그가 함께 출력된다. **내 변경 때문인지 환경 때문인지 구분해서** 보고 |
| ⏭ 건너뜀 | 이유가 함께 표시된다. "통과"라고 쓰지 말고 건너뛴 사실과 이유를 그대로 보고 |
| ⏭ 건너뜀(규칙) | 스크립트가 규칙으로 정한 건너뜀(`skip_step_rule` — 예: 화면 파일이 안 바뀌어 화면 회귀를 안 돌림, `scripts/verify/changed-screen.sh`). 엄격 모드에서도 실패가 아니다. 건너뛴 사실은 그대로 보고 |
| ♻️ 재사용(@시각) | 같은 트리 내용·검증 스크립트·인자로 그 시각에 통과한 기록을 다시 찍은 것(`reuse.sh`). 그 단계의 원래 결과가 함께 적힌다 |

**엄격 모드**(`ATHENA_VERIFY_STRICT=1`, `scripts/commit.sh` 가 켠다 — 커밋 전 검증): 건너뜀(⏭)도 ❌ 실패로 친다. 허용은 사용자 확인 후 `commit.sh --allow-skip "<단계 이름>"`(= `ATHENA_VERIFY_ALLOW_SKIP`)으로만. `ATHENA_VERIFY_DIR` 가 그 레포의 워크트리가 아니면 메인 체크아웃으로 돌지 않고 exit 2 로 멈춘다.

**재사용** — 검증 스크립트가 통과하면 `scripts/verify/_lib.sh` 가 열쇠(트리 내용 + 검증 스크립트 + 인자)로 레포 밖(`${XDG_CACHE_HOME:-~/.cache}/athena/verify-pass/`, 7일 지나면 지움)에 결과 표를 기록한다. `scripts/verify/reuse.sh <레포> [인자]` 는 같은 열쇠면 다시 돌리지 않고 그 표를 `♻️ 재사용(@시각)` 으로 찍는다.
- 트리 내용 = 추적 파일 + 미추적 파일(무시 제외)의 지금 내용 — 커밋 여부·스테이징과 무관하다. 한 글자라도 바뀌면 다시 돈다
- 검증 스크립트 = 그 레포 스크립트 + `scripts/verify/` 코어 파일 + 팩 `pack.json`. 하나라도 바뀌면 다시 돈다
- 실행 환경 = `node -v` · python3 유무. Node 버전이 다른 셸이면 다시 돈다(Node 버전 건너뜀이 환경으로 정해지므로)
- 검증하는 동안 트리가 바뀌었으면 기록하지 않는다
- 엄격 모드에서는 기록에 건너뜀(⏭, 규칙 건너뜀 제외)이 있으면 그 단계가 모두 `--allow-skip` 에 있을 때만 재사용한다
- 꼭 다시 돌려야 하면 `reuse.sh` 대신 `scripts/verify/<레포>.sh` 를 부른다

## red-check (이번 테스트가 이번 변경을 정말 검사하나)
"테스트 추가했고 통과" 가 맞아도 그 테스트가 구현 없이도 통과하면 아무것도 검사하지 않는 것이다. `scripts/verify/red-check.sh --dir <워크트리> [--repo <레포>] [--committed] [--json]` 이 기계로 본다 — 바뀐 파일(기준 `merge-base origin/<prBase> HEAD` 대비 커밋 + 미커밋 + 미추적 · `--committed` 면 HEAD 트리만 — 테스트 내용 · 인라인 판별도 HEAD 에서)을 팩 `redCheck.tests` 글롭으로 테스트/구현으로 나누고, base 로 임시 워크트리를 만들어 **이번 테스트 파일만 지금 내용으로** 복사한 뒤(구현은 base 그대로) 그 파일을 하나씩 `redCheck.run` 으로 돌린다. 임시 워크트리는 끝나면(실패 · 끊김도) 지운다 · heavy.sh 로 줄을 선다. 칸 설정은 `docs/pack.md` "redCheck".
- **언제** — `ship.sh` 가 PR 올릴 때(미리보기 · `--yes` · `--auto-push` — HEAD · merge-base · `redCheck` 칸이 같으면 지난 결과를 다시 쓴다 · `error` 는 다시 쓰지 않는다). 결과는 미리보기에 한 줄 · 계획서 Validation 의 `- red-check:` 줄(레포 · 브랜치마다 한 줄 — PR 본문 "검증" 절 · reviewer · PR 자동 리뷰가 계획서로 본다)에 남고, 아래 ⚠️ 결과면 PR 본문 "확인 필요" 에 한 줄 들어간다(에이전트가 쓴 `--body-file` 에도 — 그 파일은 두고 사본에). 결과가 경고가 아니게 되면 전에 넣은 그 줄을 지운다. 이미 열린 PR 에 push 만 할 때는 본문을 바꾸지 않고 계획서 줄만 바뀐다. 실행이 끊기면(heavy.sh 감시 · Ctrl+C) 돌던 테스트 묶음을 끄고 임시 워크트리를 지운다. 손으로 돌려 보고에 붙여도 된다
- **막지 않는다**(결정 D1 경고만) — 어느 결과도 PR · push 를 멈추지 않는다. ⚠️ 는 사람이 · 리뷰어가 볼 것

| 결과 | 뜻 | 할 일 |
|---|---|---|
| ✅ `ok (assertion)` | 구현 없이(base) 단정이 실패 — 테스트가 이번 변경을 검사한다 | 그대로 |
| ✅ `ok (compile · 약한 근거)` | base 에서 불러오기 · 문법 단계에서 실패(새 구현 파일이 없어서 등) — 단정까지 가지 못해 **검사한다는 근거는 약하다** | 새 모듈을 불러오기만 하는 테스트가 아닌지 본다 |
| ✅ `ok (other)` | 단정도 불러오기도 아닌 실패 — 흔히 base 에 아직 없는 함수를 불러 `TypeError: … is not a function`. compile 처럼 **약한 근거**일 때가 많다 | 결과 줄에 종류가 섞이면(`assertion 1 · other 1`) 파일마다 진행 줄(stderr)을 본다 |
| ⚠️ `non-discriminating` | 구현을 base 로 되돌려도 통과 — 그 파일(결과에 적힌 것)은 이번 변경을 검사하지 않는다 | 테스트가 바뀐 동작을 단정하게 고치거나, 정말 의도한 것이면(동작 그대로인 리팩터 · 이미 있던 동작을 덮는 테스트 보강) 보고 · PR 본문에 이유 |
| ℹ️ `no-tests` | 바뀐 테스트 파일이 없다(`tests` 글롭 기준) | 동작을 바꾼 변경이면 테스트가 필요한지 본다 · 문서 · 설정만이면 그대로 |
| ⏭ `test-only` | 구현은 그대로이고 테스트만 바뀌었다 — 돌리지 않는다(테스트만 고친 PR 은 정상) | 그대로 |
| ⚠️ `unsupported` | 테스트와 구현이 한 파일(바뀐 `.py` 의 doctest `>>>` · `.rs` 의 `#[cfg(test)]`) — 나눌 수 없다. 또는 테스트 경로가 심볼릭 링크(원본이든 base 쪽이든) — 링크를 따라 구현 · 바깥 파일을 덮지 않게 복사하지 않는다 | 사람이 리뷰 |
| ⚠️ `error` | 설정이 틀림 · 기준 ref 없음(fetch) · 명령을 못 찾음(126 · 127) · 300초 넘김 · 신호로 끝남 — **통과로 치지 않는다** | 이유를 보고 고치거나 보고에 그대로 |
| ⏭ 건너뜀(규칙) | 팩에 `redCheck` 칸이 없는 레포 — `ship.sh` 는 줄을 서지 않고 계획서 · 본문에도 남기지 않는다 | 그대로 |

예외 · 한계
- 실패 종류는 출력 글로 가른다(factory-format red-check 와 같은 정규식 — `Cannot find module` · `ModuleNotFoundError` · `SyntaxError` … 가 보이면 compile, `AssertionError` · `expected …` … 면 assertion, 둘 다 아니면 other)
- 구현 쪽에는 테스트 글롭에 안 맞는 모든 바뀐 파일이 들어간다 — 문서만 바뀌고 테스트가 바뀌었으면 `non-discriminating` 이 나온다(구현 변경이 없으니 맞는 말이다 · 이유를 적는다). 테스트 도우미 파일(fixture 등)이 글롭에 안 맞으면 base 것이 쓰인다
- 지운 테스트 파일은 돌리지 않고 구현으로도 치지 않는다. 여러 파일 중 하나라도 base 에서 통과하면 전체가 `non-discriminating` · 결과에 그 파일만

**화면 회귀(screen-check)는 화면 파일이 바뀐 때만** — 코어 레포 검증이 `scripts/verify/changed-screen.sh` 로 판단한다(기준 ref 대비 커밋된 변경 + 미커밋 + 미추적). 화면 파일 = 화면 계층 자체 · screen-check 시나리오가 돌리는 스크립트 · 화면 계층을 부르는 코드 · 그것들이 불러 쓰는 파일. 손으로 적은 목록이 아니라 그때그때 코드에서 찾는다. 늘 돌리려면 검증 인자 `--full`

**검증은 수정한 범위만 돌린다** — 팩 검증 스크립트가 `_lib.sh` 의 `verify_scope_init <레포>` 로 바뀐 파일(`verify_changed_files` 와 같은 셈 — 기준 ref 대비 커밋 + 미커밋 + 미추적)을 읽고, 바뀐 곳에 해당하는 단계만 돌린다. 안 돈 단계는 `skip_step_rule` 로 표에 이유와 함께 남는다(엄격 모드에서도 실패가 아니다). 쓰는 법은 `_lib.sh` 머리 주석(`verify_scope_has` · `verify_scope_only` · `verify_scope_why`).
- **모르면 전체**: `--full`(또는 `ATHENA_VERIFY_FULL=1`) · 기준 ref 를 못 찾음 · 바뀐 파일 없음 · package.json / lockfile / tsconfig · jsconfig · vite.config · `.nvmrc` · pyproject · `.github/` · `scripts/verify/` 변경
- **옛 코어 설치본**에는 함수가 없다 — 팩 스크립트는 `declare -F verify_scope_init` 로 확인하고 없으면 전체를 돌린다
- **athena-studio**: 바뀐 파일이 모두 `athena/` 면 앱 문법 · 루트/renderer 타입 검사 · 앱 시험을 건너뛰고 코어 타입 검사만. 시험은 `scripts/verify/scope-tests.mjs` 가 코드에서 찾아 바뀐 파일에 닿는 것만(앱 `test/*.test.js` · 코어 `athena/test/*.sh`) — 시험 파일의 `import`/`require` · 시험에 적힌 경로를 따라간다. 한계: 셸이 셸을 부르는 것 · 이어 붙여 만든 경로는 못 따라가니 의심되면 `--full`
- **재사용(`reuse.sh`)**: 통과 열쇠에 기준 merge-base 가 들어간다 — 트리가 같아도 기준이 달라지면(범위가 달라질 수 있어) 다시 돈다
- 시험: `athena/test/verify-scope-test.sh`

## QA — 흐름별 TC

레포 `docs/flows/` 의 TC 를 층별로 돌린다(FE Playwright · BE HTTP · 둘 다 로컬 서버 · 앱은 실행 없음). 형식 · 실행 · 설정 정본은 `qa-flows.md`.

```bash
scripts/heavy.sh node scripts/qa/run.mjs --service <서비스> [--cwd <워크트리>]
```

결과는 현황판 QA 탭 · `.qa-runs/`(git 무시). 검증 스크립트와 별개다 — 표에 넣지 않고, 돌렸으면 결과를 보고에 적는다.

## 알려진 환경 이슈 (코드 문제가 아님)
- 회사 레포마다 다르다 — `docs/knowledge/company/verify.md` "알려진 환경 이슈"

## 무거운 명령 (`scripts/heavy.sh` — 2026-10-29 `AGENTS.md` 5절에서 옮김)

**읽을 때**: `heavy.sh` 가 오래 기다리거나 137 로 끝났을 때 · 무거운 명령을 새로 정할 때. 늘 지킬 요지는 `AGENTS.md` 5절.

- 대상: `pnpm/npm install` · `next build` · `next dev` · `tsc` · 테스트 · `relay` · `pkg:link/unlink` · `docker build` — 앞에 `<athena>/scripts/heavy.sh` 를 붙여 돌린다
- 한 대 공용 잠금 **자리 2개**(`ATHENA_HEAVY_SLOTS` 기본 2 · 1 이면 예전처럼 하나 · 1번 `/tmp/hermes-heavy.lock` · 2번 `.lock.2`) — 빈 자리를 잡고 둘 다 차면 기다린다. **둘째 자리는 메모리 여유가 `ATHENA_HEAVY_SECOND_FREE` %(기본 40) 이상이고 1분 부하가 `ATHENA_HEAVY_MAX_LOAD`(기본 = 코어 수) 미만일 때만** 잡고 아니면 첫 자리를 기다린다(못 읽으면 안 잡는다 · 이유는 "부하 N / 코어 M — 둘째 자리 대기" 로 보인다). `xcodebuild` 는 코어를 다 쓰니 `-jobs <코어 절반>` 처럼 코어 일부만 쓰게 한다(2026-10-30 xcodebuild + 검증이 겹쳐 부하 124). 대기 메시지에 자리마다 누가 쓰는지 나온다. 자리마다 137 안전장치 · what/root 기록이 그대로다. 시험 `athena/test/heavy-test.sh`
- 1분 부하가 코어×1.2 를 넘으면 내려갈 때까지 대기, 끝나거나 실패해도 잠금을 푼다
- **도는 동안 감시해서** 자식 프로세스가 300개를 넘거나 메모리 여유가 15% 아래면 그 명령과 자식을 모두 끄고 137 로 끝낸다 — 그러면 폭주한 것이니 원인을 찾기 전에는 다시 돌리지 않고 알린다
- 검증 스크립트(`scripts/verify/*.sh`) · `commit.sh` 검증은 스스로 줄을 선다. 기다리는 동안은 코드 작업을 먼저 하고, `next dev` 는 확인이 끝나면 바로 끈다(잠금을 쥐고 있다)
- 여러 에이전트를 동시에 띄워도 무거운 명령은 이걸로 자동 조절된다(2026-10-02 동시 빌드로 컴퓨터가 죽은 뒤)
- 멈춘 명령은 TaskStop 이나 확인한 pid 의 `kill <pid>` 로만 끈다 — `pkill` · `killall` · 이름으로 찾아 죽이기 금지(macOS pkill 은 패턴 뒤 옵션을 패턴으로 읽고 `-f` 는 `/Applications` 경로까지 맞춘다 · GH #133). 모든 세션에 `scripts/hooks/process-guard.py` 가 걸려 막는다
