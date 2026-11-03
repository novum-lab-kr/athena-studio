# 서비스 그림 작성

`/diagram`(Claude)·`$diagram`(Codex)의 서비스 그림은 현재 팩의 `pack/diagrams/`가 정본이다. 아테나 자체 작업 흐름은 코어 `docs/diagrams/`에 그대로 둔다. QA 문서·실행기와 독립된 경로다.

## 서비스·근거

- 기존 `pack/diagrams/SERVICES.md`, `guides/<서비스>.md`, `index.json`을 재사용한다. 새 팩은 init 뼈대에서 표·카드를 만든다. 기존 팩에 없으면 `pack.json`의 레포·모노레포 앱과 실제 코드를 읽어 필요한 항목만 만든다. 기준 ref는 레포 또는 앱의 `branch`다.
- `repos/<레포>`는 읽기·fetch에만 사용한다. 운영 ref를 임시 detached worktree로 꺼내고 SHA를 고정한다. fetch 실패·인증 필요·ref 부재를 임의로 HEAD로 대체하지 않는다. 끝나면 자신이 만든 임시 worktree만 제거한다.
- 기존 가이드의 범위·대표 화면·근거를 확인한다. 신규 가이드에는 서비스/레포/앱 경로/운영 ref/40자 SHA, 만드는 장과 대표 요청, 읽은 파일과 줄, 제외한 범위, 검증 결과와 미확인을 적는다. 외부 계약은 코드·스키마로 확인하고 비밀값은 읽거나 옮기지 않는다.

## 내용 — 세 관점 모두 필수

먼저 고정 ref의 실제 화면·주요 기능·모듈·API·저장소·외부 연동을 목록화한다. 서비스 가이드에 `항목 | 코드 파일:줄·심볼 | 관점/장·노드 또는 흐름 | 제외 사유·미확인` 대응표를 쓴다. 확인한 항목마다 위치 또는 제외 근거를 남긴다. 기능을 네 묶음으로 압축하거나 노드 수 제한 때문에 지우지 않는다. Archify의 작은 장 권장은 장을 나눌 기준이며 서비스 범위를 줄일 근거가 아니다.

1. **전체 구조·기능별 연결**: 기능/컴포넌트의 책임, 실제 데이터·호출 연결, 실행 프로세스·저장 위치·레포 경계를 보여 준다. 실제 파일·고정 SHA 근거를 연결한다. 큰 이름만 있는 개요나 근거 경로만 단 상자로 끝내지 않는다.
2. **화면에서 누르면 실제로 일어나는 흐름**: 화면 진입·누르는 동작 → 핸들러/상태 → API·IPC·브리지 요청 → 서버/저장소 → 응답/화면 표시를 기능별로 추적한다. 해당하는 캐시·인증/권한·실패·재시도·빈 결과 분기는 코드 근거와 함께 넣는다. 내부 순서를 확인하지 못하면 임의 순서를 그리지 않고 그 지점을 미확인으로 남긴다. 대표 요청 하나로 전체 기능을 확인했다고 하지 않는다. 화면이 없는 서비스는 실제 호출자·트리거부터 같은 흐름을 추적하고 가이드에 이유를 적는다.
3. **개발할 때 고칠 파일·영향 범위**: 기능 → 책임 모듈의 실제 파일·심볼 → 소비처/공유 의존성·연결 API → 검증 위치를 연결한다. 파일명 나열만으로 충족하지 않으며 근거 없는 영향 범위를 단정하지 않는다.

관련 장에는 권한 경계·데이터 저장 위치·실패 분기를 포함한다. 관측/로그 등 추가 장은 필요할 때만 만든다. 회사·레포·기능 이름을 예제에서 사실로 복사하지 않는다. 장 개수는 고정하지 않는다. 큰 서비스는 읽을 수 있는 개요에서 기능별 상세로 연결한다(`index.json`의 `extra`, Archify `meta.views` 등). 세 관점은 장 이름이나 JSON 타입이 아니라 내용 기준이다. 기본 파일 이름을 유지해도 필요한 기능별 상세를 더하고 대응표로 빠짐을 확인한다. 읽을 수 있는 크기와 의미 있는 구체성을 함께 검토한다.

## Archify와 아테나 공통 디자인

