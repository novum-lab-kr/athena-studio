#!/usr/bin/env bash
# 등록한 서버에 들어가는 유일한 길 — 서버 에이전트 · 앱 서버 상태 칸이 쓴다(docs/setup.md "서버 하나 더하기")
#   scripts/ssh-run.sh <서버> -- <명령…>          원격 명령 — 위험 명령(재시작 · 삭제 · 설치 · 권한 …)과 판정 못 한 명령만 [작업] 확인 요청, 나머지는 바로
#   scripts/ssh-run.sh <서버> --get <원격> <로컬>  파일 받기(.env* · 키 · 인증서 파일은 받지 않는다)
#   scripts/ssh-run.sh <서버> --put <로컬> <원격>  파일 고치기 — 원격 백업 → 덮어쓰기(보호 경로만 먼저 확인 — diff · 백업 위치)
#   scripts/ssh-run.sh <서버> --status             상태 칸 읽기(고정 읽기 명령 · 묻지 않는다 — 앱 서버 상태 칸)
#   scripts/ssh-run.sh <서버> --history            지난 기록 읽기(sysstat sar 하루 파일 · 묻지 않는다 — 앱 그래프의 빈 구간)
#   scripts/ssh-run.sh --list                      등록한 서버 이름 목록
# 확인이 필요하면 요청을 열고 3 으로 끝난다. 답이 "실행" 이면 같은 명령을 ATHENA_SERVER_APPROVED=<요청 id> 를 앞에 붙여 다시 낸다.
# <서버> 는 팩 pack.json servers[] 의 name(등록한 것만) — ssh 별칭으로 바꿔 부른다. 주소 · 키는 ~/.ssh/config 에만 있다.
set -euo pipefail

# 늘 BatchMode(비밀번호를 묻지 않는다) · ConnectTimeout 10초. 명령 판정(2026-11-11 "위험한 것만 묻는다") · 승인은 scripts/lib/server_allow.py
# 시험용: ATHENA_SSH_BIN · ATHENA_SCP_BIN · ATHENA_REQUEST_BIN(bin/athena 대신 — 요청 열기 · 승인 읽기 둘 다) · ATHENA_GUARD_SERVERS ·
#   ATHENA_GUARD_USED_FILE(쓴 승인 기록 — 기본 팩 데이터 state/server-approvals-used)
# (승인은 늘 요청 bin 의 request show 로 읽는다 — 답을 환경 값으로 넣는 길은 없다)
# (에이전트 명령에 이 값들을 넣는 것은 훅 server-guard.py 가 막는다)
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SSH_BIN="${ATHENA_SSH_BIN:-ssh}"
SCP_BIN="${ATHENA_SCP_BIN:-scp}"
REQUEST_BIN="${ATHENA_REQUEST_BIN:-$ATHENA_DIR/bin/athena}"
ALLOW="$ATHENA_DIR/scripts/lib/server_allow.py"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# 이름 → 별칭(한 줄 "<이름> <별칭>")
servers() {
  if [ -n "${ATHENA_GUARD_SERVERS+x}" ]; then
    printf '%s\n' "$ATHENA_GUARD_SERVERS" | tr ',' '\n' | tr '=' ' '
    return
  fi
  python3 - "$ATHENA_DIR" <<'PY'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
for server in load(sys.argv[1]).get('servers') or []:
    if isinstance(server, dict) and server.get('name') and server.get('host'):
        print(server['name'], server['host'])
PY
}

