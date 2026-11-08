#!/usr/bin/env bash
# 서버 보호 시험 — 허용 목록(scripts/lib/server_allow.py) · 훅(scripts/hooks/server-guard.py) · scripts/ssh-run.sh. 몇 초
# 규칙(계획서 Decisions "D2 바뀜"): 허용 목록의 읽기 명령만 바로 · 나머지 명령과 모든 파일 고치기는 확인 요청 → 승인 뒤 실행
# 표: ① 허용 ② 막힘 ③ 우회(sh -c · 이어 붙이기 · 쓰기 리다이렉트 · 치환 …) ④ 훅 ⑤ ssh-run.sh(가짜 ssh · scp · 요청)
# 진짜 서버 · 진짜 요청은 부르지 않는다 — ATHENA_SSH_BIN · ATHENA_SCP_BIN · ATHENA_REQUEST_BIN(가짜 athena 가 request open · show 둘 다 답한다) · ATHENA_GUARD_SERVERS
#
# 사용: test/server-guard-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
ALLOW="$SRC/scripts/lib/server_allow.py"
HOOK="$SRC/scripts/hooks/server-guard.py"
RUN="$SRC/scripts/ssh-run.sh"
export ATHENA_GUARD_SERVERS="dukbae=dukbae-server,web=web.prod"
FAIL=0
ok() { echo "  ✔ $1"; }
no() { echo "  ✖ $1"; FAIL=1; }

allow() {   # <기대: allow|deny> <원격 명령>
  local got=deny label="${2//$'\n'/\\n}"
  python3 "$ALLOW" check "$2" >/dev/null && got=allow
  if [ "$got" = "$1" ]; then ok "[$1] $label"; else no "[$1] $label (판정 $got)"; fi
}

echo "① 허용 — 읽기 명령은 묻지 않는다"
allow allow "cat /etc/os-release"
allow allow "ls -la /var/www"
allow allow "ps -axo pid,comm | head -20"
allow allow "df -h; free -m && uptime"
allow allow "journalctl -u caddy -n 50 --no-pager"
allow allow "systemctl status caddy"
allow allow "systemctl list-units --type=service --state=running,failed --no-legend --plain --no-pager"
allow allow "docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null"
allow allow "docker logs web --tail 20 2>&1"
allow allow "docker compose ps"
allow allow "docker stats --no-stream"
allow allow "grep -n error /var/log/caddy/access.log"
allow allow "find /etc -name '*.conf' -mtime -1"
allow allow "sudo -n systemctl status caddy"
allow allow "git -C /srv/app log -5 --oneline"
allow allow "curl -s -o /dev/null -I http://localhost"
allow allow "true"
allow allow "echo ==load; cat /proc/loadavg; echo ==cpu; nproc; free -b; df -P /"
allow allow "cat .env.example"

echo "② 막힘 — 목록에 없거나 바꾸는 명령"
allow deny "rm -rf /tmp/x"
allow deny "systemctl restart caddy"
allow deny "docker rm web"
allow deny "docker compose down"
allow deny "pm2 restart all"
allow deny "kill 1"
allow deny "apt install nginx"
allow deny "reboot"
allow deny "sed -i s/a/b/ /etc/caddy/Caddyfile"
allow deny "tee /etc/x"
allow deny "curl -X POST http://localhost/api"
allow deny "curl -so /tmp/out http://localhost"
allow deny "sort -o /etc/passwd a"
allow deny "date -s now"
allow deny "hostname evil"
allow deny "ip link set eth0 down"
allow deny "git branch -D main"
allow deny "find / -name x -delete"
allow deny "find . -exec rm {} ;"
allow deny "unknown-tool --help"
echo "② 막힘 — 비밀값 · 넓게 읽기"
allow deny "cat /srv/app/.env"
allow deny "cat ~/.ssh/id_ed25519"
allow deny "head -5 /etc/ssl/private/site.key"
allow deny "cat /etc/caddy/*.conf"
allow deny "grep -r password /etc"
allow deny "cat < /srv/app/.env"

