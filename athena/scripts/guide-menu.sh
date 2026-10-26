#!/usr/bin/env bash
# 아테나 가이드 메뉴 — ↑/↓ 또는 숫자로 고르고 Enter 로 실행. q 로 종료.
# 외부 의존 없음(bash + tput + python3). Athena Studio pane 안에서 띄우면 스킬 실행 항목이
# 아래에 새 pane 을 열어 별도 아테나 세션으로 /<스킬> 을 돌린다.
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$ATHENA_DIR/scripts/lib/shell-line.sh"   # shell_line — pane run 에 넘길 셸 한 줄(띄어쓰기·한글 안전)
cd "$ATHENA_DIR"
CLAUDE_PANE="${ATHENA_CLAUDE_PANE:-}"

BOLD=$(tput bold 2>/dev/null || true); DIM=$(tput dim 2>/dev/null || true)
REV=$(tput rev 2>/dev/null || true);   RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true); YELLOW=$(tput setaf 3 2>/dev/null || true)
CYAN=$'\e[38;5;80m'; GRAY=$'\e[38;5;245m'; HL=$'\e[48;5;24m\e[38;5;231m\e[1m'   # 선택 행: 진한 파랑 배경 + 흰 글자
TITLE=$'\e[1m\e[38;5;222m'

# ---------- 동작 ----------
mouse_on()  { printf '\e[?1000h\e[?1006h'; }   # 클릭·휠 보고 (SGR 인코딩)
mouse_off() { printf '\e[?1000l\e[?1006l'; }
ITEM_ROW0=3   # draw() 에서 1번 항목이 찍히는 화면 행

pause() { printf '\n%s↩  아무 키나 누르면 메뉴로 돌아갑니다%s' "$GRAY" "$RESET"; IFS= read -rsn1 _; }
section() { # section <파일> <시작 정규식> <끝 정규식>  → 시작~끝 직전까지 출력
  awk -v s="$2" -v e="$3" '$0 ~ s {p=1} p && $0 ~ e && !($0 ~ s) {exit} p' "$1"
}
ask_claude() { # ask_claude <프롬프트>  — 기존 아테나 pane 을 건드리지 않고 **새 pane** 에 별도 Claude 세션을 띄워 실행
  # 화면 계층(scripts/screen) — 메뉴 pane 이 아니라 포커스된 pane(사용자가 보고 있는 곳) 아래를 가른다
  if "$ATHENA_DIR/scripts/screen" inside && command -v claude >/dev/null 2>&1; then
    local out new_pane
    out="$("$ATHENA_DIR/scripts/screen" pane split --target focused --direction down --ratio 0.5 --cwd "$ATHENA_DIR" --focus 2>&1)" || {
      printf '%s⚠️ pane 분할 실패:%s %s\n' "$YELLOW" "$RESET" "$out"; return 1; }
    new_pane="$(printf '%s' "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pane"]["id"])')"
    sleep 1
    "$ATHENA_DIR/scripts/screen" pane run "$new_pane" "$(shell_line claude "$1")" >/dev/null   # 셸 한 줄 — '/guide 설명' 이 낱말 둘로 쪼개지지 않게
    "$ATHENA_DIR/scripts/screen" pane rename "$new_pane" "아테나 작업" >/dev/null 2>&1 || true
    printf '%s✔ 새 pane(%s)에 아테나 세션을 띄워 실행했습니다:%s %s\n' "$GREEN" "$new_pane" "$RESET" "$1"
  else
    printf '%s%s 밖이거나 claude 명령이 없습니다. 채팅에 직접 붙여넣으세요:%s\n\n  %s\n' "$YELLOW" "$("$ATHENA_DIR/scripts/screen" name)" "$RESET" "$1"
  fi
}

# 마크다운 뷰어: glow 가 있으면 glow, 없으면 내장 렌더러(scripts/mdview.py) → less
view_md() { # view_md <파일>
  if command -v glow >/dev/null 2>&1; then glow -p "$1"
  else python3 "$ATHENA_DIR/scripts/mdview.py" "$1" | less -R; fi
}
view_md_stdin() { # 표준입력의 마크다운을 렌더해 less 로
  if command -v glow >/dev/null 2>&1; then glow -p -
  else python3 "$ATHENA_DIR/scripts/mdview.py" | less -R; fi
}

