---
name: sync
description: 팩 pack.json 의 담당 레포 전체를 운영 기준 브랜치(레포별 branch · 모노레포는 앱별)로 훑어 지문을 만들고, 사실마다 정한 정본 문서(knowledge · config · 지문)만 갱신한 뒤 파생 문서를 스크립트로 생성합니다. 이전 sync 이후 바뀐 부분만 찾아 고칩니다.
argument-hint: "(선택) 레포 이름 일부 — 예: web, api. 비우면 전체"
---

# 레포 ↔ 문서 동기화

대상: $ARGUMENTS (비어 있으면 팩 pack.json 의 레포 전체)

각 레포의 `origin/<branch>`(정본은 팩 `pack.json` — 레포별 `branch`, 모노레포는 앱별 `apps.<앱>.branch`, 공통 `packages/*` 는 레포 `branch`)를 기준으로 아테나 문서가 사실과 맞는지 확인하고 틀린 곳만 고친다. 로컬 작업 트리는 브랜치가 제각각이라 **읽지 않는다.** 레포 경로는 `repos/<name>` 링크다. 모노레포는 앱마다 기준 브랜치가 다르므로 `docs/knowledge/<레포>/<앱>/` 과 공통 `common.md` 를 나눠 본다.

## 절차

### 1단계: 지문 생성
```bash
node scripts/sync-fingerprint.mjs            # 전체
node scripts/sync-fingerprint.mjs --repo shop # 특정 레포
```
- 레포별 기준 브랜치(팩 `pack.json` 의 `branch`, 모노레포는 앱마다)를 fetch 하고 지문(스택 버전, scripts, 포트, prettier, 디렉토리 구조, 규칙 문서 blob)을 `.sync/pending/` 에 저장
- 이전 baseline(`.sync/snapshots/`)과 비교한 리포트를 출력하고 `.sync/last-report.md` 에도 남긴다
- 리포트에 "변경 없음 (동일 커밋)" 만 있으면 사용자에게 그렇게 보고하고 종료

### 2단계: 변경 내용 파악 (변경된 레포마다)
리포트의 세 블록을 순서대로 읽는다.
1. **지문 변화** — 버전·명령·포트·디렉토리 diff. 이건 그대로 문서에 반영할 사실이다
2. **규칙·소개 문서 변화** — README, `.ai/basic-rule.md`, `.github/agents/*.agent.md` 등이 바뀐 경우. 반드시 내용을 읽는다:
   ```bash
   git -C repos/<레포> diff <이전sha>..<새sha> -- README.md
   git -C repos/<레포> show origin/<기준브랜치>:.ai/basic-rule.md
   ```
3. **커밋 목록** — 새 도메인/화면이 생겼는지, 라이브러리 교체가 있었는지 힌트. 의심되면 해당 경로를 `git show origin/<기준브랜치>:<path>` 로 확인

지문에 잡히지 않는 큰 구조 변화(예: 라우터 전환, 상태 라이브러리 교체)가 커밋 제목에 보이면 `git -C <레포> diff --stat <이전sha>..<새sha>` 로 범위를 확인한다.

### 3단계: 정본 갱신 (문서마다가 아니라 사실마다)

**사실 하나에 담당 문서 하나다.** 같은 사실을 여러 문서에 따로 적어두지 않는다. 그렇게 해서 생긴 불일치가 이미 여러 건 있었다.

| 사실 | 정본 | 파생 |
|---|---|---|
| 레포·에이전트·기준 브랜치 매핑 | 팩 `pack.json` | — |
| 버전·포트·Node/pnpm·Prettier·검증 스크립트·기준 커밋 | **지문**(`.sync/snapshots/`) | `docs/services.md` 자동 표, `pack/guide/playbook.html`(팩 판) 기준 커밋 표·last sync → **`scripts/build-derived.mjs` 가 생성** |
| 디렉토리·라우트 맵 | `docs/knowledge/<레포>/structure.md` (모노레포는 `<앱>/`) | — |
| 레포 규칙 | 레포 원문(목록은 팩 `ruleDocs` — 세션에 자동으로 실린다) | — |
| 레포에 없는 규칙(팀 지시 · 레포 밖 약속 · 문서와 코드 불일치) | `docs/knowledge/<레포>/rules.md` | — |
| 함정·문서와 코드의 불일치 | `docs/knowledge/<레포>/gotchas.md` | — |
| 대표 예시·절차 | `patterns.md` · `workflows.md` | — |
| 역할·담당 범위·지식 진입 경로 | `.claude/agents/<agent>.md` | — |