echo "③ 우회 — 이어 붙이기 · 셸 · 리다이렉트 · 치환"
allow deny "sh -c 'rm -rf /tmp/x'"
allow deny "bash -c ls"
allow deny "ls; rm -rf /tmp/x"
allow deny "ls && rm x"
allow deny "ls || rm x"
allow deny "ls | xargs rm"
allow deny "ls | sh"
allow deny "echo hi > /etc/motd"
allow deny "echo hi >> ~/.bashrc"
allow deny "ls >| f"
allow deny "ls &> f"
allow deny "cat \$(which ls)"
allow deny 'cat `id`'
allow deny "echo \$HOME"
allow deny "$(printf 'ls\nrm x')"
allow deny "ls &"
allow deny "(rm x)"
allow deny "cat <<EOF"
allow deny "diff <(ls) f"
allow deny "FOO=1 ls"
allow deny "/tmp/x"
allow deny "sudo -u root rm x"
allow deny "sudo rm x"
allow deny "ls 'unterminated"

echo "③ 우회 — 2026-11-08 보안 검토 높음1(옵션 줄임 · 묶음 · 쓰기 옵션 · 펼침 · 환경 변수)"
while IFS= read -r line; do allow deny "$line"; done <<'LIST'
sort -uo /etc/passwd a
sort --out=/etc/passwd a
sort --output /etc/passwd a
sort --compress-program=sh a
uniq - /etc/passwd
uniq a b
tree -Co /etc/x /srv
git log --output=/etc/x
git show --output=/etc/x
git log --ext-diff -p
git show --textconv HEAD
git log --out=/etc/x
git -c core.pager=sh log
git show HEAD:.env
curl --json @f http://localhost
curl --data-ascii @f http://localhost
curl --url-query @f http://localhost
curl --form-string a=b http://localhost
curl --remote-name-all --output-dir /tmp http://localhost/x
curl file:///etc/passwd
curl -s -w @/etc/x http://localhost
curl -X DELETE http://localhost
cat /srv/app/.{env,x}
cut -d= -f1 /srv/app/.en?
jq . /srv/app/.e*
column -t .env
wc -l ~/.bashrc
cat -- /srv/app/.env
grep -f/srv/app/.env x y
sudo -n sort -uo /etc/x a
sudo -n tree -o /etc/x
sudo -n jq . a
sudo -n sudo ls
systemctl show nginx
systemctl cat nginx
systemctl -H other status x
ps e
ps eww
ps axe
ps -o pid,environ
cat /proc/1/environ
cat /proc/self/environ
ip -b a
docker -H tcp://x ps
find / -fprint /tmp/x
find . -name x -fls /tmp/x
LIST
echo "① 허용 — 고친 뒤에도 그대로 되는 읽기"
allow allow "sort -rn a | uniq -c | head -5"
allow allow "ps aux"
allow allow "ps -eo pid,comm --sort=-pcpu"
allow allow "git log --oneline -n 5"
allow allow "git branch -a"
allow allow "git show HEAD --stat"
allow allow "curl -s -o /dev/null -w '%{http_code}' https://example.com"
allow allow "curl -sI http://localhost"
allow allow "tail -n 100 /var/log/syslog"
allow allow "head -20 /etc/caddy/Caddyfile"
allow allow "ip -br a"
allow allow "hostnamectl"
allow allow "sudo -n journalctl -u caddy -n 20 --no-pager"
allow allow "lsof -i :443"

