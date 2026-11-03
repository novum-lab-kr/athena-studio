# 다이어그램

현재 팩 서비스 그림은 `/diagram`(Claude)·`$diagram`(Codex)으로 생성·점검한다. 절차는 [AUTHORING.md](AUTHORING.md), 서비스·가이드·카드는 `pack/diagrams/`에 둔다. 기존 우측 상단 다이어그램 메뉴와 `/guide 그림`은 `docs/diagrams/index.html`을 연다.

서비스 그림은 전체 구조·기능 연결, 사용자 동작의 실제 처리 흐름, 수정 파일·영향 범위 세 관점을 모두 담는다. 기능 목록과 그림 대응표·기능별 상세는 [AUTHORING.md](AUTHORING.md)를 따른다. 서비스와 아테나 자체 그림 모두 같은 공통 디자인을 사용한다.

아테나 자체 작업 흐름 그림(경량 · 정식 · 대화 압축 전후)은 이 폴더에 유지한다. 아래는 이 기존 그림의 재생성 절차다. 서비스는 원본 deliver와 테마 최종본·영수증을 분리하는 AUTHORING 절차를 사용한다.

## 다시 만들기

[Archify](https://github.com/tt-a1i/archify) 스킬로 만들었다. 레포에 포함하지 않았으므로 필요할 때 받아서 쓴다.

```bash
set -e
# 전역 설치 (에이전트가 직접 다이어그램을 만들게 하려면)
npx skills add tt-a1i/archify -g

# 또는 한 번만 쓰고 말 때
git clone --depth 1 https://github.com/tt-a1i/archify.git /tmp/archify
A=/tmp/archify/archify

# 작업 흐름 (workflow) 두 장 — standard 품질로 만든다. "작업·커밋" 노드에 선이 6개 몰려
# showcase(선 간격·화살촉 거리 같은 모양새 기준)는 통과하지 못한다.
for k in flow-light flow-formal compact; do
  node $A/bin/archify.mjs validate workflow docs/diagrams/athena-$k.workflow.json --quality standard --json
  node $A/bin/archify.mjs deliver  workflow docs/diagrams/athena-$k.workflow.json docs/diagrams/athena-$k.html --quality standard --json
  node scripts/diagram-theme.mjs docs/diagrams/athena-$k.html   # 앞선 deliver 성공 뒤에만
  node "$A/bin/archify.mjs" visual-check docs/diagrams/athena-$k.html --json
done

```

**테마**: archify 결과에 `scripts/diagram-theme.css` 를 덧씌운다(`scripts/diagram-theme.mjs` — Athena Studio 앱 디자인: 고정폭 대신 시스템 글꼴 · 앱 색 토큰(`src/renderer/style.css` `:root`) · 조금 큰 글자 · 둥근 상자). archify 의 배치 · 확대 · 검색 · 내보내기는 그대로이고, 여러 번 입혀도 같다. 다시 deliver 하면 테마가 빠지니 deliver 할 때마다 입힌다. 아래 코어의 제자리 적용 결과는 원본 deliver 영수증과 바이트가 다르다. 최종 HTML에서 visual-check와 시각 검토를 다시 하고 결과를 구분해 기록한다

서비스 그림을 더하면 `pack/diagrams/index.json`에 카드를 등록하고 `node scripts/build-diagram-index.mjs`를 실행한다. 파일이 있는 서비스 링크와 기존 작업 흐름 카드가 함께 나온다.

**`validate` 가 9개 검사를 모두 통과해야 showcase 합격이다.** 4개만 나오면 기본 검증이지 합격이 아니다. `deliver` 가 0 이 아닌 종료 코드를 내면 실패이며, 이전 HTML 이 그대로 남는다.

### workflow 에서 걸렸던 것

- **`col` 은 0–5 다.** 7단계를 그리려면 열을 합치거나 레인을 나눠야 한다
- `mainPath` 의 이웃 쌍은 **실제 엣지가 있어야 한다**. 중간 노드를 빼먹으면 `layout/constraint` 로 걸린다
- 서로 무관한 엣지가 같은 세로 통로를 지나면 `composition/ambiguous-corridor` 가 난다. 좌표를 손대기 전에 **노드를 다른 열로 옮기는 쪽이 낫다**
- 팝업(Semantic Passport)이 받는 값은 `kind`·`sublabel`·`tag`·`레인 › 그룹 › 페이즈` 넷뿐이다. 자유 텍스트 필드가 없다
