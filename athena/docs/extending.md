# Athena 확장 가이드

스킬(슬래시 커맨드)과 에이전트는 파일 하나로 추가된다. 추가한 뒤에는 문서 몇 곳을 같이 손봐야 한다.

## 스킬 추가
- `.claude/skills/<이름>/SKILL.md` 하나 만들면 `/<이름>`으로 바로 뜬다
- frontmatter에 `name`, `description`, 필요하면 `argument-hint`를 둔다
- 본문에서 `$ARGUMENTS`로 인자를 받는다
- 기존 `.claude/skills/call/SKILL.md`를 복사해서 고치는 게 가장 빠르다

```yaml
---
name: 이름
description: 어떤 요청이면 이 스킬인지 한 문장
argument-hint: "인자 예시"
---
```

## 학습으로 스킬 만들기 (learn 이슈 `target: skill:<이름>`)
에이전트가 같은 절차를 반복하면 스킬 후보가 일감 [학습] 탭에 쌓인다(`AGENTS.md` 6절 "📚 배운 것"). 사용자가 [아테나에게 맡기기]를 누르면 아테나가 아래 틀로 만든다.
- 이름은 **절차의 종류**로 짓는다 — PR 번호·오류 문구·`fix-…` 같은 일회성 이름 금지. 소문자·숫자·`-`
- 먼저 **기존 스킬을 고쳐 넣을 수 있는지** 본다 — 비슷한 스킬이 있으면 새로 만들지 않고 그 스킬에 절을 더한다
- `description` 은 **첫 60자 안에 "어떤 요청이면 이 스킬"** 이 보이게(스킬 목록에서 잘려 보인다)
- 본문 순서: **언제 쓰나 → 절차 → 함정 → 확인 방법**. learn 이슈의 `## 절차`·근거를 옮기고, 계획서 번호·날짜는 넣지 않는다
- 만든 뒤 아래 "같이 갱신할 곳" 표를 고친다. 30일 넘게 안 쓰면 `scripts/learn-curator.mjs` 가 정리 후보로 올린다 — 정리하면 지우지 않고 `.claude/skills/.archive/<이름>/` 로 옮긴다

```markdown
---
name: <이름>
description: <60자 안에 언제 쓰는지> — <덧붙일 설명>
argument-hint: "<인자 예시>"
---

## 언제 쓰나
## 절차
1. …
## 함정
- …
## 확인 방법
- …
```

## 에이전트 추가
- `.claude/agents/<이름>.md` 하나 만들면 된다
- frontmatter의 `description`이 아테나가 라우팅할 때 읽는 문장이다. "어떤 요청이면 이 에이전트"를 구체적으로 적는다
- description 안에 콜론+공백(`: `)이 들어가면 YAML이 깨진다
- 담당 레포가 있으면 `tools`와 본문에 레포 절대경로·검증 명령을 적는다 (기존 `.claude/agents/*.md` 참고)
- `tools` 에는 기존 FE 에이전트와 같은 **Atlassian 읽기 전용 도구 목록**을 그대로 붙인다(Jira·Confluence 읽기 — 와일드카드 `mcp__claude_ai_Atlassian__*` 는 쓰기까지 열리므로 쓰지 않는다)

## 같이 갱신할 곳
| 파일 | 고칠 곳 |
|---|---|
| `AGENTS.md` | 담당 레포 표, 라우팅 기준 (도구 무관 공통 문서) |
| `CLAUDE.md` | 서브에이전트 표, Skills 표 |
| `README.md` | 팀 표, 사용 목록, 구조 |
| `docs/playbook.html` | 팀 구성·슬래시 커맨드·폴더 구조 섹션, 헤더의 `agents N · skills N` |

`/sync`는 레포 쪽 변화만 반영하고 athena 자체 구조 변화는 잡지 않는다. 스킬이나 에이전트를 추가했으면 아테나에게 **"방금 추가한 스킬 문서에도 반영해줘"**라고 하면 위 세 곳을 갱신한다.