# ---------- frontmatter 읽기 ----------
list_skills() { # 출력: <디렉토리>\t<이름>\t<인자힌트>\t<설명>
  python3 - "$ATHENA_DIR" <<'PY'
import sys, os, glob
root = sys.argv[1]
def meta_of(path):
    meta = {}
    with open(path, encoding='utf-8') as fp:
        lines = fp.read().split('\n')
    if lines and lines[0].strip() == '---':
        for line in lines[1:]:
            if line.strip() == '---':
                break
            if ':' in line:
                key, val = line.split(':', 1)
                meta[key.strip()] = val.strip().strip('"').strip("'")
    return meta
for path in sorted(glob.glob(os.path.join(root, '.claude/skills/*/SKILL.md'))):
    dirname = os.path.basename(os.path.dirname(path))
    meta = meta_of(path)
    print('\t'.join([dirname, meta.get('name', dirname),
                     meta.get('argument-hint', ''), meta.get('description', '')]))
PY
}

# ---------- 각 항목의 동작 ----------
act_skills() { # 스킬 목록 → 골라서 실행하거나 SKILL.md 보기
  local dirs=() names=() hints=() descs=() dir name hint desc idx pick act args cols
  while IFS=$'\t' read -r dir name hint desc; do
    dirs+=("$dir"); names+=("$name"); hints+=("$hint"); descs+=("$desc")
  done < <(list_skills)
  if [ "${#names[@]}" -eq 0 ]; then
    printf '%s.claude/skills 에 스킬이 없습니다.%s\n' "$YELLOW" "$RESET"; pause; return
  fi
  cols=$(tput cols 2>/dev/null || echo 80); [ "$cols" -lt 40 ] && cols=80
  printf '%s번호를 고르면 실행하거나 SKILL.md 를 볼 수 있습니다. 빈 입력이면 메뉴로 돌아갑니다.%s\n\n' "$GRAY" "$RESET"
  for idx in "${!names[@]}"; do
    printf '  %s%2d%s  %s/%s%s' "$CYAN" $((idx+1)) "$RESET" "$BOLD" "${names[$idx]}" "$RESET"
    [ -n "${hints[$idx]}" ] && printf '  %s%s%s' "$GRAY" "${hints[$idx]}" "$RESET"
    printf '\n'
    [ -n "${descs[$idx]}" ] && wrap_help $((cols - 12)) "${descs[$idx]}"
    printf '\n'
  done
  printf '번호: '; read -r pick
  [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#names[@]}" ] || return
  idx=$((pick-1))
  printf '\n  %s/%s%s   %s[⏎] 새 pane 에서 실행  ·  [v] SKILL.md 보기  ·  [q] 취소%s\n선택: ' \
    "$BOLD" "${names[$idx]}" "$RESET" "$GRAY" "$RESET"
  IFS= read -rsn1 act; echo
  case "$act" in
    v|V) view_md ".claude/skills/${dirs[$idx]}/SKILL.md" ;;
    q|Q) return ;;
    "")
      if [ -n "${hints[$idx]}" ]; then
        printf '인자 %s%s%s (없으면 Enter): ' "$GRAY" "${hints[$idx]}" "$RESET"
      else
        printf '인자 (없으면 Enter): '
      fi
      read -r args
      ask_claude "/${names[$idx]}${args:+ $args}"
      pause ;;
  esac
}

