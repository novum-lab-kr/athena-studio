# 다이어그램

현재 팩 서비스 그림은 `/diagram`(Claude)·`$diagram`(Codex)으로 생성·점검한다. 절차는 [AUTHORING.md](AUTHORING.md), 서비스·가이드·카드는 `pack/diagrams/`에 둔다. 앱 탭 줄의 🗺 다이어그램 버튼이 `docs/diagrams/index.html`(한국어)을 연다 — 보기 → 언어가 영어 · 일본어 · 중국어면 `index.<en|ja|zh>.html` 을 연다.

서비스 그림은 서비스마다 '한눈에 보기' 1장과 핵심 기능 흐름 2~3장이다. 코드 위치·수정 영향은 상자를 누르면 뜨는 자세히 칸에 넣는다. 기능 목록과 장·상자 대응표·핵심 흐름 고르는 기준은 [AUTHORING.md](AUTHORING.md)를 따른다. 서비스와 아테나 자체 그림 모두 같은 공통 디자인을 사용한다.

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

# 작업 흐름 (workflow) 두 장(경량 · 정식 갈래를 한 장에 담은 athena-flow · 대화 압축 전후 athena-compact) — standard 품질로 만든다.
for k in flow compact; do
  node $A/bin/archify.mjs validate workflow docs/diagrams/athena-$k.workflow.json --quality standard --json
  node $A/bin/archify.mjs deliver  workflow docs/diagrams/athena-$k.workflow.json docs/diagrams/athena-$k.html --quality standard --json
  node scripts/diagram-theme.mjs docs/diagrams/athena-$k.html   # 앞선 deliver 성공 뒤에만
  node "$A/bin/archify.mjs" visual-check docs/diagrams/athena-$k.html --json   # 그림 아래 카드 때문에 세로로 넘쳐 늘 1 로 끝난다
  node scripts/diagram-visual-judge.mjs docs/diagrams/athena-$k.html          # 세로 스크롤만 허용 — 가로 넘침 · 겹침은 실패
done

```

**테마**: archify 결과에 `scripts/diagram-theme.css` 를 덧씌운다(`scripts/diagram-theme.mjs` — Athena Studio 앱 디자인: 고정폭 대신 시스템 글꼴 · 앱 색 토큰(`src/renderer/style.css` `:root`) · 조금 큰 글자 · 둥근 상자). archify 의 배치 · 확대 · 검색 · 내보내기는 그대로이고, 여러 번 입혀도 같다. 다시 deliver 하면 테마가 빠지니 deliver 할 때마다 입힌다. 아래 코어의 제자리 적용 결과는 원본 deliver 영수증과 바이트가 다르다. 최종 HTML에서 visual-check와 시각 검토를 다시 하고 결과를 구분해 기록한다

서비스 그림을 더하면 `pack/diagrams/index.json`에 카드를 등록하고 `node scripts/build-diagram-index.mjs`를 실행한다. 파일이 있는 서비스 링크와 아테나 작업 흐름 카드(이 폴더에 파일이 있는 것)가 함께 나온다. 목록은 이 스크립트로만 다시 만든다 — `index.html` 에 카드를 손으로 늘리지 않는다. 언어마다 `index.html`(한국어) · `index.<en|ja|zh>.html` 을 함께 만들고, 흐름 카드는 그 언어 그림(`<base>.<언어>.html` · 없으면 한국어)으로 잇는다. 목록 문구 · 흐름 카드 설명은 스크립트의 `TEXT` 에 네 언어로 있으니 그림 내용을 바꾸면 같이 맞춘다(팩 서비스 카드는 `index.json` 그대로). 목록 화면 아래에는 만든 도구(`/diagram` · Archify)만 적고 경로 · 명령 같은 관리자 메모는 이 문서와 스크립트 머리 주석에만 둔다.

**`validate` 가 9개 검사를 모두 통과해야 showcase 합격이다.** 4개만 나오면 기본 검증이지 합격이 아니다. `deliver` 가 0 이 아닌 종료 코드를 내면 실패이며, 이전 HTML 이 그대로 남는다.

### workflow 에서 걸렸던 것

- **`col` 은 0–5 다.** 7단계를 그리려면 열을 합치거나 레인을 나눠야 한다
- `mainPath` 의 이웃 쌍은 **실제 엣지가 있어야 한다**. 중간 노드를 빼먹으면 `layout/constraint` 로 걸린다
- 서로 무관한 엣지가 같은 세로 통로를 지나면 `composition/ambiguous-corridor` 가 난다. 좌표를 손대기 전에 **노드를 다른 열로 옮기는 쪽이 낫다**
- 팝업(Semantic Passport)이 받는 값은 `kind`·`sublabel`·`tag`·`레인 › 그룹 › 페이즈` 넷뿐이다. 자유 텍스트 필드가 없다