## 보는 방법
- 터미널: `/guide` (오른쪽 pane에 **선택형 메뉴** — 확장 가이드도 메뉴에 있다), `/guide <파일>` (오른쪽 pane에 파일을 뷰어로), `/guide 열기` (플레이북 HTML을 브라우저로). 이 문서를 채팅에서 보려면 아테나에게 "확장 가이드 보여줘"
- 메뉴(`scripts/guide-menu.sh`): 항목을 **마우스로 클릭**하거나 ↑/↓·휠·숫자로 고르고 Enter로 실행, `q`로 종료. 7개 항목이 두 그룹으로 나뉜다
  - **📘 문서** — ① 아테나 구조 설명 ② 시작하기 ③ 플레이북 ④ 서비스 다이어그램 ⑤ 확장 가이드
  - **⚡ 실행 · 확인** — ⑥ **스킬 목록 · 실행** ⑦ 에이전트 · 담당 레포 · 라우팅
- **스킬 목록**은 `.claude/skills/*/SKILL.md`의 frontmatter(`name`·`argument-hint`·`description`)를 그때그때 읽어 만든다. 스킬을 추가하면 메뉴에 자동으로 나온다. 번호를 고르면 `⏎`로 인자를 입력해 **아래에 새 pane을 열어 별도 아테나 세션**으로 `/<스킬>`을 실행하거나(기존 Claude Code pane은 건드리지 않는다. Athena Studio pane 안에서만 동작, 아니면 프롬프트를 화면에 표시), `v`로 SKILL.md 본문을 볼 수 있다
- **에이전트 목록**도 `.claude/agents/*.md`에서 `name`·`description`·`- 레포:`를 읽어 만들고, 그 아래에 `AGENTS.md`의 "어느 레포인지 고르기" 라우팅 기준을 붙인다
- 문서 항목은 **마크다운 뷰어**로 열린다. `glow`가 설치돼 있으면 glow, 없으면 내장 렌더러 `scripts/mdview.py`(의존성 없음, 제목·목록·표·코드·굵게 서식). 특정 파일을 직접 보려면 `/guide <파일>`을 쓴다
- 스크립트 단독: `scripts/guide-pane.sh [파일]`. `.md`를 주면 뷰어로, 그 외는 less로 띄운다. 화면 pane 안이면(Athena Studio) `scripts/screen pane split`, tmux면 `split-window`, 둘 다 아니면 새 Ghostty 창으로 대체된다
- 플레이북: `docs/playbook.html` "확장하기" 절(`/guide 열기`)

## 화면 계층 (scripts/screen)
아테나 스크립트·훅·지시문은 pane·탭·workspace 를 **`scripts/screen` 으로만** 다룬다. 화면 백엔드는 **studio**(Athena Studio 자체 터미널 데몬) 하나이고, 그 밖이면 **none**(터미널 하나뿐)이다. 데몬 CLI(`athena-studio-cli`)·`ATHENA_STUDIO_*`·접속 파일을 아는 곳은 `scripts/lib/screen.py` 하나다 — 스크립트는 아래 계약만 안다.
- 입구: bash·node 는 `scripts/screen <동작>`(node 는 `scripts/lib/screen.mjs` 의 `screen()`·`screenSync()`·`screenName()`·`openUrl()`·`openUrlSync()`), 파이썬 훅은 `scripts/lib/screen.py` 를 바로 불러 쓴다(`config.mjs ↔ athena_config.py` 와 같은 짝). 결과는 납작한 JSON, 실패면 종료 코드 1 이상
- 동작(`scripts/screen --help`)

  | 묶음 | 동작 |
  |---|---|
  | 지금 자리 | `self`(부른 pane — 환경에서, `--format sh` 는 eval 용 `SCREEN_*`) · `inside`(pane 안이면 0) · `pane current`(서버가 정한 지금 pane — self 와 다르다) · `capabilities [--has …]` · `name`(안내 글에 쓸 화면 이름 — `Athena Studio` · 밖이면 `Athena Studio 화면`) |
  | 보기 | `pane list`(`--tab`·`--workspace`·`--label`(이름표만)·`--cwd`·`--agent-only`·`--prefer-tab`·`--prefer-workspace`, `self` 를 값으로) · `pane get` · `pane is-shell` · `pane read`·`pane wait-output`(읽기 옵션은 데몬 CLI 에 그대로 — 출력 형식은 `--read-format`) · `tab list`·`tab get` · `workspace list`·`workspace get` |
  | 바꾸기 | `pane split --target <id\|self\|focused>` · `pane run` · `pane send-text` · `pane send-keys` · `pane rename` · `pane close` · `tab rename`·`tab close` · `workspace create` |