act_agents() { # 에이전트 목록(.claude/agents/*.md) + AGENTS.md 라우팅 기준
  { python3 - "$ATHENA_DIR" <<'PY'
import sys, os, glob, re
root = sys.argv[1]
print('# 에이전트 · 담당 레포\n')
for path in sorted(glob.glob(os.path.join(root, '.claude/agents/*.md'))):
    body = open(path, encoding='utf-8').read()
    lines = body.split('\n')
    meta = {}
    if lines and lines[0].strip() == '---':
        for line in lines[1:]:
            if line.strip() == '---':
                break
            if ':' in line:
                key, val = line.split(':', 1)
                meta[key.strip()] = val.strip().strip('"').strip("'")
    name = meta.get('name', os.path.basename(path)[:-3])
    repo = re.search(r'^- 레포: *(.+)$', body, re.M)
    port = re.search(r'^- dev 포트: *(.+)$', body, re.M)
    head = f'**{name}**'
    if repo:
        head += f' — {repo.group(1).strip()}'          # 원문에 이미 백틱·포트가 들어 있어 그대로 쓴다
    if port and port.group(1).strip() and '포트' not in head:
        head += f' · dev 포트 {port.group(1).strip()}'
    print(f'- {head}')
    if meta.get('description'):
        print(f'  {meta["description"]}')
    print()
PY
    echo
    # 레포·라우팅은 팩(pack/ROUTING.md) — 팩이 없으면 코어 일반 원칙
    if [ -f pack/ROUTING.md ]; then cat pack/ROUTING.md; else section AGENTS.md '^### 어느 레포인지 고르기' '^---'; fi
  } | view_md_stdin
}

# 안내 HTML — 팩에 그 회사 판(pack/guide/<파일>)이 있으면 그것, 없으면 코어 판(docs/<파일>)
guide_file() { if [ -f "pack/guide/$1" ]; then echo "pack/guide/$1"; else echo "docs/$1"; fi; }
act_explained() { local f; f="$(guide_file athena-explained.html)"; "$ATHENA_DIR/scripts/screen" open-url "$f" >/dev/null && echo "브라우저에서 $f(아테나 구조 설명)을 열었습니다."; pause; }
act_onboarding() { local f; f="$(guide_file onboarding.html)"; "$ATHENA_DIR/scripts/screen" open-url "$f" >/dev/null && echo "브라우저에서 $f(시작하기 가이드)을 열었습니다."; pause; }
act_playbook()  { local f; f="$(guide_file playbook.html)"; "$ATHENA_DIR/scripts/screen" open-url "$f" >/dev/null && echo "브라우저에서 $f 을 열었습니다."; pause; }
act_diagram()   { "$ATHENA_DIR/scripts/screen" open-url docs/diagrams/index.html >/dev/null && echo "브라우저에서 다이어그램 목록을 열었습니다."; pause; }
act_extending() { view_md docs/extending.md; }