설치된 `archify/SKILL.md`·`references/delivery-contract.md`에서 생성·검증 계약을 읽는다. `A`는 그 스킬 디렉터리, `CO`는 격리 체크아웃이다. 없으면 사용자에게 설치가 필요함을 알린다. 개인 전역 스킬이나 설치본 코어는 수정하지 않는다.

디자인 정본은 코어 `scripts/diagram-theme.css`·`.mjs`이며 기존 `docs/diagrams/athena-flow-light.html`·`athena-flow-formal.html`과 같다. 서비스 그림에도 항상 적용한다. 시스템 글꼴·읽기 쉬운 크기·아테나 색 토큰·모서리·도구막대를 유지한다. topology·코드 근거는 테마 때문에 바꾸지 않는다. 테마 적용 후 글자 겹침이 생기면 근거와 내용을 보존하며 원본 배치를 고쳐 다시 생성한다. 사용자에게 디자인을 다시 고르게 하지 않는다.

선택한 타입의 schema·예제를 먼저 읽는다. architecture만 repository 근거와 `--repo-root`를 지원한다. 구조·기능/수정 영향 맵은 architecture, 시간 순서는 sequence 등 사실에 맞는 타입을 쓴다. 새 그림 기본 품질은 showcase(9개 검사·오류/경고 0)다. 기존 standard 장은 그 이유를 확인하고 보존한다.

### 원본과 최종본을 구분해 다시 생성

아래는 architecture 한 장의 예다. 다른 타입은 맞는 타입·파일명을 쓰고 지원하지 않는 `--repo-root`를 뺀다. **각 명령이 성공한 경우에만 다음 단계로 간다.** deliver 실패 시 남은 이전 HTML에 테마·visual-check를 실행하거나 새 결과로 등록하지 않는다. 원본/최종 HTML·영수증은 서로 다른 경로를 쓴다.

```bash
# 셸 스크립트로 실행할 때 실패 후 다음 단계가 실행되지 않게 한다.
set -e
node "$A/bin/archify.mjs" doctor
node "$A/bin/archify.mjs" validate architecture pack/diagrams/<서비스>.architecture.json --repo-root "$CO" --quality showcase --json
# 성공한 deliver 영수증은 <서비스>.deliver.json으로 별도 보관한다.
node "$A/bin/archify.mjs" deliver architecture pack/diagrams/<서비스>.architecture.json pack/diagrams/<서비스>.archify.html --repo-root "$CO" --quality showcase --json > pack/diagrams/<서비스>.deliver.json
node scripts/diagram-theme.mjs --output pack/diagrams/<서비스>.html pack/diagrams/<서비스>.archify.html
node scripts/diagram-theme.mjs --check --receipt pack/diagrams/<서비스>.html
node "$A/bin/archify.mjs" visual-check pack/diagrams/<서비스>.html --json
```

`--output`은 원본을 수정하지 않고 최종 HTML과 `<최종.html>.theme.json`을 만든다. 테마 영수증에는 원본 경로·SHA/바이트, 최종 SHA/바이트, CSS SHA/바이트가 있다. 이는 변환 이력이며 Archify deliver 합격이나 최종본의 레이아웃 합격을 주장하지 않는다. 원본 deliver 영수증의 artifact SHA가 테마 영수증의 source SHA와 일치하는지 확인한다. `--check --receipt`는 현재 원본·최종본·CSS 및 변환 결과를 다시 대조한다. 원본과 최종본은 함께 보관한다. 원본을 덮어쓰는 기존 제자리 적용은 코어의 옛 그림 유지용이며 서비스 전달 절차로 사용하지 않는다.

최종 HTML이 바뀌면 스크립트는 그 파일의 이전 Archify visual-check JSON·접촉 시트·네 캡처를 제거한다. 성공한 재생성 뒤에는 반드시 최종본에서 visual-check를 다시 실행한다. 기존 서비스의 첫 전환도 JSON에서 새 원본을 deliver한 뒤 위 절차를 따른다. 과거 영수증을 최종본 영수증으로 이름만 바꾸거나 과거 캡처를 재사용하지 않는다.

### 최종 디자인 확인·보고

