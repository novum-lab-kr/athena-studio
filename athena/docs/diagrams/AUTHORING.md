# 서비스 그림 작성

`/diagram`(Claude)·`$diagram`(Codex)의 서비스 그림은 현재 팩의 `pack/diagrams/`가 정본이다. 아테나 자체 작업 흐름은 코어 `docs/diagrams/`에 그대로 둔다. QA 문서·실행기와 독립된 경로다.

## 서비스·근거

- 기존 `pack/diagrams/SERVICES.md`, `guides/<서비스>.md`, `index.json`을 재사용한다. 새 팩은 init 뼈대에서 표·카드를 만든다. 기존 팩에 없으면 `pack.json`의 레포·모노레포 앱과 실제 코드를 읽어 필요한 항목만 만든다. 기준 ref는 레포 또는 앱의 `branch`다.
- `repos/<레포>`는 읽기·fetch에만 사용한다. 운영 ref를 임시 detached worktree로 꺼내고 SHA를 고정한다. fetch 실패·인증 필요·ref 부재를 임의로 HEAD로 대체하지 않는다. 끝나면 자신이 만든 임시 worktree만 제거한다.
- 기존 가이드의 범위·대표 화면·근거를 확인한다. 신규 가이드에는 서비스/레포/앱 경로/운영 ref/40자 SHA, 만드는 장과 대표 요청, 읽은 파일과 줄, 제외한 범위, 검증 결과와 미확인을 적는다. 외부 계약은 코드·스키마로 확인하고 비밀값은 읽거나 옮기지 않는다.

## Archify

설치된 `archify/SKILL.md`가 생성·검증 계약의 정본이다. `A`는 그 스킬 디렉터리, `CO`는 격리 체크아웃이다. 없으면 사용자에게 설치가 필요함을 알린다. 개인 전역 스킬이나 설치본 코어는 수정하지 않는다.

```bash
node "$A/bin/archify.mjs" doctor
node "$A/bin/archify.mjs" validate architecture pack/diagrams/<서비스>.architecture.json --repo-root "$CO" --quality showcase --json
node "$A/bin/archify.mjs" deliver architecture pack/diagrams/<서비스>.architecture.json pack/diagrams/<서비스>.html --repo-root "$CO" --quality showcase --json
node "$A/bin/archify.mjs" visual-check pack/diagrams/<서비스>.html --json
```

선택한 타입의 schema·예제를 먼저 읽는다. architecture만 repository 근거와 `--repo-root`를 지원한다. 화면 맵은 architecture로, 요청 흐름은 sequence로 만든다. 새 그림의 기본 품질은 showcase(9개 검사·오류/경고 0)다. 기존 standard 장은 그 이유를 확인하고 보존한다. 검증 실패 때 이전 HTML이 남을 수 있으므로 성공으로 표시하거나 목록에 새로 등록하지 않는다.

서비스 HTML은 Archify가 전달한 정확한 바이트를 유지한다. 서비스 결과에 코어 `diagram-theme.mjs`를 덧씌우면 전달 영수증과 브라우저 증거가 달라지므로 사용하지 않는다. 기존 아테나 사용법 그림의 테마는 유지한다. 한국어 본문을 쓰되 현재 Archify의 고정 Viewer UI와 html lang은 영어로 대체됨을 보고한다.

`deliver` 영수증, `visual-check` 브라우저 측정, 실제 스크린샷을 본 시각 검토는 별개다. 스킬의 delivery 계약에 따라 각 결과를 가이드·계획서에 기록한다. 외부 리소스/인증/브라우저 불가이면 해당 미확인을 사실대로 남긴다.

## 점검·목록

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