# ---------- 메뉴 ----------
# 항목: 아이콘 | 제목 | 설명 | 동작
ICONS=( "🧭" "🚀" "🌐" "🔀" "📘" "⚡" "👥" )
TITLES=(
  "아테나 구조 설명"
  "시작하기"
  "플레이북"
  "서비스 다이어그램"
  "확장 가이드"
  "스킬 목록 · 실행"
  "에이전트 · 담당 레포 · 라우팅"
)
DESCS=(
  "$(guide_file athena-explained.html)"
  "$(guide_file onboarding.html)"
  "$(guide_file playbook.html)"
  "docs/diagrams/index.html"
  "docs/extending.md"
  ".claude/skills/*"
  ".claude/agents/* · AGENTS.md"
)
HELPS=(
  "아테나가 무엇이고 어떻게 돌아가는지 한 장으로 — 요청부터 PR 까지의 흐름 · 에이전트(레포 담당은 팩) · 안전장치 · 아테나가 아는 것 · 학습 구조, 그리고 오픈소스 Hermes Agent 와 무엇이 다른지. 팩 판이 있으면 pack/guide/, 없으면 docs/ 의 athena-explained.html 을 기본 브라우저에서 연다"
  "처음 받는 팀원용 시작하기 가이드(준비물 · 설치 · 처음 써 보기 · 일감 · 학습 · 꼭 지킬 것 · 막힐 때)를 기본 브라우저에서 연다. 원본은 ONBOARDING.md"
  "플레이북 HTML(팩 판이 있으면 pack/guide/playbook.html, 없으면 docs/playbook.html)을 기본 브라우저에서 연다 — 팀 구성·라우팅·커맨드·작업 흐름·아테나가 아는 것·FAQ"
  "다이어그램 목록을 브라우저로 연다. 아테나 작업 흐름 두 장(경량 — 대부분의 작업 / 정식 — 여러 레포·결정 콘솔, 단계별 규칙이 카드에 들어 있다)과 담당 서비스를 세 각도로 본 다이어그램이 있다 — 구조 / 화면 맵 / 요청 흐름(일부 서비스는 화면 전수를 담은 심층 추가). 노드를 클릭하면 상세가 뜨고 SRC 배지가 붙은 노드는 실제 파일 경로를 가리킨다. Archify 로 만들며 원본은 docs/diagrams/*.json (브라우저)"
  "스킬·에이전트를 추가하는 방법과 같이 갱신할 문서 목록. docs/extending.md 를 마크다운 뷰어로 연다 (q 로 닫기)"
  "아테나에게 시킬 수 있는 슬래시 커맨드 목록. 이름·인자·설명을 .claude/skills 에서 그때그때 읽어오니 스킬을 추가하면 여기에도 바로 나온다. 번호를 고르면 새 pane 에 별도 아테나 세션을 띄워 실행하거나(⏎) SKILL.md 본문을 볼 수 있다(v)"
  "FE 에이전트 전원의 담당 레포·포트와 라우팅 문장을 .claude/agents 에서 읽어 보여주고, 그 아래에 AGENTS.md 의 '어느 레포인지 고르기' 기준을 붙인다. 어떤 요청이 어느 서비스인지 헷갈릴 때"
)
ACTIONS=(act_explained act_onboarding act_playbook act_diagram act_extending act_skills act_agents)
# 그룹: "시작인덱스|제목"
MENU_GROUPS=( "0|📘  문서" "5|⚡  실행 · 확인" )
sel=0; n=${#TITLES[@]}
ROW_OF=()   # ROW_OF[i] = i번 항목이 그려진 화면 행(1-based). 클릭 매핑에 사용

GROUP_AT=()   # GROUP_AT[i] = i번 항목 앞에 찍을 그룹 제목 (없으면 빈 값). 서브셸 없이 조회하기 위한 배열
for g in "${MENU_GROUPS[@]}"; do GROUP_AT[${g%%|*}]="${g#*|}"; done
wrap_help() { # wrap_help <폭> <문장> → 한글 2칸 기준으로 줄을 나눠 5칸 들여쓰기해 출력
  python3 - "$1" "$2" <<'PY'
import sys, unicodedata
width, text = int(sys.argv[1]), sys.argv[2]
def w(ch): return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
lines, cur, cur_w = [], "", 0
for word in text.split(" "):
    ww = sum(w(c) for c in word)
    if cur and cur_w + 1 + ww > width:
        lines.append(cur); cur, cur_w = word, ww
    else:
        cur = word if not cur else cur + " " + word; cur_w = ww if cur_w == 0 else cur_w + 1 + ww
if cur: lines.append(cur)
print("\n".join("     " + l for l in lines))
PY
}
cursor_hide() { printf '\e[?25l'; }
cursor_show() { printf '\e[?25h'; }

# 터미널 제목을 비운다 — 안 그러면 화면이 pane 이름 옆에 실행 중인 스크립트 경로를 붙여 보여 준다
clear_title() { printf '\033]0;\007'; }

draw() {
  clear_title
  local cols; cols=$(tput cols 2>/dev/null || echo 80); [ "$cols" -lt 30 ] && cols=80
  local wide=0; [ "$cols" -ge 70 ] && wide=1          # 넓을 때만 설명 컬럼 표시
  local rule_w=$(( cols - 4 )); [ "$rule_w" -gt 60 ] && rule_w=60
  local rule="" k; for ((k=0; k<rule_w; k++)); do rule+="─"; done
  local frame="" row=1 i num desc
  frame+=$'\n'"  ${TITLE}⚡ Athena 가이드 메뉴${RESET}"$'\n'; row=$((row+2))
  frame+="  ${GRAY}${rule}${RESET}"$'\n'; row=$((row+1))
  for i in "${!TITLES[@]}"; do
    if [ -n "${GROUP_AT[$i]:-}" ]; then
      frame+=$'\n'"  ${CYAN}${GROUP_AT[$i]}${RESET}"$'\n'; row=$((row+2))
    fi
    ROW_OF[$i]=$row
    printf -v num '%2d' $((i+1))
    desc=""   # 항목 옆에 파일 경로를 붙이지 않는다 — 제목만 보여 준다(경로는 아래 설명에 있다)
    if [ "$i" -eq "$sel" ]; then
      frame+="  ${HL} ▶ ${num}  ${ICONS[$i]} ${TITLES[$i]}${desc} ${RESET}"$'\n'
    else
      frame+="     ${num}  ${ICONS[$i]} ${TITLES[$i]}${GRAY}${desc}${RESET}"$'\n'
    fi
    row=$((row+1))
  done
  # 선택 항목 설명 패널
  frame+=$'\n'"  ${GRAY}${rule}${RESET}"$'\n'
  frame+="  ${CYAN}💬 ${TITLES[$sel]}${RESET}"$'\n'
  frame+="$(wrap_help $((cols - 12)) "${HELPS[$sel]}")"$'\n'
  if [ "$wide" = 1 ]; then
    frame+=$'\n'"  ${GRAY}🖱 클릭  ·  ↕ 방향키/휠  ·  🔢 숫자  ·  ⏎ 실행  ·  q 종료${RESET}"$'\n'
  else
    frame+=$'\n'"  ${GRAY}🖱 클릭 · ↕ · ⏎ 실행 · q 종료${RESET}"$'\n'
  fi
  # 화면을 지우지 않고 홈으로 이동해 덮어쓴 뒤, 남은 아래쪽만 지운다 → 깜빡임 없음
  frame="${frame//$'\n'/$'\e[K\n'}"   # 각 줄 끝까지 지워 이전 프레임의 긴 글자가 남지 않게
  printf '\e[H%s\e[J' "$frame"
}

row_to_index() { # row_to_index <화면행> → 항목 인덱스 (없으면 -1)
  local i
  for i in "${!ROW_OF[@]}"; do [ "${ROW_OF[$i]}" = "$1" ] && { echo "$i"; return; }; done
  echo -1
}

run_sel() { mouse_off; cursor_show; clear; printf '%s%s %s%s\n\n' "$TITLE" "${ICONS[$sel]}" "${TITLES[$sel]}" "$RESET"; "${ACTIONS[$sel]}"; clear; cursor_hide; mouse_on; }

trap 'mouse_off; cursor_show; clear; exit 0' INT TERM EXIT
clear; cursor_hide; mouse_on
while :; do
  draw
  IFS= read -rsn1 key
  if [ "$key" = $'\x1b' ]; then
    # 바이트가 나눠 들어와도(pane send-keys 등) 시퀀스 끝까지 읽는다 (bash 3.2: 정수 타임아웃만 가능)
    IFS= read -rsn1 -t 1 b1 || b1=""
    IFS= read -rsn1 -t 1 b2 || b2=""
    key=ignore
    if [ "$b1" = "[" ] && [ "$b2" = "<" ]; then
      seq=""
      while IFS= read -rsn1 -t 1 ch; do
        case "$ch" in M|m) break ;; *) seq+="$ch" ;; esac
      done
      IFS=';' read -r mb mx my <<<"$seq"
      if [ "$ch" = "M" ]; then
        case "$mb" in
          0)  idx=$(row_to_index "$my"); [ "$idx" -ge 0 ] && { sel=$idx; key=click; } ;;
          64) key=up ;;
          65) key=down ;;
        esac
      fi
    elif [ "$b1" = "[" ] || [ "$b1" = "O" ]; then
      case "$b2" in A) key=up ;; B) key=down ;; esac
    fi
  fi
  [ -n "${GUIDE_MENU_DEBUG:-}" ] && printf 'key=%q seq=%q sel=%s\n' "$key" "${seq:-}" "$sel" >> "$GUIDE_MENU_DEBUG"
  case "$key" in
    up|k)   sel=$(( (sel - 1 + n) % n )) ;;
    down|j) sel=$(( (sel + 1) % n )) ;;
    ""|click) run_sel ;;
    [1-9])  idx=$((key-1)); [ "$idx" -lt "$n" ] && { sel=$idx; run_sel; } ;;
    q|Q) exit 0 ;;
  esac
done
