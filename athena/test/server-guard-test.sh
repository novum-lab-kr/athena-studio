#!/usr/bin/env bash
# 서버 보호 시험 — 허용 목록(scripts/lib/server_allow.py) · 훅(scripts/hooks/server-guard.py) · scripts/ssh-run.sh. 몇 초
# 규칙(2026-11-27 사용자 결정 "앵간한건 다 빼자" — 11-11 "위험한 것만 묻는다" 를 더 좁혔다): 재부팅 · 디스크 · 방화벽 바꾸기 ·
#   사용자 · 권한(sudoers · /etc/passwd 무리 · /etc/ssh · .ssh 쓰기) · 재귀 삭제 · 비밀 파일 읽기 · 출력 · 메타데이터 주소만 확인 요청 → 승인 뒤 실행,
#   나머지(서비스 재시작 · 설치 · crontab · cp -r · sh -c · 치환 · 변수 · * · 판정 못 한 명령 · 실행 자리 쓰기)는 바로
# 표: ① 바로 ② 확인(어디에 숨겨도 — sh -c · 이어 붙이기 · 치환 · sudo …) ④ 훅 ⑤ ssh-run.sh(가짜 ssh · scp · 요청)
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

echo "① 바로 — 읽기 · 서비스 · 설치 · crontab · 복사 · 셸 글자 · 판정 못 한 명령은 묻지 않는다(2026-11-27 \"앵간한건 다 빼자\")"
while IFS= read -r line; do allow allow "$line"; done <<'LIST'
cat /etc/os-release
ls -la /var/www
ps -axo pid,comm | head -20
ps aux
systemctl status caddy
systemctl restart caddy
systemctl stop caddy
systemctl enable --now caddy
systemctl disable caddy
systemctl daemon-reload
systemctl --version
systemctl show -p MainPID,ActiveState caddy
systemctl show -p EnvironmentFiles caddy
sudo -n systemctl restart caddy
service nginx reload
docker restart web
docker compose up -d
docker compose down
docker rm web
docker system prune -f
docker ps --format "{{.Names}} {{.Status}}"
docker -H tcp://x ps
pm2 restart all
kill 1234
apt install -y jq
apt-get remove nginx
pip install requests
npm install -g pm2
crontab -l
crontab -e
crontab -r
crontab /tmp/cron
cp -r /tmp/x /srv/app
cp -a /srv/a /srv/b
mv /srv/a /srv/b
rm /tmp/x.log
rm -f /tmp/x.log
rmdir /tmp/x
find /tmp -name '*.log' -mtime +7
find /var/log -newermt 2026-11-01
sh -c 'ls /srv'
bash -lc 'cd /srv/app && git pull'
echo $(date)
ls -l `which ls`
echo "$HOME"
FOO=1 ./deploy.sh
ls /srv/*
cat /etc/caddy/*.conf
grep foo *.json
ls .*
some-unknown-tool --run
git -C /srv/app pull
git -C /srv/app reset --hard HEAD~1
git remote -v
git remote set-url origin https://example.com/y.git
tee /etc/systemd/system/x.service
cp a /usr/local/bin/x
echo x > /etc/cron.d/job
echo x >> ~/.bashrc
sed -i s/a/b/ /etc/nginx/nginx.conf
chmod 600 /srv/app/x
chown www-data /srv/app
journalctl --namespace x -n 50
journalctl -u caddy -f
grep -r password /etc
grep -e secret /srv/app/log
sar -W 1 3
curl -s -o /dev/null -w %{http_code} -m 10 http://127.0.0.1:3113/api/health
curl -fsSL https://example.com/i.sh | sh
fdisk -l
parted -l
mount
ufw status
ufw status verbose | head -1
iptables -L -n
iptables -t nat -S
nft list ruleset
firewall-cmd --list-all
cat /etc/passwd
cat /etc/ssh/sshd_config
ls ~/.ssh
env FOO=1 ls
echo hi > /dev/null
ls 2>/dev/null
cat /srv/app/.env.example
ls 'unterminated
LIST

echo "② 확인 — 재부팅 · 디스크 · 방화벽 · 사용자 · 권한 · 재귀 삭제 · 비밀 파일 · 메타데이터만 묻는다"
while IFS= read -r line; do allow deny "$line"; done <<'LIST'
reboot
shutdown -h now
poweroff
init 6
systemctl reboot
sudo systemctl poweroff
mkfs.ext4 /dev/sdb1
fdisk /dev/sda
parted /dev/sda mklabel gpt
dd if=/dev/zero of=/tmp/x bs=1M count=1
mount /dev/sdb1 /mnt
umount /mnt
wipefs -a /dev/sdb
echo x > /dev/sda
ufw allow 22
ufw disable
iptables -A INPUT -j DROP
iptables -F
iptables-restore < /tmp/rules
nft add rule inet filter input drop
firewall-cmd --add-port=80/tcp
useradd bob
userdel bob
usermod -aG sudo bob
passwd bob
visudo
tee /etc/sudoers.d/bob
echo x >> ~/.ssh/authorized_keys
cp a /etc/ssh/sshd_config
sed -i s/no/yes/ /etc/ssh/sshd_config
sort -o /etc/passwd a
curl -o /etc/sudoers.d/x http://localhost
sed -n 'w /etc/passwd' /etc/hosts
chmod 600 /root/.ssh/config
rm -r /tmp/x
rm -rf /srv/app/node_modules
rm -Rf /tmp/x
rm --recursive /tmp/x
find /tmp -name x -delete
find /tmp -exec rm -rf {} \;
cat /srv/app/.env
cat .env.production
cd /srv/app && cat .env
cat ~/.ssh/id_rsa
cat /etc/shadow
cat ~/.docker/config.json
cat *.pem
jq . /srv/app/.e*
cat .e"$1"nv
env
printenv
ps auxe
systemctl show caddy
systemctl show -a caddy
systemctl show -p Environment caddy
docker inspect web
docker compose config
kubectl get secret x -o yaml
echo $API_TOKEN
echo "${DB_PASSWORD}"
curl http://169.254.169.254/latest/meta-data/
curl 169.254.169.254
wget -qO- http://metadata.google.internal/
curl http://2852039166/
LIST

echo "② 확인 — 어디에 숨겨도 같다(이어 붙이기 · 치환 · 셸 · 감싸기)"
while IFS= read -r line; do allow deny "$line"; done <<'LIST'
ls && reboot
ls; rm -rf /tmp/x
ls || rm -r /tmp/x
ls | xargs rm -rf
ls & reboot
(reboot)
{ rm -r /tmp/x; }
echo $(reboot)
echo "$(rm -rf /tmp/x)"
echo `reboot`
diff <(cat /srv/app/.env) /tmp/x
sh -c 'rm -rf /tmp/x'
bash -lc "reboot"
su -c 'useradd bob'
eval reboot
sudo reboot
sudo -u root rm -rf /tmp/x
X=1 reboot
env A=1 reboot
nohup reboot &
timeout 5 reboot
nice -n 10 rm -rf /tmp/x
sh -c "sh -c 'reboot'"
if true; then reboot; fi
f=.env; cat $f
f=/srv/app/.env && cat "$f"
export K=~/.ssh/id_rsa; cat $K
cat /root/.ssh/*
tar czf - /root/.ssh
cp -r ~/.ssh /tmp/x
docker exec web env
kubectl exec web -- printenv
LIST
echo "① 바로 — 보안 검토 뒤에도 그대로(.ssh 목록 보기 · 정한 변수가 비밀이 아님)"
while IFS= read -r line; do allow allow "$line"; done <<'LIST'
ls -la ~/.ssh
stat /root/.ssh
f=/srv/app/log; cat $f
docker exec web ls /app
echo "$(date)"
LIST
echo "② 확인 — 읽는 명령의 경로를 치환으로 정하면 판정 못 함 → 확인(2026-11-27 PR #382 리뷰)"
while IFS= read -r line; do allow deny "$line"; done <<'LIST'
cat "$(printf %s .en; printf v)"
cat $(printf .env)
cat `printf .env`
head -5 "$(ls /srv/app/.e*)"
base64 "$(echo x)"
LIST
echo "② 확인 — 재부팅 대상 켜기 · systemd-run 안 · 셸 변수 통째 출력(2026-11-28 PR #382 리뷰)"
while IFS= read -r line; do allow deny "$line"; done <<'LIST'
systemctl start poweroff.target
systemctl isolate reboot.target
systemctl isolate runlevel6.target
systemctl isolate runlevel0.target
systemctl isolate reboot
systemctl start halt.target
systemctl set-default runlevel0.target
systemd-run reboot
systemd-run --unit x --on-active=30 reboot
systemd-run -u x -p A=1 shutdown -h now
sudo systemd-run --scope systemctl isolate reboot.target
command reboot
command rm -rfv /tmp/x
command reboot -v
command -- reboot
set
declare -p
export -p
typeset -p
export
declare -px
ls; set
LIST
echo "① 바로 — 같은 리뷰 뒤에도 그대로(보기 · 찾기 · 인자 있는 set · export)"
while IFS= read -r line; do allow allow "$line"; done <<'LIST'
systemctl status reboot.target
systemctl list-dependencies poweroff.target
systemctl start rebooter.service
systemd-run --unit x ls
command -v reboot
command -V shutdown
command -pv reboot
set -e
set -o pipefail
set -- a b
export X=1
declare -p HOME
declare -F
LIST
allow deny "$(printf 'ls\nreboot')"

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
run_hook() {   # <명령 글자> → 훅 종료 코드. 세션은 HOOK_AGENT(기본 위임 에이전트 athena-studio-fe · '' 이면 아테나 리드 — ATHENA_AGENT 없음)
  local agent="${HOOK_AGENT-athena-studio-fe}"
  if [ -n "$agent" ]; then
    CMD="$1" python3 -c 'import json,os,sys; json.dump({"tool_input":{"command":os.environ["CMD"]}}, sys.stdout)' | ATHENA_AGENT="$agent" python3 "$HOOK" >/dev/null 2>&1
  else
    CMD="$1" python3 -c 'import json,os,sys; json.dump({"tool_input":{"command":os.environ["CMD"]}}, sys.stdout)' | env -u ATHENA_AGENT python3 "$HOOK" >/dev/null 2>&1
  fi
  echo $?
}
lead_hook() {   # <기대: pass|block> <명령> — 아테나(리드) 세션에서
  local want=0 got; [ "$1" = block ] && want=2
  got="$(HOOK_AGENT='' run_hook "$2")"
  if [ "$got" = "$want" ]; then ok "[리드 $1] $2"; else no "[리드 $1] $2 (종료 코드 $got)"; fi
}
reviewer_hook() {   # <기대: pass|block> <명령> — reviewer 세션에서
  local want=0 got; [ "$1" = block ] && want=2
  got="$(HOOK_AGENT=reviewer run_hook "$2")"
  if [ "$got" = "$want" ]; then ok "[reviewer $1] $2"; else no "[reviewer $1] $2 (종료 코드 $got)"; fi
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
echo "④ 훅 — 서버 확인 요청의 답 · 닫기는 아테나(리드)만 · answer 는 --by lead(2026-11-21 사용자 결정)"
lead_hook pass "bin/athena request answer r-1 --by lead --choice 실행"
lead_hook pass "bin/athena request answer r-p1 --by lead --choice 실행 --text 확인함"
lead_hook pass "bin/athena request cancel r-1 --reason 필요 없음"
lead_hook pass "bin/athena request cancel r-p1"
lead_hook pass "node scripts/athena.mjs request answer r-1 --choice 실행 --by lead"
lead_hook pass "bin/athena request answer r-q1 --by chat --text 네"
lead_hook block "bin/athena request answer r-1 --by app --choice 실행"
lead_hook block "bin/athena request answer r-1 --by chat --text 실행"
lead_hook block "bin/athena request answer r-1 --choice 실행"
lead_hook block "bin/athena request answer r-1 --by leader --choice 실행"
lead_hook block "bin/athena request answer r-1 --choice 실행; echo --by lead"
lead_hook block 'bin/athena request answer $ID --by lead --choice 실행'
lead_hook block "bin/athena request answer r-err --by lead --choice 실행"
lead_hook block "ssh dukbae-server uptime"
lead_hook block "ATHENA_SSH_BIN=/bin/sh scripts/ssh-run.sh dukbae -- 'rm x'"
# 위임 에이전트 · reviewer 는 --by lead 를 붙여도 · 환경 값을 지워도 막힌다(훅은 세션 환경으로 판정한다)
hook block "bin/athena request answer r-1 --by lead --choice 실행"
hook block "bin/athena request cancel r-1 --reason x"
hook block "env -u ATHENA_AGENT bin/athena request answer r-1 --by lead --choice 실행"
hook block "unset ATHENA_AGENT; bin/athena request answer r-1 --by lead --choice 실행"
hook block "ATHENA_AGENT= bin/athena request cancel r-p1"
reviewer_hook block "bin/athena request answer r-1 --by lead --choice 실행"
reviewer_hook block "bin/athena request cancel r-p1 --reason x"
reviewer_hook pass "bin/athena request answer r-q1 --by chat --text 네"
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
key=""; body=""; json=""
while [ $# -gt 0 ]; do case "$1" in --key) key="$2"; shift ;; --body-file) body="$2"; shift ;; --json) json=1 ;; esac; shift; done
echo "request $key" >>"$FAKE_LOG"
cp "$body" "$FAKE_BODY"
# 진짜 bin/athena 처럼 --json 이 있을 때만 JSON — 없으면 사람용 줄(ssh-run.sh 가 id 를 못 읽던 것을 잡는다)
if [ -n "$json" ]; then echo '{"ok":true,"request":{"id":"r-fake"}}'; else echo "✅ 요청 r-fake 를 열었다"; fi
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
: >"$LOG"; bash "$RUN" dukbae -- cat a ';' rm -r b >/dev/null 2>&1; expect "여러 인자의 ';' 는 판정이 구분자로 보고 확인 요청(3 — 안전한 쪽)" 3 $?
has "여러 인자의 ';' — 요청 본문에 따옴표째" "$WORK/body.md" "cat a ';' rm -r b"
lacks "여러 인자의 ';' — 확인 전에는 ssh 를 부르지 않는다" "$LOG" "ssh "
: >"$LOG"; bash "$RUN" dukbae -- "grep -F 'caddy[' /var/log/syslog" >/dev/null 2>&1; expect "인자 하나는 그 글자 그대로(바로 실행)" 0 $?
has "인자 하나 — 글자 그대로 보냈다" "$LOG" "ssh grep -F 'caddy[' /var/log/syslog"

: >"$LOG"; bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>&1; expect "sh -c 는 확인 요청(3)" 3 $?
# 요청 id 는 request open --json 의 JSON 에서 읽는다 — --json 이 빠지면 사람용 줄이라 "?" 로 찍혔다(2026-11-25)
bash "$RUN" dukbae -- sh -c 'rm -rf /tmp/x' >/dev/null 2>"$WORK/ask.err"
has "확인 요청 안내에 요청 id(r-fake)" "$WORK/ask.err" "요청 r-fake 을 열었다"
has "승인 안내에 같은 id" "$WORK/ask.err" "ATHENA_SERVER_APPROVED=r-fake"
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
# 보통 경로 --put 은 묻지 않고 백업 → 덮어쓰기(2026-11-27 결정 "앵간한건 다 빼자" — cron · systemd · /usr/local/bin 도 바로)
: >"$LOG"; bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/caddy/Caddyfile >/dev/null 2>&1; expect "보통 경로 --put 은 바로 올린다" 0 $?
if grep -q '^request ' "$LOG" 2>/dev/null; then no "보통 경로 --put 은 요청을 열지 않는다"; else ok "보통 경로 --put 은 요청을 열지 않는다"; fi
has "보통 경로 --put — 백업 먼저(cp -p → ~/.athena-backups)" "$LOG" ".athena-backups/"
has "보통 경로 --put — 그다음 덮어쓰기(scp)" "$LOG" "dukbae-server:/etc/caddy/Caddyfile"
if [ "$(grep -n 'cp -p' "$LOG" | cut -d: -f1)" -lt "$(grep -n '^scp' "$LOG" | cut -d: -f1)" ] 2>/dev/null; then ok "보통 경로 — 백업이 덮어쓰기보다 먼저"; else no "보통 경로 — 백업이 덮어쓰기보다 먼저"; fi
: >"$LOG"; FAKE_REMOTE_MISSING=1 bash "$RUN" dukbae --put "$WORK/Caddyfile" /srv/new.conf >/dev/null 2>&1; expect "새 파일 --put 은 바로 만든다" 0 $?
lacks "새 파일은 백업하지 않는다" "$LOG" "cp -p"
has "새 파일 --put — 올렸다" "$LOG" "dukbae-server:/srv/new.conf"

# 보호 경로(sudoers · /etc/passwd 무리 · /etc/ssh · .ssh · /dev) --put 은 그대로 확인 → 승인 뒤 백업 → 덮어쓰기
: >"$LOG"; bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/sudoers.d/backup >/dev/null 2>&1; expect "보호 경로 --put 은 확인(3)" 3 $?
lacks "확인 전에는 올리지 않는다" "$LOG" "scp "
lacks "확인 전에는 백업하지 않는다" "$LOG" "cp -p"
has "요청 키 server-put" "$LOG" "request server-put:"
has "확인 창에 보호 경로 이유" "$WORK/body.md" "사용자 · 권한 파일 쓰기(/etc/sudoers.d/backup)"
has "확인 창에 diff — 지울 줄" "$WORK/body.md" "-old line"
has "확인 창에 diff — 더할 줄" "$WORK/body.md" "+new line"
has "확인 창에 원격 백업 위치" "$WORK/body.md" "~/.athena-backups/<올리는 시각>/etc/sudoers.d/backup"
PUT_KEY="$(sed -n 's/^request //p' "$LOG" | head -1)"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-put1 FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/sudoers.d/backup >/dev/null 2>&1
expect "승인된 --put 은 올린다" 0 $?
has "백업 먼저(cp -p → ~/.athena-backups)" "$LOG" ".athena-backups/"
has "그다음 덮어쓰기(scp)" "$LOG" "dukbae-server:/etc/sudoers.d/backup"
if [ "$(grep -n 'cp -p' "$LOG" | cut -d: -f1)" -lt "$(grep -n '^scp' "$LOG" | cut -d: -f1)" ] 2>/dev/null; then ok "백업이 덮어쓰기보다 먼저"; else no "백업이 덮어쓰기보다 먼저"; fi
: >"$LOG"; ATHENA_SERVER_APPROVED=r-put1 FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/sudoers.d/backup >/dev/null 2>&1
expect "같은 --put 승인은 두 번 쓰지 못한다(3)" 3 $?
lacks "두 번째 --put 은 올리지 않는다" "$LOG" "scp "
printf 'newer line\n' >"$WORK/Caddyfile"
: >"$LOG"; ATHENA_SERVER_APPROVED=r-put2 FAKE_ANSWER="$(answer_json "$PUT_KEY" 실행 1)" bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/sudoers.d/backup >/dev/null 2>&1
expect "올릴 내용이 바뀌면 다시 확인(3)" 3 $?
lacks "내용이 바뀐 --put 은 올리지 않는다" "$LOG" "scp "
for remote in /etc/sudoers.d/web /etc/sudoers '~/.ssh/config' /root/.ssh/config /etc/ssh/sshd_config /srv/../etc/passwd ../../etc/group /dev/sdb; do
  : >"$LOG"; bash "$RUN" dukbae --put "$WORK/Caddyfile" "$remote" >/dev/null 2>&1; expect "보호 경로 --put 확인(3): $remote" 3 $?
  lacks "보호 경로 --put 은 확인 전에 올리지 않는다: $remote" "$LOG" "scp "
done
# 실행 자리 · cron · 셸 rc 는 이제 묻지 않는다(2026-11-27)
for remote in /etc/cron.d/backup /etc/crontab /etc/profile.d/x.sh /usr/local/bin/x /etc/systemd/system/x.service '~/.bashrc' /etc/logrotate.d/x /etc/default/grub /etc/fstab '~/.gitconfig'; do
  : >"$LOG"; bash "$RUN" dukbae --put "$WORK/Caddyfile" "$remote" >/dev/null 2>&1; expect "보통 경로 --put 바로(0): $remote" 0 $?
  if grep -q '^request ' "$LOG" 2>/dev/null; then no "요청을 열지 않는다: $remote"; else ok "요청을 열지 않는다: $remote"; fi
  has "백업 먼저: $remote" "$LOG" ".athena-backups/"
done
: >"$LOG"; FAKE_REMOTE_MISSING=1 bash "$RUN" dukbae --put "$WORK/Caddyfile" /etc/sudoers.d/new >/dev/null 2>&1; expect "보호 경로 새 파일 --put 도 확인(3)" 3 $?
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
python3 scripts/lib/server_allow.py check "$STATUS_CMD" >/dev/null 2>&1; expect "상태 명령은 바로 되는 명령" 0 $?
: >"$LOG"; bash "$RUN" dukbae --status extra >/dev/null 2>&1; expect "--status 뒤 인자는 쓰임새 오류(2)" 2 $?
lacks "거절한 --status 는 ssh 를 부르지 않는다" "$LOG" "ssh "

# 지난 기록 읽기(--history) — sar 하루 파일 · 바로 되는 명령 · 요청 없이 바로
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
