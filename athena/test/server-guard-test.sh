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
# 읽기만 좁게 연 것(2026-11-09) — sleep 짧게 · podman 읽기 · kubectl get 표 · supervisorctl status
allow allow "sleep 1"
allow allow "sleep 0.5"
allow allow "podman ps -a --format '{{.Names}}|{{.State}}'"
allow allow "podman stats --no-stream --format '{{.Name}}|{{.CPUPerc}}'"
allow allow "podman images"
allow allow "kubectl get pods -A --no-headers --request-timeout=5s"
allow allow "kubectl get deployments -n web -o wide"
allow allow "k3s kubectl get nodes"
allow allow "supervisorctl status"
allow allow "pm2 ls"
# 홑따옴표 안의 $ 는 원격 셸이 펼치지 않는다(2026-11-11 — 빈 줄 거르기 · curl 상태 코드가 확인 요청으로 열리던 것)
allow allow "grep -v -e '^#' -e '^\$' /etc/systemd/journald.conf"
allow allow "grep -c '\$' /etc/hosts"
allow allow "grep -F 'caddy[' /var/log/syslog"
allow allow "curl -s -o /dev/null -w '%{http_code}' http://localhost"

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
# 홑따옴표 밖의 $ 는 그대로 막힌다 — 쌍따옴표 안 · 백슬래시 뒤 · 홑따옴표 사이 · 백슬래시로 연 척한 홑따옴표 · 백틱은 홑따옴표 안도
allow deny "echo \"\$HOME\""
allow deny "echo \"'\$HOME'\""
allow deny "echo \\\$HOME"
allow deny "echo \"\\\$HOME\""
allow deny "echo '\$(id)'x\$(id)"
allow deny "echo 'a'\$'b'"
allow deny "echo \\'\$HOME'"
allow deny "echo '\`id\`'"
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
# 좁게 연 명령의 막혀야 할 꼴 — 오래 멈추기 · 쓰기 · 비밀값 · 원문(json · yaml 에 env 값)
allow deny "sleep 6"
allow deny "sleep 1m"
allow deny "sleep infinity"
allow deny "sleep 1 2"
allow deny "sudo sleep 1"
allow deny "podman exec web ls"
allow deny "podman run alpine"
allow deny "podman rm web"
allow deny "podman stats"
allow deny "podman logs web"
allow deny "podman compose ps"
allow deny "podman --remote ps"
allow deny "podman container rm web"
allow deny "sudo podman ps"
allow deny "kubectl get secrets"
allow deny "kubectl get secret db -n web"
allow deny "kubectl get configmaps"
allow deny "kubectl get cm"
allow deny "kubectl get pods,secrets"
allow deny "kubectl get pod/web"
allow deny "kubectl get pods -o yaml"
allow deny "kubectl get pods -ojson"
allow deny "kubectl get pods --output=jsonpath='{.items}'"
allow deny "kubectl get pods -o go-template='{{.}}'"
allow deny "kubectl get pods -o custom-columns=A:.spec"
allow deny "kubectl get pods -w"
allow deny "kubectl get --raw /api"
allow deny "kubectl --kubeconfig /root/x get pods"
allow deny "kubectl describe pods"
allow deny "kubectl exec web -- sh"
allow deny "kubectl delete pod web"
allow deny "k3s kubectl get secrets"
allow deny "k3s server"
allow deny "sudo kubectl get pods"
allow deny "supervisorctl start all"
allow deny "supervisorctl stop web"
allow deny "supervisorctl restart web"
allow deny "supervisorctl status web"
allow deny "supervisorctl tail web"
allow deny "supervisorctl -c /etc/x.conf status"
# sar — 저장된 기록 읽기만(-u · -q · -r · -S · -n DEV · -f /var/log/sysstat/saNN) · 쓰기(-o) · 다른 파일 · 끝없는 반복 · 다른 환경 값은 막힘
allow allow "S_TIME_FORMAT=ISO sar -u -q -r -n DEV -f /var/log/sysstat/sa08 2>/dev/null"
allow allow "sar -u -f /var/log/sysstat/sa31 -s 00:00:00 -e 12:00"
allow allow "sar -q 1 3"
allow allow "sar -S -f /var/log/sysstat/sa09"
allow deny "sar -o /tmp/sa -u 1 3"
allow deny "sar -u -f /etc/shadow"
allow deny "sar -u -f /var/log/sysstat/../../etc/shadow"
allow deny "sar -u -f /var/log/sa/sa08"
allow deny "sar -n ALL"
allow deny "sar -A"
allow deny "sar -u 1"
allow deny "sar -u 60 100"
allow deny "S_TIME_FORMAT=ISO ls"
allow deny "S_TIME_FORMAT=ISO; sar -u"
allow deny "S_TIME_FORMAT=other sar -u"
allow deny "LC_ALL=C sar -u"
allow deny "sudo S_TIME_FORMAT=ISO sar -u"
allow deny "sudo sar -u"
allow deny "pm2 jlist"
allow deny "pm2 prettylist"

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
echo "③ 우회 — 2026-11-08 PR 리뷰 2(띄어 쓴 숫자를 fd 로 보기 · 빠진 비밀 이름 · jq env)"
while IFS= read -r line; do allow deny "$line"; done <<'LIST'
date 11081200 >/dev/null
date 11081200 >&2
date 11081200 2>/dev/null
hostname 5 >/dev/null
hostname 5 >&2
hostname 5 2>&1
jq -n env
jq . /srv/app/a.json
cat /etc/ssh/ssh_host_ed25519_key
cat /etc/ssh/ssh_host_rsa_key
cat /root/.docker/config.json
cat .docker/config.json
cat /root/.kube/config
cat /srv/app/.ENV
cat /srv/app/config/secrets.yml
cat /root/.docker/./config.json
cat .docker//config.json
cat /root/.docker/x/../config.json
cat /root/.kube/./config
git show HEAD:.docker/./config.json
cat /srv/app/./.env
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
allow allow "ls /nope 2>/dev/null"
allow allow "ls /nope 2> /dev/null"
allow allow "cat /etc/os-release >/dev/null 2>&1"
allow allow "uptime 1>/dev/null"
allow allow "docker logs web --tail 20 2>&1 | tail -5"
allow allow "cat /etc/ssh/ssh_host_ed25519_key.pub"
allow allow "cat /srv/app/config.json"