**절차**:

1. **지문에서 나오는 사실은 손으로 옮겨 적지 않는다.** 문서 갱신 대신 아래를 돌린다:
   ```bash
   node scripts/build-derived.mjs          # 지문 → services.md 자동 표, playbook 기준 커밋 표·last sync
   node scripts/build-derived.mjs --check  # 쓰지 않고 차이만 확인
   ```
   pending 지문이 있으면 그것을 우선 읽는다(곧 확정할 값으로 문서를 만든다). 마커(`<!-- BEGIN:generated:... -->`) 안은 **직접 편집하지 않는다.**
   이 스크립트는 마커 밖 서술이 지문과 어긋나면 경고만 낸다. 그 경고는 사람이 판단해 고친다.

2. **구조가 바뀌었으면** `docs/knowledge/<레포>/structure.md`를 고친다 (지문의 `dirs`/`routes` 변화를 그대로 반영).

3. **레포 규칙 문서가 바뀌었으면**(리포트의 "규칙·소개 문서 변화" · "규칙 문서 변화" · "팩 `ruleDocs.add` 갱신 제안") 팩 `pack.json` 의 `ruleDocs.add` 목록을 제안대로 갱신한다. 원문은 에이전트 세션에 자동으로 실리니 `rules.md` 에 옮겨 적지 않는다. `rules.md` 의 레포 밖 규칙(팀 지시 · 레포 밖 약속)이 원문과 충돌하면 고치지 말고 "확인 필요"로 표시한다.

4. **에이전트 md 는 역할·담당 범위·지식 진입 경로가 바뀔 때만 고친다.**
   - ⛔ 버전·포트·스택·디렉토리 트리·Prettier 설정을 **다시 넣지 않는다.** 경량화로 걷어낸 것이다
   - ✅ 새 도메인이 생겨 라우팅 문장(frontmatter `description`)에 키워드를 추가하는 것은 한다. YAML 이므로 `: `(콜론+공백)을 쓰지 않는다
   - ✅ 작업 유형별 진입 표가 가리키는 파일·절이 사라졌으면 경로를 고친다

5. **판단이 들어간 문장은 건드리지 않고 표시한다.** 권한 가드 설명, 주의사항, 라우팅 키워드 삭제 같은 것은 보고서에 "확인 필요"로 남긴다. 지문의 버전이 바뀐 것만으로 사용 패턴이 바뀌었다고 단정하지 않는다.

6. **문서가 코드와 다르면 코드가 맞다.** 어느 쪽이 맞는지 확인할 수 없으면 고치지 말고 "확인 필요"로 남긴다.

### 3.5단계: 흐름 문서 · TC 갱신

흐름 문서(`docs/flows/` — 형식 `docs/knowledge/common/qa-flows.md`)는 레포 안에 있어 코드가 바뀌면 낡는다. 지문이 달라진 서비스마다 고칠 흐름을 찾는다:

```bash
node scripts/qa/affected.mjs --service <서비스> --from <이전 baseline sha>
```

문서의 `` `파일:줄` `` 과 바뀐 파일을 대조한다. 여기 안 잡히는 새 화면 · 엔드포인트는 2단계 커밋 목록으로 사람이 본다.

- 고칠 흐름이 있으면 담당 에이전트를 그 레포 워크트리에 띄워 문서 · TC 를 고치게 한다(이 스킬은 레포를 직접 고치지 않는다). 커밋 · PR 은 사용자 말로
- 흐름 문서가 아직 없는 서비스는 건너뛴다
- 흐름 문서는 baseline 이 아니므로 **accept 를 막지 않는다.** 대신 5단계 보고에 적는다
- `--accept` 가 코드가 바뀐 서비스의 TC 를 뒤에서 돌린다(TC 가 있는 것만 · 결과는 현황판 QA 탭). 머지 전 고친 TC 는 아직 안 들어가니, 실패하면 코드 문제인지 낡은 TC 인지 가른다

