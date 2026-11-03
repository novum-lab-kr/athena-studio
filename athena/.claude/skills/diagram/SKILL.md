---
name: diagram
description: 현재 Athena 팩의 서비스 구조·화면 맵·요청 흐름 그림을 운영 기준 코드로 생성하거나 점검하고 기존 다이어그램 메뉴 목록을 갱신합니다. /diagram 또는 $diagram 요청과 서비스 그림 갱신에 사용합니다.
---

# 서비스 다이어그램

Claude는 `/diagram`, Codex는 `$diagram`으로 같은 정본을 읽는다. 인자는 사용자가 쓴 텍스트를 읽고 `$ARGUMENTS`가 치환되지 않았으면 그대로 명령에 넘기지 않는다.

먼저 `docs/diagrams/AUTHORING.md`를 읽는다. 서비스는 현재 팩 `pack/diagrams/SERVICES.md`와 `pack/pack.json`의 레포·앱에서 고른다. 기준 ref는 `branch`이며 `prBase`가 아니다. 서비스 표가 없으면 팩의 레포·앱에서 확인한 목록을 만든다. 회사 이름·개수를 고정하지 않는다. 이름이 여러 서비스와 겹치면 대상을 확인한다. 인자가 없으면 현재 팩 전체이며 대상과 예상 범위를 먼저 알린다.

- **점검**: `node scripts/check-diagrams.mjs --strict`로 고정 근거·운영 ref 차이를 보고한다. 대상만 요청받았어도 도구 출력의 전체 결과와 대상 결과를 구분한다. 스펙·HTML·revision을 자동으로 고치지 않는다. Archify 검증·브라우저 확인 여부도 따로 보고한다.
- **생성·갱신**: 기존 가이드 `pack/diagrams/guides/<서비스>.md`를 읽고, 해당 운영 ref의 격리 체크아웃을 사용한다. 현재 `archify` 스킬의 SKILL.md·선택한 schema·예제를 읽고 JSON → validate → deliver → visual-check 절차를 따른다. 기본 장은 구조(`<서비스>.architecture.json` → `<서비스>.html`), 화면 맵(`.domains.architecture.json` → `.domains.html`), 대표 요청(`.sequence.json` → `.sequence.html`)이다. 화면이 없는 서비스 등에서는 가이드의 근거에 따라 필요한 장만 만든다. 기존 심층 그림은 요청에 필요할 때만 다루며 옛 번들·QA 실행 체계를 복원하지 않는다.
- 결과와 가이드는 **현재 팩 `pack/diagrams/`**에 쓴다. 본체 코어의 회사별 파일을 만들지 않는다. Archify가 없으면 설치 여부를 보고하고 멈춘다(전역 자동 설치·개인 스킬 수정 금지).
- 구조 그림은 `meta.repository`와 실제 `components[].sources`를 넣고 `--repo-root <격리 체크아웃>`으로 검증·전달한다. sequence 등은 이 옵션을 받지 않으므로 가이드에 코드 근거·고정 커밋을 기록한다. 근거를 확인할 수 없으면 그 장만 멈추고 미확인으로 남긴다.
- 검증된 HTML만 `pack/diagrams/index.json`의 카드에 등록하고 `node scripts/build-diagram-index.mjs`로 목록을 갱신한다. 필요하면 `bin/athena pack link`로 가이드·그림 링크를 맞춘다. 메뉴 목적지는 기존 `docs/diagrams/index.html`이다.

현재 프로젝트의 계획서·검증·커밋·PR 흐름을 따른다. 코드·knowledge를 그림 생성 중에 임의로 고치지 않는다. 보고에는 서비스별 고정 ref·산출물·검증·브라우저 증거·시각 검토·미확인을 구분하고 계획서에 기록한다. 실제 서비스 전체 재생성은 사용자가 요청한 범위에서만 한다.

새 단일 레포의 서비스 ID는 `<레포>`, 새 모노레포 앱은 `<레포>/<앱>`이다. 예를 들어 `one/web`과 `two/web`은 서로 다른 폴더의 JSON·HTML·가이드와 카드 base를 사용한다. 기존 팩의 서비스 ID·파일은 그대로 재사용하며 동명 앱이 추가되면 레포까지 지정해 구분한다.