원본 `deliver` 영수증, 테마 변환 영수증, **최종본** `visual-check` 브라우저 측정, 실제 스크린샷을 본 시각 검토를 구분한다. 최종본의 SHA/바이트와 visual-check 영수증의 artifact가 같은지 확인한다. 자동 브라우저 증거의 passed/failed/skipped는 최신 명령의 종료 코드와 receipt에서만 정하며 시각 검토로 덮어쓰지 않는다.

최종본을 1440×900·1600×1000·1920×1080·2048×1320에서 측정하고, 작은/큰 데스크톱의 밝음/어두움 캡처 네 장을 실제로 본다. 글자/상자 잘림·선/라벨 겹침·과도한 빈 공간·읽기 쉬운 크기·공통 도구막대를 확인한다. 확대·검색·포커스/닫기·내보내기는 실제 브라우저에서 확인한 범위만 기록한다. 실패하면 수정 후 같은 절차를 다시 실행한다. 외부 리소스/인증/브라우저 불가이면 미확인을 남긴다.

가이드·계획서에는 세 관점 대응표, 고정 ref, 원본 deliver 결과·SHA, 테마 최종 SHA, 브라우저 증거, 시각 검토 상태·확인 범위, 남은 미확인을 기록한다. 구조 검증·시각 검토 통과가 기능 전수의 코드 대조를 대신하지 않는다.

## 점검·목록

일반 서비스 점검은 `node scripts/check-diagrams.mjs --strict --design`을 사용한다. `--design`은 장별 최종 HTML의 현재 테마·원본/최종 변환 영수증과 현재 SHA에 묶인 visual-check pass를 확인한다. 실패·skipped·영수증 없음·stale 증거는 확인 필요다. 원본 deliver 합격·시각 검토·내용 전수 확인은 별도이며 이 점검으로 승인하지 않는다. 기존 근거 전용 점검은 `--design` 없이 유지한다.

`node scripts/check-diagrams.mjs --strict`는 현재 팩의 타입별 JSON을 찾아 architecture의 고정 커밋·근거 파일/줄·현재 운영 ref를 확인한다. 그림의 `<레포>/<앱>` 서비스 경로로 운영 branch를 한 번 정하고 공용 코드 근거에도 같은 branch를 적용한다. 기존 서비스 ID는 유일한 앱 폴더 근거로 앱을 좁히며 여러 앱이 섞여 대상이 불명확하면 서비스 경로 지정을 요구한다. 관련 파일 전체 비교이므로 변경이 있으면 보수적으로 재대조를 요구한다. 커밋만 뒤처져도 자동 repin하지 않는다. 코드 의미·화면 전수·Archify 레이아웃 검증을 대체하지 않는다. sequence 등 자동 근거 미지원 타입은 가이드의 코드 대조가 필요하다. 읽지 못한 JSON·기준 ref·근거는 성공으로 처리하지 않는다.

카드는 기존 `index.json` 형식을 따른다:

```json
{"groups":[{"title":"서비스","items":[{"base":"sample","name":"표본 서비스","sub":"sample","desc":"확인한 설명","extra":[{"file":"sample.detail.html","label":"상세"}]}]}]}
```

기본 링크는 `<base>.html`, `<base>.domains.html`, `<base>.sequence.html`이며 실제 파일이 있는 링크만 나온다. 선택한 서비스가 없으면 해당 카드는 숨긴다. 새로 만든 장을 등록한 뒤:

```bash
node scripts/build-diagram-index.mjs
bin/athena pack link
```

목록은 팩 원본 파일을 읽어 본체 `docs/diagrams/index.html`에 생성하고 팩 그림으로 상대 링크를 건다. 기존 우측 상단 메뉴와 `/guide 그림`은 이 파일을 그대로 연다. 스킬은 `.claude/skills/diagram/SKILL.md`, Codex는 `.agents/skills` 링크를 통해 같은 파일을 읽는다. 스킬을 추가한 뒤 이미 열린 에이전트 세션은 다시 시작해야 탐색 목록이 갱신될 수 있다.

새 단일 레포의 서비스 ID는 `<레포>`, 새 모노레포 앱은 `<레포>/<앱>`이다. 예를 들어 `one/web`과 `two/web`은 서로 다른 폴더의 JSON·HTML·가이드와 카드 base를 사용한다. 기존 팩의 서비스 ID·파일은 그대로 재사용하며 동명 앱이 추가되면 레포까지 지정해 구분한다.