# 가짜 요청 읽기 — r-q* 는 질문 요청 · r-p* 는 파일 올리기 확인 요청(key server-put:*) · r-gone 은 없는 요청 · r-err 는 읽기 실패 · 나머지는 서버 명령 확인 요청(key server-cmd:*)
GUARD_REQ="$(mktemp -d)/fake-request"
cat >"$GUARD_REQ" <<'FAKE'
#!/bin/sh
case "$3" in
  r-q*) echo '{"ok":true,"request":{"id":"'"$3"'","kind":"question","dedupeKey":"plan:plans/x.md"}}' ;;
  r-p*) echo '{"ok":true,"request":{"id":"'"$3"'","kind":"decision","dedupeKey":"server-put:def456"}}' ;;
  r-gone) echo '{"ok":false,"error":"not-found","message":"그런 요청이 없다"}'; exit 1 ;;
  r-err) echo boom >&2; exit 1 ;;
  *) echo '{"ok":true,"request":{"id":"'"$3"'","kind":"decision","dedupeKey":"server-cmd:abc123"}}' ;;
esac
FAKE
chmod +x "$GUARD_REQ"
export ATHENA_GUARD_REQUEST_BIN="$GUARD_REQ"
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
hook block "ATHENA_GUARD_USED_FILE=/tmp/x scripts/ssh-run.sh dukbae -- 'rm x'"
hook block "ssh -o x=ssh-run.sh dukbae-server uptime"
hook block "ssh dukbae-server scripts/ssh-run.sh"
hook block "bin/athena request answer r-1 --by app --choice 실행"
hook block "./bin/athena request cancel r-1 --reason x"
hook block "node scripts/athena.mjs request answer r-1 --by chat --text 실행"
hook block "ls; bin/athena  request  answer r-1 --choice 실행"
hook block 'bin/athena request "answer" r-1 --by app --choice 실행'
hook block "bin/athena request 'answer' r-1 --by app --choice 실행"
hook block 'bin/athena request an""swer r-1 --by app --choice 실행'
hook block "$(printf 'bin/athena request \\\nanswer r-1 --by app --choice 실행')"
hook block 'bin/athena request c\ancel r-1'
# R1(계획서) — 서버 명령 확인 요청(server-cmd:*)만 막고 다른 요청의 대화 답 · 취소는 그대로
hook pass "bin/athena request answer r-q1 --by chat --text 네"
hook pass "bin/athena request cancel r-q1 --reason 끝남"
hook pass "bin/athena request answer r-gone --by chat --text x"
# R1 확정(2026-11-08 사용자) — 파일 올리기 확인 요청(server-put:*)도 막는다
hook block "bin/athena request answer r-p1 --by app --choice 실행"
hook block "bin/athena request cancel r-p1 --reason x"
hook block "bin/athena request \$'\\x61nswer' r-p1 --by chat --text 실행"
hook block "bin/athena request answer r-q1 --by chat --text 네; bin/athena request answer r-p2 --by app --choice 실행"
hook block 'bin/athena request answer $ID --by chat --text 실행'
hook block "bin/athena request answer r-err --by chat --text 실행"
hook block "bin/athena request answer r-q1 --by chat --text 네; bin/athena request cancel r-2"
hook block "bin/athena request answer"
hook block 'scripts/ssh-run.sh dukbae -- ls $(ssh dukbae-server id)'
hook block 'scripts/ssh-run.sh dukbae -- ls `ssh dukbae-server id`'
hook block 'scripts/ssh-run.sh dukbae -- diff <(ssh dukbae-server cat /etc/x) f'
hook pass "bin/athena request show r-1 --json"
hook pass "bin/athena request ack r-1"
hook pass "/abs/athena/scripts/ssh-run.sh dukbae -- uptime"
echo "④ 훅 — 같은 우회를 모든 검사에(따옴표 · 백슬래시 · 백슬래시-줄바꿈 · \$' · 빈 치환 · 중괄호 — 2026-11-08 PR 세 번째 리뷰)"
# ⏎ 는 백슬래시-줄바꿈으로 바꿔 넣는다
while IFS= read -r line; do line="${line//⏎/$'\\\n'}"; hook block "$line"; done <<'LIST'
s""sh dukbae-server id
s'sh' dukbae-server id
ssh d""ukbae-server id
ssh dukbae-ser\ver id
ssh deploy@web.pro""d ls
scp ./x dukbae-ser""ver:/etc/x
rsync -a ./dist/ web.pr'o'd:/srv/app/
ssh \⏎dukbae-server id
ssh dukbae-ser\⏎ver id
scripts/ssh-run.sh dukbae -- ls $(ssh \⏎dukbae-server id)
scripts/ssh-run.sh dukbae -- ls `s""sh dukbae-server id`
ssh ${x}dukbae-server id
ssh $'dukbae-server' id
export ATHENA_SSH""_BIN=/bin/sh
ATHENA_SSH\_BIN=/bin/sh scripts/ssh-run.sh dukbae -- 'rm x'
export ATHENA_REQUEST""_BIN=/tmp/fake
export ATHENA_REQUEST\_BIN=/tmp/fake
export ATHENA_REQ'UEST_BIN'=/tmp/fake
export $'ATHENA_SCP_BIN'=/bin/sh
ATHENA_GUARD_USED""_FILE=/tmp/x scripts/ssh-run.sh dukbae -- 'rm x'
ATHENA_GUARD_SERV\⏎ERS= scripts/ssh-run.sh dukbae -- 'rm x'
bin/athena request $'answer' r-1 --by app --choice 실행
bin/athena request $"answer" r-1 --by app --choice 실행
bin/athena request ans${x}wer r-1 --by app --choice 실행
bin/athena request ans$()wer r-1 --by app --choice 실행
bin/athena request ans``wer r-1 --by app --choice 실행
bin/athena request {answer,} r-1 --by app --choice 실행
bin/athena request {ans,}wer r-1 --by app --choice 실행
bin/athena request can{c,}el r-1
{ssh,dukbae-server} id
ssh dukbae-server{,} id
ssh dukbae-ser{v,}er id
s{s,}h dukbae-server id
scp ./x {dukbae-server,x}:/etc/x
LIST
echo "④ 훅 — 치환은 빈 글자 · 공백 둘 다 · += 덮어쓰기 · \$'…' 이스케이프 풀기(2026-11-08 PR 네 번째 리뷰)"
while IFS= read -r line; do hook block "$line"; done <<'LIST'
ssh${IFS}dukbae-server id
ssh$IFS dukbae-server id
ssh$IFS'dukbae-server' id
ssh${IFS%?}dukbae-server id
ssh$(true)dukbae-server id
ssh`true`dukbae-server id
scp${IFS}./x${IFS}dukbae-server:/etc/x
bin/athena request${IFS}answer r-1 --by app --choice 실행
ATHENA_SSH_BIN+=/bin/sh scripts/ssh-run.sh dukbae -- 'rm x'
export ATHENA_SSH_BIN+=/bin/sh
env ATHENA_SCP_BIN+=/bin/sh scripts/ssh-run.sh dukbae --put a b
declare -x ATHENA_REQUEST_BIN+=/tmp/fake
ATHENA_GUARD_USED_FILE+=x scripts/ssh-run.sh dukbae -- 'rm x'
export ATHENA_SSH""_BIN+=/bin/sh
ssh $'\x64ukbae-server' id
$'\163sh' dukbae-server id
$'\x73\x73\x68' dukbae-server id
ssh $'dukbae-server' id
ssh $'\U00000064ukbae-server' id
ssh $'dukbae\x2dserver' id
export $'ATHENA_\x53SH_BIN'=/bin/sh
bin/athena request $'\x61nswer' r-1 --by app --choice 실행
LIST
echo "④ 훅 — 정규화 뒤에도 그대로 통과"
hook pass 'echo $HOME ${PATH%%:*}'
hook pass "scripts/ssh-run.sh dukbae -- 'cat \$HOME/x'"
hook pass "printf \$'a\\x62c\\n'"
hook pass "ls 2>/dev/null"
hook pass "scripts/ssh-run.sh dukbae -- 'ls /nope 2>/dev/null'"
hook pass "scripts/ssh-run.sh dukbae --status"
hook pass "scripts/ssh-run.sh dukbae -- cat /etc/ssh/ssh_host_ed25519_key.pub"
hook pass "echo 'ssh-run.sh 로 들어간다'"
hook pass 'echo "dukbae-server{,}"'
hook pass "ls {a,b}.txt"
hook pass 'git commit -m "request 답은 사람이"'
if [ "$(ATHENA_GUARD_SERVERS='' run_hook "ssh dukbae-server rm -rf /")" = 0 ]; then ok "서버가 없으면 훅은 그대로 통과"; else no "서버가 없으면 훅은 그대로 통과"; fi
if [ "$(ATHENA_GUARD_SERVERS='' run_hook "bin/athena request answer r-1 --by chat --text x")" = 0 ]; then ok "서버가 없으면 request answer 도 통과"; else no "서버가 없으면 request answer 도 통과"; fi

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
if [ "${1:-}" = request ] && [ "${2:-}" = cancel ]; then echo "cancel ${3:-}" >>"$FAKE_LOG"; exit 0; fi
key=""; body=""
while [ $# -gt 0 ]; do case "$1" in --key) key="$2"; shift ;; --body-file) body="$2"; shift ;; esac; shift; done
echo "request $key" >>"$FAKE_LOG"
cp "$body" "$FAKE_BODY"
echo '{"ok":true,"request":{"id":"r-fake"}}'
SH
chmod +x "$WORK/ssh" "$WORK/scp" "$WORK/athena"
export ATHENA_SSH_BIN="$WORK/ssh" ATHENA_SCP_BIN="$WORK/scp" ATHENA_REQUEST_BIN="$WORK/athena" FAKE_LOG="$LOG" FAKE_BODY="$WORK/body.md" ATHENA_GUARD_USED_FILE="$WORK/used"
answer_json() {   # <키> <답> <몇 분 전> [상태 — 기본 delivered] → request show --json 모양
  python3 -c 'import datetime,json,sys; at=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=int(sys.argv[3]))).isoformat().replace("+00:00","Z"); print(json.dumps({"ok":True,"request":{"id":"r-fake","state":sys.argv[4],"dedupeKey":sys.argv[1],"answer":{"choice":sys.argv[2],"text":None,"by":"app","at":at}}}))' "$1" "$2" "$3" "${4:-delivered}"
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

# 여러 인자 — 인자마다 셸 따옴표를 붙여 합친다("$*" 로 따옴표가 사라져 읽기 명령도 확인 요청이 열리던 것 · 2026-11-11)
: >"$LOG"; bash "$RUN" dukbae -- grep -F 'caddy[' /var/log/syslog >/dev/null 2>&1; expect "여러 인자 grep -F 'caddy[' 는 바로 실행" 0 $?
has "여러 인자 — 따옴표를 붙여 보냈다" "$LOG" "ssh grep -F 'caddy[' /var/log/syslog"
lacks "여러 인자 읽기 명령은 요청을 열지 않는다" "$LOG" "request"
: >"$LOG"; bash "$RUN" dukbae -- curl -s -o /dev/null -w '%{http_code}' http://localhost >/dev/null 2>&1; expect "여러 인자 curl -w '%{http_code}' 는 바로 실행" 0 $?
has "여러 인자 curl — 따옴표를 붙여 보냈다" "$LOG" "ssh curl -s -o /dev/null -w '%{http_code}' http://localhost"
: >"$LOG"; bash "$RUN" dukbae -- grep -v -e '^#' -e '^$' /etc/systemd/journald.conf >/dev/null 2>&1; expect "여러 인자 grep -e '^\$' 는 바로 실행" 0 $?
: >"$LOG"; bash "$RUN" dukbae -- cat 'a b.txt' >/dev/null 2>&1; expect "공백 든 인자도 바로 실행" 0 $?
has "공백 든 인자는 한 낱말로 보냈다" "$LOG" "ssh cat 'a b.txt'"
: >"$LOG"; bash "$RUN" dukbae -- echo '$HOME' x >/dev/null 2>&1; expect "여러 인자 '\$HOME' 은 홑따옴표로 보내 바로 실행" 0 $?
has "여러 인자 '\$HOME' — 홑따옴표째 보냈다" "$LOG" "ssh echo '\$HOME' x"
: >"$LOG"; bash "$RUN" dukbae -- cat a ';' rm b >/dev/null 2>&1; expect "여러 인자의 ';' 는 판정이 구분자로 보고 확인 요청(3 — 안전한 쪽)" 3 $?
has "여러 인자의 ';' — 요청 본문에 따옴표째" "$WORK/body.md" "cat a ';' rm b"
lacks "여러 인자의 ';' — 확인 전에는 ssh 를 부르지 않는다" "$LOG" "ssh "
: >"$LOG"; bash "$RUN" dukbae -- "grep -F 'caddy[' /var/log/syslog" >/dev/null 2>&1; expect "인자 하나는 그 글자 그대로(바로 실행)" 0 $?
has "인자 하나 — 글자 그대로 보냈다" "$LOG" "ssh grep -F 'caddy[' /var/log/syslog"

: >"$LOG"; bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1; expect "sh -c 는 확인 요청(3)" 3 $?
lacks "확인 전에는 ssh 를 부르지 않는다" "$LOG" "ssh "
has "요청 키 server-cmd" "$LOG" "request server-cmd:"
has "요청 본문에 보내는 글자 그대로(따옴표 포함)" "$WORK/body.md" "sh -c 'rm -rf /tmp/x'"
CMD_KEY="$(sed -n 's/^request //p' "$LOG" | head -1)"
if [ "$CMD_KEY" = "$(python3 "$ALLOW" key dukbae cmd "sh -c 'rm -rf /tmp/x'")" ]; then ok "승인 키도 보내는 글자(따옴표 포함)로"; else no "승인 키도 보내는 글자(따옴표 포함)로"; fi

: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd1 FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "승인(실행 · 5분 전)이면 실행" 0 $?
has "승인된 명령이 ssh 로 갔다(따옴표 포함)" "$LOG" "ssh sh -c 'rm -rf /tmp/x'"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd1 FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "같은 승인은 두 번 쓰지 못한다(3)" 3 $?
lacks "두 번째는 ssh 를 부르지 않는다" "$LOG" "ssh sh -c"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd9 FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5 answered)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "answered 승인도 실행" 0 $?
has "쓴 승인(answered)은 요청을 닫는다(cancel)" "$LOG" "cancel r-cmd9"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd2 FAKE_ANSWER="$(answer_json "$CMD_KEY" 취소 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "답이 취소면 다시 확인(3)" 3 $?
: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd3 FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 61)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
expect "61분 지난 승인은 다시 확인(3)" 3 $?
: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd4 FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/y' >/dev/null 2>&1
expect "글자가 바뀐 명령은 다시 확인(3)" 3 $?
lacks "다시 확인 때 ssh 를 부르지 않는다" "$LOG" "ssh sh -c"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-cmd5 FAKE_ANSWER="$(answer_json "$CMD_KEY" 실행 5)" bash "$RUN" web -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1
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
: >"$LOG"; ATHENA_SERVER_APPROVED=r-put1 FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1
expect "승인된 --put 은 올린다" 0 $?
has "백업 먼저(cp -p → ~/.athena-backups)" "$LOG" ".athena-backups/"
has "그다음 덮어쓰기(scp)" "$LOG" "dukbae-server:/etc/caddy/Caddyfile"
if [ "$(grep -n 'cp -p' "$LOG" | cut -d: -f1)" -lt "$(grep -n '^scp' "$LOG" | cut -d: -f1)" ] 2>/dev/null; then ok "백업이 덮어쓰기보다 먼저"; else no "백업이 덮어쓰기보다 먼저"; fi
: >"$LOG"; ATHENA_SERVER_APPROVED=r-put1 FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1
expect "같은 --put 승인은 두 번 쓰지 못한다(3)" 3 $?
lacks "두 번째 --put 은 올리지 않는다" "$LOG" "scp "
printf 'newer line\n' >"$WORK/Caddyfile"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-put2 FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1
expect "올릴 내용이 바뀌면 다시 확인(3)" 3 $?
lacks "내용이 바뀐 --put 은 올리지 않는다" "$LOG" "scp "
: >"$LOG"; FAKE_REMOTE_MISSING=1 bash "$RUN" dukbae --put "$WORK/Caddyfile" /srv/new.conf >/dev/null 2>&1; expect "새 파일 --put 도 확인(3)" 3 $?
has "새 파일이면 백업할 원본 없음이라고 보인다" "$WORK/body.md" "백업할 원본 없음"
printf 'x\n' >"$WORK/.env"
: >"$LOG"; bash "$RUN" dukbae --put "$WORK/.env" /srv/app/.env >/dev/null 2>&1; expect "비밀 파일 --put 은 거절(1)" 1 $?
: >"$LOG"; bash "$RUN" dukbae --get /srv/app/.env "$WORK/got" >/dev/null 2>&1; expect "비밀 파일 --get 은 거절(1)" 1 $?
lacks "거절한 --get 은 scp 를 부르지 않는다" "$LOG" "scp "
: >"$LOG"; bash "$RUN" dukbae --get '/srv/app/.env*' "$WORK/got" >/dev/null 2>&1; expect "glob 든 --get(.env*) 은 거절(1)" 1 $?
for pattern in '/srv/app/*.conf' '/srv/app/a?' '/srv/app/[ab]' '/srv/app/{a,b}'; do bash "$RUN" dukbae --get "$pattern" "$WORK/got" >/dev/null 2>&1; expect "glob 든 --get 거절: $pattern" 1 $?; done
lacks "glob 든 --get 은 scp 를 부르지 않는다" "$LOG" "scp "
: >"$LOG"
for remote in /root/.docker/./config.json /root/.docker//config.json /root/.kube/./config /srv/app/config/secrets.yml /proc/1/environ /srv/app/.ENV /etc/ssh/ssh_host_ed25519_key /root/.docker/config.json /root/.kube/config '/srv/$HOME/x' '/srv/`id`/x' '/srv/a;b'; do bash "$RUN" dukbae --get "$remote" "$WORK/got" >/dev/null 2>&1; expect "--get 거절: $remote" 1 $?; done
lacks "거절한 --get(비밀 이름 · \$ · 백틱) 은 scp 를 부르지 않는다" "$LOG" "scp "
printf 'x\n' >"$WORK/plain.txt"
for remote in /etc/ssh/ssh_host_ed25519_key /srv/app/secrets.yml /srv/app/.ENV; do bash "$RUN" dukbae --put "$WORK/plain.txt" "$remote" >/dev/null 2>&1; expect "--put 거절: $remote" 1 $?; done
grep -qF '*.pem|' "$RUN"; expect "ssh-run.sh 에 bash 비밀 이름 목록이 남지 않는다" 1 $?
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
# 상태 명령 안의 kubectl --request-timeout 글자와 헷갈리지 않게 가짜 athena 가 쓰는 줄 머리("request <키>")만 본다
if grep -q '^request ' "$LOG" 2>/dev/null; then no "--status 는 요청을 열지 않는다 — 'request' 줄 있음"; else ok "--status 는 요청을 열지 않는다"; fi
case "$OUT" in *"==end"*) ok "--status 출력이 끝 칸까지 왔다" ;; *) no "--status 출력 — ==end 없음" ;; esac
STATUS_CMD="$(sed -n "s/^STATUS_COMMAND='\(.*\)'$/\1/p" "$RUN")"
python3 scripts/lib/server_allow.py check "$STATUS_CMD" >/dev/null 2>&1; expect "상태 명령은 허용 목록 안" 0 $?
: >"$LOG"; bash "$RUN" dukbae --status extra >/dev/null 2>&1; expect "--status 뒤 인자는 쓰임새 오류(2)" 2 $?
lacks "거절한 --status 는 ssh 를 부르지 않는다" "$LOG" "ssh "