run_hook() {   # <명령 글자> → 훅 종료 코드
  CMD="$1" python3 -c 'import json,os,sys; json.dump({"tool_input":{"command":os.environ["CMD"]}}, sys.stdout)' | python3 "$HOOK" >/dev/null 2>&1
  echo $?
}
hook() {   # <기대: pass|block> <명령>
  local want=0 got; [ "$1" = block ] && want=2
  got="$(run_hook "$2")"
  if [ "$got" = "$want" ]; then ok "[$1] $2"; else no "[$1] $2 (종료 코드 $got)"; fi
}
echo "④ 훅 — 등록한 서버는 ssh-run.sh 로만"
hook pass "scripts/ssh-run.sh dukbae -- systemctl status caddy"
hook pass "scripts/ssh-run.sh dukbae -- 'rm -rf /tmp/x'"
hook pass "scripts/ssh-run.sh dukbae --put ./Caddyfile /etc/caddy/Caddyfile"
hook pass "ATHENA_SERVER_APPROVED=r-1 scripts/ssh-run.sh dukbae -- 'systemctl restart caddy'"
hook pass "ssh other-host uptime"
hook pass "echo dukbae-server"
hook pass "rm -rf node_modules"
hook block "ssh dukbae-server uptime"
hook block "ssh -o BatchMode=yes dukbae-server 'rm -rf /tmp/x'"
hook block "ssh -G dukbae-server"
hook block "ssh deploy@web.prod ls"
hook block "scp ./x dukbae-server:/etc/x"
hook block "scp dukbae-server:/etc/x ./x"
hook block "rsync -a ./dist/ web.prod:/srv/app/"
hook block "sftp dukbae-server"
hook block "ls; ssh dukbae-server ls"
hook block "ATHENA_SSH_BIN=/bin/sh scripts/ssh-run.sh dukbae -- 'rm x'"
hook block "ATHENA_GUARD_REQUEST_JSON='{}' scripts/ssh-run.sh dukbae -- 'rm x'"
hook block "export ATHENA_REQUEST_BIN=/tmp/fake"
if [ "$(ATHENA_GUARD_SERVERS='' run_hook "ssh dukbae-server rm -rf /")" = 0 ]; then ok "서버가 없으면 훅은 그대로 통과"; else no "서버가 없으면 훅은 그대로 통과"; fi

echo "⑤ ssh-run.sh — 가짜 ssh · scp · 요청으로 실행 · 확인 · 승인 · 백업"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
LOG="$WORK/calls.log"
cat >"$WORK/ssh" <<'SH'
#!/usr/bin/env bash
# 가짜 ssh — 받은 원격 명령(마지막 인자)을 적고, 원격 파일 읽기면 옛 내용을 낸다
echo "ssh ${*: -1}" >>"$FAKE_LOG"
case "${*: -1}" in
  *"==load"*) printf '==load\n0.5 0.4 0.3 1/100 1\n==end\n' ;;
  *"cat -- "*) if [ -n "${FAKE_REMOTE_MISSING:-}" ]; then exit 44; fi; printf 'old line\nsame line\n' ;;
  *) echo "ran" ;;