- **브라우저 열기도 화면 계층으로** — `scripts/screen open-url <주소|파일>`(node `openUrl()`·`openUrlSync()`). `open`·`xdg-open` 을 직접 부르지 않는다. studio 면 데몬 op `open-url` → 그 본체에 붙은 앱 창이 주소를 연다(localhost 는 옆 브라우저 · 그 밖 http(s) 는 기본 브라우저 · 결과 `{ok, target:"panel"|"external", via:"studio"}`). none·http(s) 가 아닌 것(파일)·옛 데몬(op 모름)·붙은 앱 창 없음이면 기본 브라우저(`open` → 없으면 `xdg-open` · `via` 가 그 이름)로 떨어진다 — 부르는 쪽은 이것 하나만 부른다
- **pane 이름** — 에이전트 pane 은 `🤖 <에이전트> · <브랜치>`(`delegate.sh` · `new-branch.sh`), 아테나 pane 은 계획서를 새로 만들 때 `🧭 아테나 · <제목 앞 30자>`(`new-plan.mjs` · 정식 html 을 처음 만드는 `plan-html.mjs` → `screen.mjs` `nameLeadPane()` — `ATHENA_AGENT` 가 있거나 화면 밖이면 안 함 · 실패는 조용히 · 일감 서버는 `--no-pane-name`)
- `pane run` 은 단어를 **따옴표 없이 공백으로 이어 붙인 한 줄**을 그 pane 셸에 친다. 따옴표가 필요한 명령은 실행기 파일을 만들어 그 경로 하나만 넘긴다(`delegate.sh` 방식)
- `--target self` 는 부른 pane(모르면 포커스된 pane), `focused` 는 포커스된 pane. 뒤에서 도는 스크립트는 self 를 쓴다 — 포커스된 pane 은 사용자가 보고 있는 엉뚱한 곳일 수 있다
- 출력 형식: `--format json`(기본) · `id`(첫 대상의 id 한 줄) · `ids`(한 줄에 하나). id 는 불투명한 문자열 — 쪼개 읽지 않는다(workspace 는 `workspace_id`·`tab get` 으로)
- 백엔드 고르기 — 위에서부터:
  1. `ATHENA_SCREEN=studio|none` 이 있으면 그것(회귀 검사 · 한 번만 바꿀 때 · `auto` 면 다음으로 · 그 밖의 값은 `usage`)
  2. `ATHENA_STUDIO=1`(Studio pane 안 — 데몬이 pane 셸에 넣는다) → studio
  3. 이 아테나 폴더의 `athena.config.json` `"screen"`(`studio`·`none` — **pane 밖에서만** 쓰인다). 모르는 값(옛 설정에 남은 다른 백엔드 이름 등)이면 오류 없이 다음으로(자동). `pack migrate` 는 이 고정값을 지운다
  4. Studio 데몬 접속 파일 `~/.athena-studio/daemon.json` 이 살아 있다(pid 가 살아 있고 소켓이 있다 — 낡은 파일은 없는 것으로) → studio. pane 밖(앱이 띄운 일감 · 일반 터미널)용
  5. 그 밖 → none. 바꾸는 동작이 실패하고 부르는 쪽이 원래 대체 동작(nohup · 새 창 · 직접 실행 안내)을 한다
  - pane 안인가(`inside`)는 따로 — `ATHENA_STUDIO=1` + 데몬 CLI 를 찾음