# 지난 기록 읽기(--history) — sar 하루 파일 · 허용 목록 안 · 요청 없이 바로
: >"$LOG"; bash "$RUN" dukbae --history >/dev/null 2>&1; expect "--history 는 바로 실행" 0 $?
has "--history 가 sar 기록 명령을 ssh 로 보냈다" "$LOG" "S_TIME_FORMAT=ISO sar -u -q -r -n DEV -f /var/log/sysstat/sa"
has "--history 가 시간대를 같이 읽는다" "$LOG" "date +%z"
if grep -q '^request ' "$LOG" 2>/dev/null; then no "--history 는 요청을 열지 않는다"; else ok "--history 는 요청을 열지 않는다"; fi
if grep -q -- ' -o ' "$LOG"; then no "--history 명령에 -o(쓰기) 없음"; else ok "--history 명령에 -o(쓰기) 없음"; fi
: >"$LOG"; bash "$RUN" dukbae --history extra >/dev/null 2>&1; expect "--history 뒤 인자는 쓰임새 오류(2)" 2 $?
lacks "거절한 --history 는 ssh 를 부르지 않는다" "$LOG" "ssh "

echo
if [ "$FAIL" = 0 ]; then echo "✅ server-guard 시험 통과"; else echo "❌ server-guard 시험 실패"; fi
exit "$FAIL"