[ $# -ge 1 ] || usage
if [ "$1" = "--list" ]; then servers | cut -d' ' -f1; exit 0; fi
NAME="$1"; shift
HOST="$(servers | awk -v name="$NAME" '$1 == name { print $2 }')"
if [ "$(printf '%s\n' "$HOST" | grep -c .)" -gt 1 ]; then
  echo "❌ 같은 이름의 서버가 둘 이상 등록돼 있다: $NAME — pack.json servers[] 를 고친다" >&2
  exit 1
fi
if [ -z "$HOST" ]; then
  echo "❌ 등록한 서버가 아니다: $NAME — bin/athena server add <ssh 별칭> 으로 먼저 등록한다(목록: scripts/ssh-run.sh --list)" >&2
  exit 1
fi
# ssh 별칭만 — 맨 앞 - 는 ssh 옵션(-oProxyCommand=… 은 이 맥에서 명령을 돌린다) · 2026-11-08 보안 검토 높음2
if ! [[ "$HOST" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$ ]]; then
  echo "❌ 등록한 서버 $NAME 의 ssh 별칭이 올바르지 않다(글자 · 숫자 · . _ - · 맨 앞 - 안 됨) — pack.json servers[] 를 고친다" >&2
  exit 1
fi
[ $# -ge 1 ] || usage

# 비밀값이 든 파일 — 받지도 고치지도 않는다. 판정은 원격 명령(cat …)과 같은 server_allow.py 하나(흔한 이름만 막는다)
is_secret_path() {
  python3 "$ALLOW" secret "$1"
}

# 승인 확인 — ATHENA_SERVER_APPROVED 가 이 키의 "실행" 답(60분 안 · 아직 안 쓴 것)이면 0. 맞으면 쓴 것으로 적는다(한 번만)
approved() {
  [ -n "${ATHENA_SERVER_APPROVED:-}" ] && python3 "$ALLOW" approved "$REQUEST_BIN" "$ATHENA_SERVER_APPROVED" "$1" "${ATHENA_GUARD_USED_FILE:-}"
}

# 확인 요청 열기 — ask <키> <제목> <본문 파일>. 같은 키로 열린 요청이 있으면 그것을 다시 쓴다. 늘 3 으로 끝난다
ask() {
  local key="$1" title="$2" body="$3" out id
  if ! out="$("$REQUEST_BIN" request open --kind decision --title "$title" --body-file "$body" \
    --option '실행 :: 이대로 실행한다' --option '취소 :: 실행하지 않는다' --key "$key" 2>&1)"; then
    echo "❌ 확인 요청을 열지 못했다 — 실행하지 않았다" >&2
    printf '%s\n' "$out" | tail -3 >&2
    exit 1
  fi
  id="$(printf '%s\n' "$out" | tail -1 | python3 -c 'import json,sys; print((json.load(sys.stdin).get("request") or {}).get("id") or "")' 2>/dev/null || true)"
  echo "⏸ 사람 확인이 필요하다 — 요청 ${id:-?} 을 열었다([작업] 탭). 실행하지 않았다." >&2
  echo "   답이 \"실행\" 이면 같은 명령 앞에 ATHENA_SERVER_APPROVED=${id:-<요청 id>} 를 붙여 다시 낸다(60분 안 · 한 번만 · 명령이 바뀌면 다시 확인)." >&2
  if [ -n "${ATHENA_SERVER_APPROVED:-}" ]; then
    echo "   (받은 ATHENA_SERVER_APPROVED 는 이 명령의 \"실행\" 답이 아니거나 60분이 지났거나 이미 한 번 썼다)" >&2
  fi
  exit 3
}

# 상태 칸 읽기 — 부하 1·5·15분 · 코어 수 · CPU 누적 tick(/proc/stat 첫 줄을 1초 사이로 두 번 — 앱이 그 차이로 CPU % 를 낸다 · 옛 코어는 앞 읽기와의 차이) · 메모리 · SWAP(free) ·
# 디스크(/ 는 바이트 · 마운트마다 — tmpfs 같은 가짜 파일 시스템 빼고) · 네트워크 누적 바이트(/proc/net/dev) · OS 이름 · 커널 · 멈춘 systemd 서비스 ·
# 도는 서비스 이름(첫 칸만 — 설명 칸은 주소가 섞일 수 있어 자른다) · 컨테이너(상태 · 이미지 · compose 프로젝트) · 켜진 컨테이너 사용량(docker stats) ·
# podman 컨테이너 · 사용량(docker 와 같은 칸) · kubectl 파드(표 출력 — 원문 json · yaml 은 env 값이 나와 안 쓴다) · supervisorctl 프로그램 ·
# pm2 앱(pm2 ls 표 — 데몬이 떠 있을 때만: pm2 는 데몬이 없으면 새로 띄우니 ~/.pm2/pm2.pid 가 있을 때만 부른다) — 읽기에 성공하면 ".ok" 줄(supervisorctl 은 줄 모양으로) ·
# CPU 를 많이 쓰는 프로세스(프로그램 이름만 — 명령줄 인자는 비밀값이 섞일 수 있어 읽지 않는다) · 있는 실행 도구(command -v — 위에서 못 읽었으면 앱이 '감지만' 으로) ·
# 켜진 시간 · 최근 1시간 에러 로그 줄 수 · 밀린 보안 업데이트 수. 칸마다 "==이름" 줄로 나눈다(앱 src/lib/server-status.mts 가 읽는다).
# 서버 상세(폰 앱 · end 앞에 더한 칸 — 옛 앱은 모르는 칸을 건너뛴다): 열린 포트(ss — 프로세스 이름 · pid 까지) · pid → 서비스(ps unit · .service 만) · CPU 모델 ·
# 도는 서비스의 설명 칸(services 칸은 이름만 그대로 — 설명은 이 칸에서만) · systemd 타이머 · 사용자 crontab(시각 + 명령 첫 낱말만 — 인자는 비밀값이 섞일 수 있어 서버에서 자른다) ·
# ufw 첫 줄 · monarx-agent(유닛이 있을 때만 상태) · Caddyfile 의 사이트 머리 · 바로 위 주석 · reverse_proxy · root 줄(줄 번호) · nginx server_name · listen · root 줄.
# 명령이 없는 서버(apt · journalctl · docker 없음)는 그 칸을 비워 둔다 — 0 과 "못 읽음" 을 가른다. 명령 전체가 server_allow check 0 이어야 한다
STATUS_COMMAND='echo ==load; cat /proc/loadavg 2>/dev/null; echo ==cpu; nproc 2>/dev/null; echo ==stat; head -1 /proc/stat 2>/dev/null; sleep 1; echo ==stat2; head -1 /proc/stat 2>/dev/null; echo ==mem; free -b 2>/dev/null; echo ==disk; df -P -B1 / 2>/dev/null; echo ==disks; df -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null; echo ==net; cat /proc/net/dev 2>/dev/null; echo ==os; grep -m1 "^PRETTY_NAME=" /etc/os-release 2>/dev/null; echo ==kernel; uname -r 2>/dev/null; echo ==failed; systemctl list-units --type=service --state=failed --no-legend --plain --no-pager 2>/dev/null; echo ==services; systemctl list-units --type=service --state=running --no-legend --plain --no-pager 2>/dev/null | cut -d" " -f1; echo ==docker; docker ps -a --format "{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}|{{.Label \"com.docker.compose.project\"}}" 2>/dev/null; echo ==stats; command -v docker >/dev/null 2>&1 && docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}" 2>/dev/null; echo ==podman; command -v podman >/dev/null 2>&1 && podman ps -a --format "{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}|{{.Label \"com.docker.compose.project\"}}" 2>/dev/null && echo .ok; echo ==podstats; command -v podman >/dev/null 2>&1 && podman stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}" 2>/dev/null; echo ==pods; command -v kubectl >/dev/null 2>&1 && kubectl get pods -A --no-headers --request-timeout=5s 2>/dev/null && echo .ok; echo ==supervisor; command -v supervisorctl >/dev/null 2>&1 && supervisorctl status 2>/dev/null; echo ==pm2; command -v pm2 >/dev/null 2>&1 && ls .pm2/pm2.pid >/dev/null 2>&1 && pm2 ls 2>/dev/null && echo .ok; echo ==top; ps -eo comm=,pcpu=,pmem= --sort=-pcpu 2>/dev/null | head -6; echo ==detect; command -v pm2 >/dev/null 2>&1 && echo pm2; command -v podman >/dev/null 2>&1 && echo podman; command -v kubectl >/dev/null 2>&1 && echo kubectl; command -v supervisorctl >/dev/null 2>&1 && echo supervisorctl; echo ==uptime; cat /proc/uptime 2>/dev/null; echo ==errors; command -v journalctl >/dev/null 2>&1 && journalctl -p err --since "1 hour ago" --no-pager -q -o cat 2>/dev/null | wc -l; echo ==updates; command -v apt >/dev/null 2>&1 && apt list --upgradable 2>/dev/null | grep -c -i security; echo ==ports; ss -ltnupH 2>/dev/null; echo ==units; ps -eo pid=,unit= 2>/dev/null | grep -F ".service"; echo ==cpumodel; lscpu 2>/dev/null | grep -m1 "^Model name:"; echo ==servicedesc; systemctl list-units --type=service --state=running --no-legend --plain --no-pager 2>/dev/null; echo ==timers; systemctl list-timers --all --no-legend --no-pager --plain 2>/dev/null; echo ==cron; crontab -l 2>/dev/null | grep -E "^[0-9*]" | tr -s " \t" "  " | cut -d" " -f1-6; crontab -l 2>/dev/null | grep -E "^@" | tr -s " \t" "  " | cut -d" " -f1-2; echo ==ufw; ufw status 2>/dev/null | head -1; echo ==monarx; systemctl list-unit-files --no-legend --no-pager monarx-agent.service 2>/dev/null && systemctl is-active monarx-agent 2>/dev/null; echo ==caddy; grep -nE "^[^[:space:]#].*\{|^[[:space:]]*reverse_proxy|^[[:space:]]*root|^#|^import" /etc/caddy/Caddyfile 2>/dev/null; echo ==nginx; command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null | grep -E "^# configuration file |^\s*(server_name|listen|root)\s"; echo ==end'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$1" in
  --)
    shift
    [ $# -ge 1 ] || usage
    # 인자가 하나면 그 글자 그대로 · 둘 이상이면 인자마다 셸 따옴표를 붙여 합친다(shlex.join — 에이전트가 붙인 따옴표가
    # "$*" 로 사라져 grep -F 'caddy[' 가 따옴표 밖 [ 로 막히던 것 · 2026-11-11). 판정 · 승인 키 · 요청 본문 · 보내는 글자가 모두 이것
    if [ $# -eq 1 ]; then
      COMMAND="$1"
    else
      COMMAND="$(python3 -c 'import shlex, sys; print(shlex.join(sys.argv[1:]))' "$@")"
    fi
    if WHY="$(python3 "$ALLOW" check "$COMMAND")"; then
      rm -rf "$TMP"; exec "$SSH_BIN" "${SSH_OPTS[@]}" -- "$HOST" "$COMMAND"
    fi
    KEY="$(python3 "$ALLOW" key "$NAME" cmd "$COMMAND")"
    if approved "$KEY"; then
      rm -rf "$TMP"; exec "$SSH_BIN" "${SSH_OPTS[@]}" -- "$HOST" "$COMMAND"
    fi
    {
      echo "서버 **$NAME** 에서 확인이 필요한 명령을 실행하려 한다 — 이유: $WHY"
      echo
      echo '```sh'
      printf '%s\n' "$COMMAND"
      echo '```'
      echo
      echo "[실행] 을 고르면 에이전트가 이 명령을 그대로 한 번 실행한다(60분 안 · 한 번 쓰면 끝 · 글자가 바뀌면 다시 묻는다)."
    } >"$TMP/body.md"
    ask "$KEY" "서버 $NAME: 명령 실행 확인" "$TMP/body.md"
    ;;
  --status)
    [ $# -eq 1 ] || usage
    # 바로 되는 읽기 명령만 — 판정이 바뀌어 확인이 필요해지면 요청을 열지 않고 실패한다(몇 분마다 도는 칸이 묻지 않게)
    if ! WHY="$(python3 "$ALLOW" check "$STATUS_COMMAND")"; then echo "❌ 상태 명령이 바로 되는 명령이 아니다: $WHY" >&2; exit 1; fi
    rm -rf "$TMP"; exec "$SSH_BIN" "${SSH_OPTS[@]}" -- "$HOST" "$STATUS_COMMAND"
    ;;
  --history)
    [ $# -eq 1 ] || usage
    # sysstat 하루 파일(/var/log/sysstat/saDD — 날짜의 '일' 두 자리) — 이 맥 날짜로 내일 ~ 8일 전(서버와 시간대가 달라도 7일을 덮게).
    # 앱이 머리 줄 날짜(S_TIME_FORMAT=ISO → YYYY-MM-DD)로 7일 안만 쓴다 · 없는 파일은 sar 가 stderr 만 낸다.
    # 시각은 sar 를 돌린 쪽 지역 시간(man sar -t) → 서버 date +%z 로 바꾼다. 상태 칸처럼 확인이 필요해지면 요청 없이 실패
    HISTORY_COMMAND="$(python3 -c 'import datetime as d
t = d.date.today()
parts = ["echo ==tz", "date +%z"]
for back in range(-1, 9):
    day = (t - d.timedelta(days=back)).strftime("%d")
    parts += ["echo ==sa", "S_TIME_FORMAT=ISO sar -u -q -r -n DEV -f /var/log/sysstat/sa" + day + " 2>/dev/null"]
print("; ".join(parts + ["echo ==end"]))')"
    if ! WHY="$(python3 "$ALLOW" check "$HISTORY_COMMAND")"; then echo "❌ 기록 명령이 바로 되는 명령이 아니다: $WHY" >&2; exit 1; fi
    rm -rf "$TMP"; exec "$SSH_BIN" "${SSH_OPTS[@]}" -- "$HOST" "$HISTORY_COMMAND"
    ;;
  --get)
    [ $# -eq 3 ] || usage
    # 파일 하나만 — scp 는 원격에서 * ? [ ] { } 를 펼친다(.env* 가 이름 검사를 지나 .env · .env.production 을 받아 온다)
    case "$2" in *[*?[\]{}]*) echo "❌ --get 은 파일 하나만 받는다 — 경로에 * ? [ ] { } 를 쓰지 않는다: $2" >&2; exit 1 ;; esac
    # 원격 셸이 풀 수 있는 글자 — $ 변수 · 백틱 · ; | & < > ( ) \ · 줄바꿈(옛 scp -O 는 원격 셸로 경로를 넘긴다)
    case "$2" in *[\$\`\;\|\&\<\>\(\)\\]*|*$'\n'*) echo "❌ --get 경로에 셸 글자(\$ · 백틱 · ; | & < > ( ) \\)를 쓰지 않는다: $2" >&2; exit 1 ;; esac
    if is_secret_path "$2"; then echo "❌ 비밀값이 들 수 있는 파일은 받지 않는다: $(basename "$2") — 있는지 · 크기만 본다(ls -l)" >&2; exit 1; fi
    rm -rf "$TMP"; exec "$SCP_BIN" -q "${SSH_OPTS[@]}" -- "$HOST:$2" "$3"
    ;;
  --put)
    [ $# -eq 3 ] || usage
    LOCAL="$2"; REMOTE="${3#\~/}"   # ~/x 는 홈 기준 상대 경로 x 로(따옴표 안의 ~ 는 펼쳐지지 않는다)
    [ -f "$LOCAL" ] || { echo "❌ 올릴 파일이 없다: $LOCAL" >&2; exit 1; }
    case "$REMOTE" in *[*?[\]{}\$\`\;\|\&\<\>\(\)\\]*|*$'\n'*) echo "❌ --put 원격 경로에 셸 글자(* ? [ ] { } \$ · 백틱 · ; | & < > ( ) \\)를 쓰지 않는다: $REMOTE" >&2; exit 1 ;; esac
    if is_secret_path "$LOCAL" || is_secret_path "$REMOTE"; then echo "❌ 비밀값이 들 수 있는 파일은 고치지 않는다: $(basename "$REMOTE") — 사람이 직접 고친다" >&2; exit 1; fi
    REL="${REMOTE#/}"   # 백업은 ~/.athena-backups/<시각>/<경로>(앞 / 를 뗀 그대로)
    QUOTED_REMOTE="$(printf '%q' "$REMOTE")"
    # 지금 원격 내용(읽기만) — 없으면 새 파일
    EXISTS=yes
    status=0
    "$SSH_BIN" "${SSH_OPTS[@]}" -- "$HOST" "if [ -e $QUOTED_REMOTE ]; then cat -- $QUOTED_REMOTE; else exit 44; fi" >"$TMP/remote" || status=$?
    if [ "$status" -eq 44 ]; then
      EXISTS=no
      : >"$TMP/remote"
    elif [ "$status" -ne 0 ]; then
      echo "❌ 원격 파일을 읽지 못했다(ssh 종료 $status) — 올리지 않았다" >&2
      exit 1
    fi
    # 보호 경로(/etc/sudoers · cron · /etc/ssh · .ssh …) · 다음에 실행되는 자리(profile.d · systemd · /usr/local/bin · 셸 rc …)만 확인 — 2026-11-11 결정 "위험한 것만 묻는다". 나머지는 백업 뒤 바로 덮어쓴다.
    # 확인 키 — 서버 · 경로 · 로컬 내용 · 원격 내용이 같을 때만 같은 승인(어느 쪽이든 바뀌면 다시 묻는다)
    SUMS="$(shasum -a 256 "$LOCAL" "$TMP/remote" | cut -d' ' -f1 | tr '\n' ' ')"
    KEY="$(python3 "$ALLOW" key "$NAME" put "$REMOTE $SUMS")"
    if PROTECTED_WHY="$(python3 "$ALLOW" protected "$REMOTE")" && ! approved "$KEY"; then
      {
        echo "서버 **$NAME** 의 보호 경로 파일을 고치려 한다: \`$REMOTE\` — $PROTECTED_WHY"
        echo
        if [ "$EXISTS" = yes ]; then
          echo "승인하면 원본을 원격 \`~/.athena-backups/<올리는 시각>/$REL\` 에 먼저 복사(cp -p)한 뒤 덮어쓴다."
        else
          echo "원격에 이 파일이 없다 — 새로 만든다(백업할 원본 없음)."
        fi
        echo
        echo '```diff'
        diff -u --label "원격 $REMOTE" --label "고친 것" "$TMP/remote" "$LOCAL" >"$TMP/diff" || true
        head -300 "$TMP/diff"
        echo '```'
        lines="$(wc -l <"$TMP/diff" | tr -d ' ')"
        if [ "$lines" -gt 300 ]; then echo; echo "(diff $lines 줄 중 300 줄만 보였다)"; fi
      } >"$TMP/body.md"
      ask "$KEY" "서버 $NAME: 파일 고치기 확인 — $(basename "$REMOTE")" "$TMP/body.md"
    fi
    STAMP="$(date +%Y%m%d-%H%M%S)"
    if [ "$EXISTS" = yes ]; then
      QUOTED_BACKUP="$(printf '%q' ".athena-backups/$STAMP/$REL")"
      "$SSH_BIN" "${SSH_OPTS[@]}" -- "$HOST" "mkdir -p \"\$(dirname $QUOTED_BACKUP)\" && cp -p $QUOTED_REMOTE $QUOTED_BACKUP" \
        || { echo "❌ 원격 백업을 만들지 못했다 — 올리지 않았다" >&2; exit 1; }
      echo "🗄  원격 백업: ~/.athena-backups/$STAMP/$REL"
    fi
    "$SCP_BIN" -q "${SSH_OPTS[@]}" -- "$LOCAL" "$HOST:$REMOTE"
    echo "✅ 올렸다: $REMOTE"
    ;;
  *) usage ;;
esac