- 백엔드 기능(`capabilities`): studio 는 `agent-status` · `process-info` · `workspaces`, none 은 없음
- studio 백엔드(`StudioBackend`) — 데몬 CLI `athena-studio-cli`(계약 정본: 스튜디오 앱 `src/lib/protocol.js`)를 부른다. 출력이 이미 납작한 JSON 이라 읽기만 한다
  - CLI 찾기: `ATHENA_STUDIO_CLI`(pane 셸) → 접속 파일의 `cli` → PATH 의 `athena-studio-cli`. 접속 파일로 찾으면 `socket`·`node` 를 `ATHENA_STUDIO_SOCKET`·`ATHENA_STUDIO_NODE` 로 넘긴다(CLI 래퍼가 그 node — 앱의 Electron — 로 돈다)
  - self: `ATHENA_STUDIO_PANE_ID`·`_TAB_ID`·`_WORKSPACE_ID`(데몬에 묻지 않음). id 는 `p<n>`·`t<n>`·`w<n>`
  - 탭 밖 고정 칸(데몬 프로토콜 3 `dock` — 앱 하단 에이전트 모니터): `pane list` 에 `tab_id`·`workspace_id` 가 null 이고 이름표가 `🛰 에이전트 모니터` 인 pane 이 섞인다. 탭·workspace 로 거르면 빠지고, 이름표로 찾으면 잡힌다. 지금 앱은 모니터를 앱 화면(AGENT MONITOR 칸)으로 그리고 남은 고정 칸은 닫으므로, `monitor-pane.sh`·`athena-up.sh` 는 모니터 pane 을 띄우지 않는다. 고정 칸은 나눌 수 없다(데몬이 `usage`) — 부르는 쪽은 `--target self`·탭의 pane 을 쓴다. 화면 계층은 프로토콜 번호를 보지 않는다(같은 앱의 CLI 를 쓰므로 맞추는 건 앱 몫)
  - 실패: CLI 가 종료 1 + 표준오류 `{"error","message"}` 로 말하면 그 code(`usage`·`not_found`·`timeout`·`unavailable`·`internal`) 그대로, 종료 3(데몬에 못 붙음)은 `unavailable`, 약속 밖 출력이면 그 출력·종료 코드를 그대로 흘려보낸다
  - `pane read` 는 `--lines`·`--source visible|recent` 만(`--read-format`·`--ansi`·`--raw` 는 CLI 가 `usage` 로 거절)
- 사용자에게 보이는 안내 글에 화면 이름이 필요하면 글자를 박지 말고 `"$("$SCREEN" name) 밖입니다"`(node `screenName()`) — 지금 백엔드 이름이 들어간다
- 지킴이: `scripts/screen-lint.sh` — `scripts`·`bin`·`.claude`·`.codex` 에서 화면 계층 밖의 `ATHENA_STUDIO*`·`athena-studio-cli`·`.athena-studio/daemon.json` 을 찾으면 1. 스크립트를 고치거나 더하면 돌린다(예외 줄 표시는 없다 — 안내 글은 `name` 으로)
- 회귀 검사: `scripts/screen-check/check.sh` — 가짜 `athena-studio-cli`(로그에 `["@studio", …]` · 가짜 `nohup`·`open` 등은 `["#<이름>", …]`)로 각 스크립트가 부르는 인자·순서·출력을 golden 과 비교한다(진짜 Studio 데몬·일감은 건드리지 않는다 — 접속 파일은 `ATHENA_STUDIO_ENDPOINT` 로 막는다). 화면 밖(none) 시나리오는 `check.sh`, 화면 계층 자체는 `cli-scenarios.sh`, Studio pane 안·밖은 `studio-scenarios.sh`(`golden/studio_*.txt`). fixture 는 `fixtures/studio*/`. 화면 동작을 일부러 바꿨으면 그 시나리오만 `--record` 하고 golden 변화를 `git diff` 로 확인한다