esac
SH
cat >"$WORK/scp" <<'SH'
#!/usr/bin/env bash
echo "scp $*" >>"$FAKE_LOG"
SH
cat >"$WORK/athena" <<'SH'
#!/usr/bin/env bash
# 가짜 bin/athena request open — 받은 키 · 본문을 남기고 같은 모양으로 답한다
if [ "${1:-}" = request ] && [ "${2:-}" = show ]; then echo "${FAKE_ANSWER:-null}"; exit 0; fi
key=""; body=""
while [ $# -gt 0 ]; do case "$1" in --key) key="$2"; shift ;; --body-file) body="$2"; shift ;; esac; shift; done
echo "request $key" >>"$FAKE_LOG"
cp "$body" "$FAKE_BODY"
echo '{"ok":true,"request":{"id":"r-fake"}}'
SH
chmod +x "$WORK/ssh" "$WORK/scp" "$WORK/athena"
export ATHENA_SSH_BIN="$WORK/ssh" ATHENA_SCP_BIN="$WORK/scp" ATHENA_REQUEST_BIN="$WORK/athena" FAKE_LOG="$LOG" FAKE_BODY="$WORK/body.md"
answer_json() {   # <키> <답> <몇 분 전> → request show --json 모양
  python3 -c 'import datetime,json,sys; at=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=int(sys.argv[3]))).isoformat().replace("+00:00","Z"); print(json.dumps({"ok":True,"request":{"id":"r-fake","state":"delivered","dedupeKey":sys.argv[1],"answer":{"choice":sys.argv[2],"text":None,"by":"app","at":at}}}))' "$1" "$2" "$3"
}
expect() {   # <이름> <기대 종료 코드> <받은 종료 코드>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (종료 코드 $3 · 기대 $2)"; fi
}
has() {   # <이름> <파일> <글자>
  if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else no "$1 — '$3' 없음"; fi
}
lacks() {   # <이름> <파일> <글자>
  if grep -qF -- "$3" "$2" 2>/dev/null; then no "$1 — '$3' 있음"; else ok "$1"; fi
}

: >"$LOG"; bash "$RUN" dukbae -- 'df -h; uptime' >/dev/null 2>&1; expect "읽기 명령은 바로 실행" 0 $?
has "읽기 명령이 ssh 로 갔다" "$LOG" "ssh df -h; uptime"
lacks "읽기 명령은 요청을 열지 않는다" "$LOG" "request"

: >"$LOG"; bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1; expect "sh -c 는 확인 요청(3)" 3 $?
lacks "확인 전에는 ssh 를 부르지 않는다" "$LOG" "ssh "
has "요청 키 server-cmd" "$LOG" "request server-cmd:"
has "요청 본문에 명령 그대로" "$WORK/body.md" "sh -c rm -rf /tmp/x"
CMD_KEY="$(sed -n 's/^request //p' "$LOG" | head -1)"

: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "승인(실행 · 5분 전)이면 실행" 0 $?
has "승인된 명령이 ssh 로 갔다" "$LOG" "ssh sh -c rm -rf /tmp/x"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$CMD_KEY" 취소 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "답이 취소면 다시 확인(3)" 3 $?
: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 61)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "61분 지난 승인은 다시 확인(3)" 3 $?
: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/y' >/dev/null 2>&1
expect "글자가 바뀐 명령은 다시 확인(3)" 3 $?
lacks "다시 확인 때 ssh 를 부르지 않는다" "$LOG" "ssh sh -c"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" web -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "다른 서버에서는 같은 승인을 쓰지 못한다(3)" 3 $?

