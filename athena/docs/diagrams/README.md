# 다이어그램

아테나 자체 작업 흐름 그림만 둔다(경량 · 정식 · 대화 압축 전후 — `/guide 그림`). 서비스 흐름은 그림 도구 없이 각 레포 `docs/flows/` 의 문서로 남긴다 — 형식 `docs/knowledge/common/qa-flows.md`.

## 다시 만들기

[Archify](https://github.com/tt-a1i/archify) 스킬로 만들었다. 레포에 포함하지 않았으므로 필요할 때 받아서 쓴다.

```bash
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
  node scripts/diagram-theme.mjs docs/diagrams/athena-$k.html   # 아테나 테마(한글 글꼴 · 현황판 색) — deliver 할 때마다
done

```

**테마**: archify 결과에 `scripts/diagram-theme.css` 를 덧씌운다(`scripts/diagram-theme.mjs` — 고정폭 대신 한글 본문 글꼴 · 현황판과 같은 색 · 조금 큰 글자 · 둥근 상자). archify 의 배치 · 확대 · 검색 · 내보내기는 그대로이고, 여러 번 입혀도 같다. 다시 deliver 하면 테마가 빠지니 deliver 할 때마다 입힌다

그림을 더하면 `scripts/build-diagram-index.mjs` 의 카드를 고치고 다시 돌린다.

**`validate` 가 9개 검사를 모두 통과해야 showcase 합격이다.** 4개만 나오면 기본 검증이지 합격이 아니다. `deliver` 가 0 이 아닌 종료 코드를 내면 실패이며, 이전 HTML 이 그대로 남는다.

### workflow 에서 걸렸던 것

- **`col` 은 0–5 다.** 7단계를 그리려면 열을 합치거나 레인을 나눠야 한다
- `mainPath` 의 이웃 쌍은 **실제 엣지가 있어야 한다**. 중간 노드를 빼먹으면 `layout/constraint` 로 걸린다
- 서로 무관한 엣지가 같은 세로 통로를 지나면 `composition/ambiguous-corridor` 가 난다. 좌표를 손대기 전에 **노드를 다른 열로 옮기는 쪽이 낫다**
- 팝업(Semantic Passport)이 받는 값은 `kind`·`sublabel`·`tag`·`레인 › 그룹 › 페이즈` 넷뿐이다. 자유 텍스트 필드가 없다