### 4단계: baseline 확정
문서 갱신이 끝나면:
```bash
node scripts/build-derived.mjs --check      # 파생 문서가 지문과 일치하는지 마지막 확인
node scripts/sync-fingerprint.mjs --accept  # pending → .sync/snapshots/
```

**accept 하지 않는 경우** (하나라도 해당하면 pending 을 그대로 두고 보고한다):
- fetch 실패·기준 ref 부재로 일부 레포를 읽지 못했다
- 리포트에 "확인 필요"로 남긴 항목이 있는데 사용자 확인을 못 받았다
- `build-derived.mjs --check` 가 차이를 보고했다
- 문서 갱신을 일부만 했다

**`--accept` 는 `.sync/pending/` 에 있는 것을 전부 확정한다.** 일부만 고를 수 없다.

⚠️ **`--repo <이름>` 은 pending 을 격리해 주지 않는다.** 그 레포의 지문을 새로 만들 뿐이고, 이전 실행에서 남은 다른 레포의 pending 은 그대로 있다. 그 상태로 accept 하면 **검토하지 않은 레포까지 baseline 이 확정된다.**

그래서 accept 하기 전에 항상 확인한다:

```bash
ls .sync/pending/          # 무엇이 확정될지 눈으로 본다
```

목록에 이번에 검토하지 않은 레포가 있으면, 그 파일을 지우고(`rm .sync/pending/<레포>.json` — 다음 sync 에서 다시 생성된다) accept 하거나, 그 레포까지 마저 검토한다.

성공으로 보고하고 accept 하는 일이 가장 위험하다. 다음 sync 에서 같은 diff 를 다시 보지 못하게 되고, 문서는 틀린 채로 남는다.

### 5단계: 보고
- 3.5단계 — 닿은 흐름 · 맡긴 담당 에이전트 · `--accept` 가 시작한 QA(서비스). 결과는 현황판 QA 탭
- **그 자리에서 고치지 않은 것은 `docs/issues.md` "등록 기준"대로** — 레포당 이슈 하나로 묶고(열린 이슈가 있으면 근거만 덧붙인다), 보안·버그(high)만 바로 등록, 나머지("확인 필요"·코드 문제)는 보고에 "이슈 후보" 표로 적어 사용자가 고르게 한다. 근거는 파일:줄과 기준 ref. 현황판(`/board`) 이슈 칸에 뜬다
- **오래된 이슈** — 30일 넘게 파일이 바뀌지 않은 open 이슈를 표(제목·레포·마지막 수정·추천: 닫기/두기)로 보여 준다. 지우거나 닫지 않는다 — 사용자가 고른다
- 레포별: 기준 브랜치 커밋 범위, 문서에 반영한 사실 목록(파일:항목), "확인 필요"로 남긴 항목
- 변경 없는 레포는 한 줄로
- 첫 실행(baseline 없음)이면: 지문 전체를 각 md 와 대조해 틀린 사실을 고친 결과를 보고하고 accept
- 끝으로 `node scripts/learn-curator.mjs --write` — 30일 넘게 안 쓴 스킬이 있으면 정리 후보 이슈(`…-hermes-learn-curator.md`)를 만들거나 갱신한다. 후보 수만 한 줄로 보고(지우지 않는다)
- 이어서 `node scripts/gotchas-check.mjs --write` — 1단계에서 막 받아온 운영 브랜치로 공책 줄이 가리키는 파일이 아직 있는지, 공책이 나눌 때가 됐는지(공통 2만 자 · 같은 화면 5줄) 본다. 공책마다 정리 후보 이슈(`…-<영역>-learn-gotchas-tidy.md`, [학습] 탭)를 만들거나 갱신하고, 남은 게 없으면 닫는다. 표의 낡은 줄·나누기 수만 보고(공책은 지우지 않는다 — 사람이 [학습] 탭에서)

## 주의
- 이 스킬은 아테나가 **직접** 수행한다 (문서 편집은 코드 작업이 아니므로 FE 에이전트에 넘기지 않는다). 레포 내용을 깊게 읽어야 하면 Explore 에이전트를 써도 된다
- 레포 코드는 절대 수정하지 않는다. 읽기만
- `.sync/snapshots/` 는 baseline 이므로 지우지 않는다. `.sync/pending/`, `.sync/last-report.md` 는 임시