printf 'new line\nsame line\n' >"$WORK/Caddyfile"
: >"$LOG"; bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1; expect "--put 은 늘 확인(3)" 3 $?
lacks "확인 전에는 올리지 않는다" "$LOG" "scp "
lacks "확인 전에는 백업하지 않는다" "$LOG" "cp -p"
has "요청 키 server-put" "$LOG" "request server-put:"
has "확인 창에 diff — 지울 줄" "$WORK/body.md" "-old line"
has "확인 창에 diff — 더할 줄" "$WORK/body.md" "+new line"
has "확인 창에 원격 백업 위치" "$WORK/body.md" "~/.athena-backups/<올리는 시각>/etc/caddy/Caddyfile"
PUT_KEY="$(sed -n 's/^request //p' "$LOG" | head -1)"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1
expect "승인된 --put 은 올린다" 0 $?
has "백업 먼저(cp -p → ~/.athena-backups)" "$LOG" ".athena-backups/"
has "그다음 덮어쓰기(scp)" "$LOG" "dukbae-server:/etc/caddy/Caddyfile"
if [ "$(grep -n 'cp -p' "$LOG" | cut -d: -f1)" -lt "$(grep -n '^scp' "$LOG" | cut -d: -f1)" ] 2>/dev/null; then ok "백업이 덮어쓰기보다 먼저"; else no "백업이 덮어쓰기보다 먼저"; fi
printf 'newer line\n' >"$WORK/Caddyfile"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-fake FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1
expect "올릴 내용이 바뀌면 다시 확인(3)" 3 $?
lacks "내용이 바뀐 --put 은 올리지 않는다" "$LOG" "scp "
: >"$LOG"; FAKE_REMOTE_MISSING=1 bash "$RUN" dukbae --put "$WORK/Caddyfile" /srv/new.conf >/dev/null 2>&1; expect "새 파일 --put 도 확인(3)" 3 $?
has "새 파일이면 백업할 원본 없음이라고 보인다" "$WORK/body.md" "백업할 원본 없음"
printf 'x\n' >"$WORK/.env"
: >"$LOG"; bash "$RUN" dukbae --put "$WORK/.env" /srv/app/.env >/dev/null 2>&1; expect "비밀 파일 --put 은 거절(1)" 1 $?
: >"$LOG"; bash "$RUN" dukbae --get /srv/app/.env "$WORK/got" >/dev/null 2>&1; expect "비밀 파일 --get 은 거절(1)" 1 $?
lacks "거절한 --get 은 scp 를 부르지 않는다" "$LOG" "scp "
: >"$LOG"; bash "$RUN" dukbae --get /etc/caddy/Caddyfile "$WORK/got" >/dev/null 2>&1; expect "보통 파일 --get 은 받는다" 0 $?
bash "$RUN" nothere -- uptime >/dev/null 2>&1; expect "등록하지 않은 서버는 거절(1)" 1 $?
: >"$LOG"; ATHENA_GUARD_SERVERS="evil=-oProxyCommand=touch_x" bash "$RUN" evil -- uptime >/dev/null 2>&1; expect "맨 앞 - 별칭(ssh 옵션)은 거절(1)" 1 $?
lacks "거절한 별칭은 ssh 를 부르지 않는다" "$LOG" "ssh "
ATHENA_GUARD_SERVERS="two=a.one,two=b.two" bash "$RUN" two -- uptime >/dev/null 2>&1; expect "같은 이름이 둘이면 거절(1)" 1 $?
cat >"$WORK/ssh-args" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_LOG"
SH
chmod +x "$WORK/ssh-args"
ATHENA_SSH_BIN="$WORK/ssh-args" bash "$RUN" dukbae -- uptime >/dev/null 2>&1
if [ "$(grep -n -x -- '--' "$LOG" | cut -d: -f1)" = "$(( $(grep -n -x dukbae-server "$LOG" | cut -d: -f1) - 1 ))" ]; then ok "ssh 별칭 바로 앞에 --"; else no "ssh 별칭 바로 앞에 --"; fi

# 상태 칸 읽기(--status) — 고정 읽기 명령 · 요청 없이 바로
: >"$LOG"; OUT="$(bash "$RUN" dukbae --status 2>/dev/null)"; expect "--status 는 바로 실행" 0 $?
has "--status 가 상태 명령을 ssh 로 보냈다" "$LOG" "echo ==load"
lacks "--status 는 요청을 열지 않는다" "$LOG" "request"
case "$OUT" in *"==end"*) ok "--status 출력이 끝 칸까지 왔다" ;; *) no "--status 출력 — ==end 없음" ;; esac
STATUS_CMD="$(sed -n "s/^STATUS_COMMAND='\(.*\)'$/\1/p" "$RUN")"
python3 scripts/lib/server_allow.py check "$STATUS_CMD" >/dev/null 2>&1; expect "상태 명령은 허용 목록 안" 0 $?
: >"$LOG"; bash "$RUN" dukbae --status extra >/dev/null 2>&1; expect "--status 뒤 인자는 쓰임새 오류(2)" 2 $?
lacks "거절한 --status 는 ssh 를 부르지 않는다" "$LOG" "ssh "

echo
if [ "$FAIL" = 0 ]; then echo "✅ server-guard 시험 통과"; else echo "❌ server-guard 시험 실패"; fi
exit "$FAIL"
