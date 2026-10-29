# 아테나(athena) 함정·이력

아테나 **자체**(스크립트·현황판·규칙 문서·스킬) 작업에서 밟은 함정. 서비스 레포 함정은 각 레포 `gotchas.md` 에 적는다.
아테나가 `repo: athena` 작업(현황판 [정비] 탭)을 시작할 때 읽는다. 항목은 학습 후보를 사용자가 현황판 [학습] 탭에서 [넣기] 한 것만 들어온다(기준 `docs/knowledge/common/learning.md`).

## 함정

- 멈춘 명령은 TaskStop 이나 확인한 pid 의 `kill <pid>` 로만 끈다 — `pkill` · `killall` · 이름으로 찾아 죽이기 금지(macOS pkill 은 패턴 뒤 옵션을 패턴으로 읽고 `-f` 는 `/Applications` 경로까지 맞춘다 · GH #133). 모든 세션에 `scripts/hooks/process-guard.py` 가 걸려 막는다. 2026-10-29 에이전트의 `pkill -f "cat" -U $(id -u) -x` 로 같은 사용자의 앱 수십 개(Athena Studio Helper 포함)가 꺼졌다

## 학습

학습 루프로 들어온 줄 — 현황판 [학습] 탭에서 수정·삭제한다. 쉬운 설명은 `docs/knowledge/learned/`
