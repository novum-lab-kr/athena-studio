#!/usr/bin/env python3
"""서버 명령 판정 — **위험한 것만 묻는다**(2026-11-11 사용자 결정 · 11-08 "서버는 엄격하게(쓰기는 명령마다 확인)" 를 바꿨다).

바로 실행: 읽기 · mkdir · 파일 쓰기(cp · tee · touch · > >> · sed -i) · systemctl daemon-reload · 여러 명령 잇기(&& ; | — 명령마다 다 본다).
확인(→ ssh-run.sh 가 [작업] 확인 요청): 위험 표 DANGER 의 명령(서비스 켜기 · 끄기 · 재시작 · 삭제 · 설치 · 권한 · 사용자 ·
  전원 · 디스크 · 방화벽 · 크론) · 다른 명령을 돌리는 것 RUNNERS(sh -c · xargs · awk · find -exec …) · 그 밖에 판정 못 한 명령.
  쓰기도 보호 경로(PROTECTED — /dev · /proc · /sys · /boot · sudoers · passwd · shadow · cron · fstab · /etc/ssh · .ssh)와
  다음에 실행되는 자리(RUN_SPOTS — profile · rc.local · init.d · systemd · ld.so.conf · sysctl · apt · hosts · bin · lib · 홈의 셸 rc)면 확인.
  mkdir 은 빈 폴더라 RUN_SPOTS 를 보지 않는다(mkdir -p /etc/systemd/system/x.service.d 는 결정대로 바로).
  클라우드 메타데이터 주소(169.254.* · metadata.* · 숫자로 감싼 IP) curl 도 확인(자격 증명이 나온다).
그대로 막는 것(= 확인 받기 — 바로 돌지 않는다):
  - 비밀값 파일 이름(.env · 키 · 인증서 · ssh_host_*_key · .docker/config.json · .kube/config …)을 읽기 · 쓰기 · 옵션 값 어디든 — 흔한 이름만 안다
  - 원격 셸이 펼쳐 이름 검사를 비켜 가는 글자 — 홑따옴표 밖의 $ · 백틱 · 따옴표 밖 * ? [ { } ~ (홑따옴표 안의 $ 는 된다 — grep -e '^$')
  - 환경 변수를 보이는 것(systemctl show 의 옵션 없음 · -a · -p Environment · ps e · /proc/*/environ · env · printenv · docker inspect …)
  - 비밀 파일까지 읽는 재귀(grep -r · diff -r) · 끝없이 도는 것(tail -f · 간격만 준 반복)
  - heredoc · 서브셸 ( ) · <( ) · 백그라운드 & · 줄바꿈 · VAR=값 앞붙임 · 경로로 부른 명령(/tmp/x) · sudo 의 -n 밖 옵션
옵션은 명령마다: 옵션이 위험할 수 있는 명령(systemctl · journalctl · docker · git 앞 옵션 · curl · date · hostname …)은 허용 옵션 목록(SPECS),
  나머지 읽기 · 쓰기 도구(FREE)는 옵션 자유 + 막는 옵션(FREE_BANS — 줄임 --out 같은 GNU 앞부분 맞춤도 막는다).
리다이렉트 앞 fd 숫자는 원문에서 연산자에 바로 붙은 것(2> · 2>&1)만 — 띄어 쓴 숫자(date 11081200 >/dev/null)는 인자로 본다.
쓰는 곳: scripts/ssh-run.sh(실행 전 판정 · 승인 확인) · 앱 서버 상태 칸 · 등록 접속 시험(`true`).

CLI(ssh-run.sh 가 부른다)
  server_allow.py check <원격 명령>                 허용이면 0 · 아니면 1 + 이유 한 줄(stdout)
  server_allow.py key <서버> <종류> <글…>           확인 요청 중복 방지 키 server-<종류>:<해시 12자>
  server_allow.py approved <요청 bin> <요청 id> <키> [<사용 기록 파일>]
                                                    그 요청이 이 키 · 답 "실행" · 60분 안 · 아직 안 쓴 승인이면 0 — 쓴 것으로 적고(한 번만) answered 면 요청을 닫는다
  server_allow.py secret <경로>                     비밀값이 들 수 있는 파일 이름이면 0(ssh-run.sh --get · --put 이 부른다)
  server_allow.py protected <경로>                  쓰면 확인할 보호 경로면 0 + 이유(ssh-run.sh --put 이 부른다)
"""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import posixpath
import re
import shlex
import subprocess
import sys

# 비밀값이 들 수 있는 파일 이름(마지막 조각) — secret-guard.py 와 같은 생각 · environ 은 /proc/<pid>/environ(환경 변수)
SECRET_NAME = re.compile(
    r"^(\.env(\.[\w-]+)?|.*\.(pem|key|p12|pfx|keystore|jks)|ssh_host_\w+_key|id_(rsa|ed25519|ecdsa|dsa)\w*|\.npmrc|\.pgpass|\.netrc|\.git-credentials|credentials(\.json)?|.*secrets?(\.\w+)?|authorized_keys|shadow|gshadow|environ)$",
    re.IGNORECASE,
)
EXAMPLE_NAME = re.compile(r"^\.env\.(example|sample|template)$")
# 이름만으로는 흔한 파일(config.json · config)이라 폴더까지 보는 것 — 도커 · kubectl 로그인 정보
SECRET_PATH = re.compile(r"(^|/)(\.docker/config\.json|\.kube/config)$", re.IGNORECASE)
# 따옴표 밖이면 원격 셸이 펼치는 글자 — 글롭 * ? [ · 중괄호 펼침 { } · 홈 ~
SHELL_EXPANDS = set('*?[{}~')

SEPARATORS = {';', '&&', '||', '|', '|&'}
WRITE_REDIRECTS = {'>', '>>', '>|', '&>', '&>>'}


def spec(flags='', args='', long='', digits=False, most=None):
    """허용 옵션 — flags 값 없는 짧은 옵션 글자 · args 값을 받는 글자 · long 긴 옵션(이름= 은 값을 받는다 · 이름[=] 은 = 로만 값)
    digits: -20 같은 숫자 옵션 · most: 이름 인자 최대 수(None 이면 제한 없음)"""
    table = {}
    for word in long.split():
        if word.endswith('[=]'):
            table[word[:-3]] = 2
        elif word.endswith('='):
            table[word[:-1]] = 1
        else:
            table[word] = 0
    return {'flags': flags, 'args': args, 'long': table, 'digits': digits, 'most': most}


# 옵션이 위험할 수 있는 명령 — 옵션은 여기 적은 것만(끝없이 도는 -c · -s 반복 · 시각 · 이름 바꾸기 · 다른 데몬 연결은 뺐다)
SPECS = {
    'free': spec('bkmghltwv', long='--bytes --kilo --mega --giga --human --wide --total --si --lohi'),
    'netstat': spec('tulpnaeirsWvxw', long='--tcp --udp --listening --programs --numeric --all --extend --interfaces --route --statistics --wide'),
    'lsof': spec('nPltVbwR', 'ipuctsgd'),
    'vmstat': spec('asdDwtfmn', 'S', most=2),
    'iostat': spec('xcdkmhtNzy', 'p', most=2),
    'last': spec('naFxwiR', 'nst', digits=True),
    'ping': spec('nq46', 'cWwiIs'),
    'hostname': spec('IifsdAa', long='--all-ip-addresses --ip-address --fqdn --short --domain --all-fqdns', most=0),
    'date': spec('uRI', 'dr', '--utc --rfc-2822 --iso-8601[=] --rfc-3339= --date= --reference='),
    'hostnamectl': spec(most=1),
    'timedatectl': spec(most=1),
    'journalctl': spec('kqraexmb', 'nouptSUg', '--no-pager --no-hostname --reverse --utc --quiet --list-boots --disk-usage --catalog --merge --all --dmesg --pager-end --boot[=] --lines[=] --unit= --since= --until= --priority= --output= --identifier= --grep= --user-unit=', digits=True),
    # -p · -P · --property 는 show 의 칸 고르기(Environment 는 check_sub 가 막는다) · -H/--host · -M 은 없다(다른 기계)
    'systemctl': spec('alq', 'tnopP', '--no-pager --no-legend --plain --all --failed --full --quiet --value --type= --state= --lines= --output= --property='),
    'docker': spec('aqsltv', 'np', '--all --quiet --no-trunc --no-stream --timestamps --digests --size --latest --verbose --format= --filter= --tail= --since= --until= --project-name='),
    'pm2': spec(long='--nostream --raw --err --out --no-color --lines='),
    'apt': spec('a', long='--installed --upgradable --all-versions'),
    'npm': spec('agl', long='--all --json --long --global --parseable --prod --production --depth='),
    'caddy': spec(long='--pretty --config= --adapter='),
    # podman — docker 읽기 중 상태 칸에 필요한 것만(logs · compose 는 뺐다 — podman logs -n 은 docker 와 뜻이 다르고 compose 는 바깥 도구를 부른다)
    'podman': spec('aqsltv', 'n', '--all --quiet --no-trunc --no-stream --size --latest --format= --filter='),
}
# 하위 명령까지 정한 것 — 첫 이름 인자가 이 안에 있어야. systemctl show 는 -p 로 칸을 골라야(check_sub) · daemon-reload 는 바로(2026-11-11)
SUBCOMMANDS = {
    'systemctl': {'status', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs', 'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'get-default', 'cat', 'show', 'daemon-reload'},
    'docker': {'ps', 'logs', 'images', 'stats', 'version', 'info', 'top', 'port', 'compose', 'network', 'volume', 'container', 'image', 'system'},
    'pm2': {'ls', 'list', 'status', 'logs'},
    'apt': {'list'},
    'npm': {'ls', 'list'},
    'caddy': {'version', 'validate', 'list-modules', 'adapt'},
    'podman': {'ps', 'stats', 'images', 'version', 'info', 'top', 'port', 'container', 'image', 'system', 'network', 'volume'},
    'hostnamectl': {'status'},
    'timedatectl': {'status'},
}
# docker 의 둘째 단 — compose ps · network ls …
DOCKER_SECOND = {
    'compose': {'ps', 'logs', 'ls', 'images', 'top', 'version'},
    'network': {'ls'}, 'volume': {'ls'}, 'container': {'ls', 'logs', 'top', 'port'}, 'image': {'ls'}, 'system': {'df', 'info'},
}
# 글자 하나로 정해진 명령 — 인자 목록이 이 중 하나와 똑같아야
EXACT = {
    'node': [['-v'], ['--version']],
    'python3': [['--version'], ['-V']],
    'python': [['--version'], ['-V']],
    'crontab': [['-l'], ['-l', '-u', None], ['-u', None, '-l']],
    'service': [['--status-all'], [None, 'status']],
    'ufw': [['status'], ['status', 'verbose'], ['status', 'numbered']],
    'nginx': [['-t'], ['-T'], ['-v'], ['-V'], ['-t', '-q']],
    # supervisorctl status 만 — 명령 인자를 주면 비대화라 인증을 묻지 않는다(supervisor supervisorctl.py onecmd 의 401 갈래)
    'supervisorctl': [['status']],
}
# podman 의 둘째 단 — docker 와 같되 compose · logs 는 없다
PODMAN_SECOND = {
    'network': {'ls'}, 'volume': {'ls'}, 'container': {'ls', 'top', 'port'}, 'image': {'ls'}, 'system': {'df', 'info'},
}
# kubectl get 의 자원 — 표 출력(기본 · -o wide)만. secrets · configmaps · 그 밖 자원 · 쉼표 묶음 · 자원/이름 꼴은 막는다
KUBECTL_RESOURCES = {'pods', 'pod', 'po', 'deployments', 'deployment', 'deploy', 'nodes', 'node', 'no', 'statefulsets', 'statefulset', 'sts', 'daemonsets', 'daemonset', 'ds'}
# -o 는 wide 만(json · yaml · jsonpath · go-template · custom-columns 는 파드 spec 의 env 값이 나온다) · 앞 옵션(--kubeconfig · --server · --token …)은 없다
KUBECTL_GET = spec('A', 'no', '--all-namespaces --no-headers --namespace= --output= --request-timeout=')
SLEEP_MAX = 5
# sar — 저장된 하루 기록 읽기만(-u CPU · -q 부하 · -r 메모리 · -S 스왑 · -n DEV 네트워크). -o(파일 쓰기)는 없다 · -f 는 /var/log/sysstat/saNN 만
SAR = spec('uqrS', 'nfse')
SAR_FILE = re.compile(r'/var/log/sysstat/sa\d\d')
SAR_TIME = re.compile(r'\d\d:\d\d(:\d\d)?')
# sar 앞에만 붙일 수 있는 환경 값 — 행 시각을 로케일(%X · 오전/오후) 대신 HH:MM:SS 로(sysstat sa_common.c set_record_timestamp_string)
SAR_ENV = 'S_TIME_FORMAT=ISO'
# find 의 조건 — 값 없는 것 · 값 하나를 받는 것(-fprint 는 파일 쓰기라 없다 · -delete 는 위험 표 · -exec 는 다른 명령)
FIND_FLAGS = {'-print', '-print0', '-ls', '-empty', '-xdev', '-mount', '-readable', '-executable', '-writable', '-not', '!', '-a', '-o', '-and', '-or', '-prune', '-true', '-false', '-L', '-H', '-P', '-depth'}
FIND_ARGS = {'-name', '-iname', '-path', '-ipath', '-wholename', '-type', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-maxdepth', '-mindepth', '-newer', '-user', '-group', '-perm', '-regex', '-iregex', '-links', '-samefile', '-printf', '-uid', '-gid'}
FIND_RUNS = {'-exec', '-execdir', '-ok', '-okdir'}
IP_OPTIONS = {'-br', '-brief', '-4', '-6', '-s', '-stats', '-c', '-color', '-d', '-details', '-j', '-json', '-p', '-pretty', '-o', '-oneline'}
IP_OBJECTS = {'a', 'addr', 'address', 'r', 'route', 'link', 'l', 'n', 'neigh', 'rule'}
IP_ACTIONS = {'show', 'list', 'ls', 'lst', 'get'}
IPTABLES_WORDS = {'-L', '-S', '-n', '-v', '--list', '--line-numbers', '-t', 'filter', 'nat', 'mangle', 'raw'}
# ps 의 BSD 꼴(대시 없는 aux) — e(환경 변수 보이기) · o(형식 값)는 없다
PS_BSD = set('auxwfjlrcSTh')
PS = spec('aAdefFlwHjLTMyNx', 'oOpuUgGtCsq', '--sort= --no-headers --forest --headers --format= --pid= --ppid= --user= --cols= --width=')


def free(ban='', long='', values='', out='', why=''):
    """옵션 자유 명령 — ban 막는 짧은 글자 · long 막는 긴 옵션(GNU 줄임 --fol 도 막는다) · values 값을 받는 짧은 글자(그 뒤 글자는 값)
    out 쓰는 곳을 값으로 받는 짧은 글자(-o/etc/x 처럼 붙여 쓴 것까지 본다) · why 막는 이유"""
    return {'ban': ban, 'long': tuple(long.split()), 'values': values, 'out': out, 'why': why}


GREP_FREE = free('rRd', '--recursive --dereference-recursive --directories', 'efmABCDd', why='재귀 — 비밀 파일까지 읽는다')
# 옵션 자유 — 읽기 · 쓰기 도구. 쓰기(WRITERS)는 쓰는 곳이 보호 경로 · 비밀값이 아니어야
FREE = {name: free() for name in '''ls stat file wc du df uname whoami id groups pgrep pidof lsblk findmnt lscpu nproc uptime w who
    basename dirname readlink realpath which type true echo printf cut tr column getent dig nslookup host lsb_release pwd
    cat head zcat md5sum sha1sum sha256sum sha512sum cksum tac nl cmp comm paste join od strings xxd hexdump
    mkdir touch tee uniq'''.split()}
FREE.update({
    'tail': free('fF', '--follow', 'ncs', why='끝없이 돈다'),
    'grep': GREP_FREE, 'egrep': GREP_FREE, 'fgrep': GREP_FREE, 'zgrep': GREP_FREE,
    'diff': free('r', '--recursive', 'UFIxXSWCDL', why='재귀 — 비밀 파일까지 읽는다'),
    'sort': free('', '--compress-program', 'kStTo', 'o', why='다른 명령을 돌린다'),
    'tree': free('R', '', 'LPIoHT', 'o', why='폴더마다 파일을 쓴다'),
    'ss': free('KD', '--kill --diag', 'AfFDN', why='연결 끊기 · 파일 쓰기'),
    'cp': free('', '', 'tS', 't'),
})
# 이름 인자를 쓰는 곳으로 보는 것(cp 원본 · uniq 입력까지 — 넉넉히) — 보호 경로면 확인
WRITERS = {'cp', 'tee', 'touch', 'mkdir', 'sort', 'uniq', 'tree', 'xxd'}

# 쓰면 확인할 보호 경로 — 장치 · 커널 · 부팅 · 권한 · 사용자 · 로그인 · 크론 · 디스크 표(/dev/null · stdout · stderr 는 된다)
PROTECTED = re.compile(
    r'^/(dev/(?!(null|stdout|stderr)$)|(proc|sys|boot)(/|$)|var/spool/cron(/|$)'
    r'|etc/((passwd|shadow|group|gshadow|anacrontab|fstab|ld\.so\.preload)$|(sudoers[^/]*|cron[^/]*|pam\.d|ssh|security)(/|$)))'
)
PROTECTED_NAMES = {'sudoers', 'passwd', 'shadow', 'group', 'gshadow', 'crontab', 'anacrontab', 'fstab', 'ld.so.preload'}
# 다음에 실행되는 자리 — 로그인 · 부팅 · 서비스 시작 · 다른 명령 실행 때 그 파일이 돈다(2026-11-11 보안 검토 중간 1 · 아테나 지시)
RUN_SPOTS = re.compile(
    r'^/(etc/((profile|bash\.bashrc|environment|rc\.local|hosts|resolv\.conf)$|(profile\.d|rc[^/]*\.d|init\.d|systemd|apt)(/|$)'
    r'|ld\.so\.conf[^/]*(/|$)|sysctl[^/]*(/|$)'
    r'|(update-motd\.d|logrotate\.d|network/if-[^/]*\.d|NetworkManager/dispatcher\.d|udev/rules\.d|modprobe\.d|xdg/autostart)(/|$)|default/grub$)'
    r'|(usr/)?lib/systemd(/|$)|usr/local/s?bin(/|$)|usr/s?bin(/|$)|s?bin(/|$)|lib(/|$))'
)
RUN_NAMES = {'.bashrc', '.bash_profile', '.profile', '.zshrc', '.gitconfig', '.vimrc'}

# 위험 표 — 여기 든 명령은 확인([작업] 요청). 읽기 꼴(READ_FORMS)만 바로 — apt list · dpkg -l · ufw status · crontab -l · iptables -L …
DANGER_KINDS = {
    '서비스 켜기 · 끄기 · 재시작': 'kill pkill killall service supervisorctl pm2',
    '삭제': 'rm rmdir unlink shred truncate',
    '설치 · 제거': 'apt apt-get aptitude dpkg yum dnf rpm snap pip pip3 npm npx pnpm yarn gem flatpak',
    '권한 · 사용자': 'chmod chown chgrp chattr setfacl useradd userdel usermod groupadd groupdel groupmod gpasswd passwd chpasswd chage visudo sudoedit adduser deluser addgroup delgroup',
    '재부팅 · 종료': 'reboot shutdown poweroff halt init telinit',
    '디스크': 'dd mount umount fdisk parted sfdisk gdisk cfdisk wipefs mkswap swapon swapoff losetup',
    '방화벽': 'ufw iptables ip6tables iptables-restore ip6tables-restore nft firewall-cmd',
    '크론': 'crontab',
}
DANGER_NAMES = {name: kind for kind, names in DANGER_KINDS.items() for name in names.split()}
READ_FORMS = {'apt', 'dpkg', 'npm', 'ufw', 'iptables', 'crontab', 'service', 'supervisorctl', 'pm2'}
SERVICE_KIND = '서비스 켜기 · 끄기 · 재시작'
SYSTEMCTL_DANGER = dict.fromkeys(
    'start stop restart reload try-restart reload-or-restart try-reload-or-restart force-reload condrestart enable disable reenable '
    'mask unmask preset preset-all isolate kill clean freeze thaw set-property revert edit link set-default set-environment '
    'unset-environment import-environment daemon-reexec switch-root'.split(), SERVICE_KIND)
SYSTEMCTL_DANGER.update(dict.fromkeys('reboot poweroff halt suspend hibernate hybrid-sleep kexec emergency rescue default soft-reboot'.split(), '재부팅 · 종료'))
CONTAINER_DANGER = {'restart', 'stop', 'start', 'kill', 'rm', 'rmi', 'run', 'create', 'exec', 'pause', 'unpause', 'update', 'prune', 'up', 'down'}
CONTAINER_DANGER_SECOND = {
    'compose': {'up', 'down', 'restart', 'stop', 'start', 'rm', 'kill', 'run', 'exec', 'create', 'pause', 'unpause', 'build', 'pull'},
    'container': {'rm', 'prune', 'stop', 'start', 'restart', 'kill', 'run', 'create', 'exec', 'pause', 'unpause', 'update'},
    'image': {'rm', 'prune'}, 'volume': {'rm', 'prune'}, 'network': {'rm', 'prune'}, 'system': {'prune'},
}
KUBECTL_DANGER = {'delete': '삭제', **dict.fromkeys('apply create scale rollout edit patch replace drain cordon uncordon set run exec'.split(), SERVICE_KIND)}
REMOVE_WORDS = {'rm', 'rmi', 'prune', 'down'}

# 다른 명령을 돌리는 것 — 안에 든 명령을 판정하지 못하니 확인(env · printenv 는 환경 변수도 보인다)
RUNNERS = set('''sh bash zsh dash ksh fish csh tcsh eval exec source . xargs env printenv nohup timeout watch nice ionice stdbuf
    setsid su runuser chroot nsenter unshare ssh scp sftp rsync awk gawk mawk nawk perl python python3 node ruby php expect
    screen tmux at batch make jq time strace ltrace gdb busybox parallel flock script sg newgrp doas pkexec'''.split())

# git — 읽기 하위 명령만 · 옵션은 자유이되 파일 쓰기 · 바깥 명령 돌리기 옵션은 막는다(GNU 줄임까지)
GIT_READ = {'status', 'log', 'branch', 'rev-parse', 'describe', 'show', 'tag', 'ls-files', 'diff', 'merge-base', 'rev-list', 'show-ref',
            'blame', 'shortlog', 'cat-file', 'ls-tree', 'grep', 'reflog', 'stash', 'worktree', 'count-objects', 'for-each-ref', 'name-rev', 'cherry'}
GIT_BANS = ('--output', '--open-files-in-pager', '--upload-pack', '--receive-pack', '--exec', '--ext-diff', '--textconv', '--config-env')
# branch · tag 는 목록만 — 이 옵션 밖(-d · -m · -f · 만들기)은 확인
GIT_LIST = {
    'branch': spec('arvl', long='--all --remotes --verbose --list --show-current --no-color --color[=] --column[=] --no-column --abbrev= --contains= --no-contains= --merged= --no-merged= --sort= --format= --points-at='),
    'tag': spec('l', 'n', '--list --no-color --color[=] --column[=] --no-column --contains= --no-contains= --merged= --no-merged= --sort= --format= --points-at=', digits=True),
}

# sed — 옵션 · 스크립트 명령. e 명령 · s///e 는 셸을 돌린다 · w 는 파일 쓰기 · r 은 파일 읽기
SED_FLAGS = set('nErszu')
SED_LONG = {'--quiet', '--silent', '--regexp-extended', '--posix', '--sandbox', '--null-data', '--separate', '--unbuffered', '--debug', '--follow-symlinks'}
SED_SIMPLE = set('=dDgGhHnNpPxzF{}')


def secret_arg(arg):
    """경로 · 옵션 값 · git 의 <ref>:<경로> 까지 마지막 조각을 본다"""
    # ./ · // · x/.. 를 접어서 본다(.docker/./config.json · .kube//config — 2026-11-08 PR 재리뷰)
    piece = re.split(r'[:=]', arg)[-1]
    normal = posixpath.normpath(piece) if piece else piece
    if SECRET_PATH.search(normal):
        return True
    name = re.split(r'[/:=]', arg.rstrip('/'))[-1]
    if SECRET_NAME.match(posixpath.basename(normal)) and not EXAMPLE_NAME.match(posixpath.basename(normal)):
        return True
    return bool(SECRET_NAME.match(name)) and not EXAMPLE_NAME.match(name)


def parse(name, args, rule):
    """허용 옵션 목록으로 낱말을 가른다 — (이유 | None, 이름 인자[], [(옵션, 값)])"""
    plain, values, index, ended = [], [], 0, False
    while index < len(args):
        arg = args[index]
        index += 1
        if ended or arg == '-' or not arg.startswith('-'):
            plain.append(arg)
            continue
        if arg == '--':
            ended = True
            continue
        if arg.startswith('--'):
            option, has_value, value = arg.partition('=')
            kind = rule['long'].get(option)
            if kind is None:
                return f'{name} {option}(허용 옵션이 아니다)', plain, values
            if kind == 0 and has_value:
                return f'{name} {option} 는 값을 받지 않는다', plain, values
            if kind == 1 and not has_value:
                if index >= len(args):
                    return f'{name} {option} 값이 없다', plain, values
                value, index = args[index], index + 1
            if kind == 1 or has_value:
                values.append((option, value))
            continue
        if rule['digits'] and re.fullmatch(r'-\d+', arg):
            continue
        letters, position = arg[1:], 0
        while position < len(letters):
            letter = letters[position]
            position += 1
            if letter in rule['args']:
                value = letters[position:]
                if not value:
                    if index >= len(args):
                        return f'{name} -{letter} 값이 없다', plain, values
                    value, index = args[index], index + 1
                values.append((f'-{letter}', value))
                break
            if letter not in rule['flags']:
                return f'{name} -{letter}(허용 옵션이 아니다)', plain, values
    if rule['most'] is not None and len(plain) > rule['most']:
        return f'{name} 이름 인자가 많다(쓰기 · 바꾸기)', plain, values
    return None, plain, values


def check_exact(name, args):
    for shape in EXACT[name]:
        if len(shape) == len(args) and all(want is None and not arg.startswith('-') or want == arg for want, arg in zip(shape, args)):
            return None
    return f'{name} {" ".join(args)}'.strip() + '(읽기 꼴이 아니다)'


def secret_piece(arg):
    """낱말 · 그 안의 공백 조각(sed 스크립트 '1r /x/.env' 같은 것)에서 비밀값 이름 — 없으면 None"""
    for piece in [arg] + (arg.split() if len(arg.split()) > 1 else []):
        if secret_arg(piece):
            return re.split(r'[/:=]', piece.rstrip('/'))[-1]
    return None


def short_letters(arg, values):
    """짧은 옵션 묶음(-uo/x)에서 값 앞의 글자들 · 값을 받는 글자 · 붙은 값 — (글자[], 값 글자 | '', 붙은 값)"""
    letters = arg[1:]
    for position, letter in enumerate(letters):
        if letter in values:
            return list(letters[:position]), letter, letters[position + 1:]
    return list(letters), '', ''


def normal_abs(path):
    """절대 경로를 접는다 — //etc · /etc/./x · /tmp/../etc(posixpath 는 // 로 시작하면 그대로 둔다)"""
    return '/' + posixpath.normpath(path).lstrip('/')


def join_cwd(base, target):
    """cd 뒤 갈 수 있는 곳 — '~' 홈 · '?' 모름. 상대 cd 는 CDPATH 가 다른 곳으로 보낼 수 있어 ./ · ../ 꼴만 잇는다"""
    if target.startswith('/'):
        return normal_abs(target)
    if base in ('~', '?') or not (target in ('.', '..') or target.startswith(('./', '../'))):
        return '?'
    return normal_abs(posixpath.join(base, target))


def guarded(full, run_spots):
    return bool(PROTECTED.match(full) or run_spots and RUN_SPOTS.match(full))


def protected_path(path, cwds=None, run_spots=True):
    """쓰면 확인할 보호 경로면 이유 — 상대 경로는 cd 로 갈 수 있는 곳(cwds) 모두에서 본다. None 이면 홈.
    run_spots 가 거짓이면(mkdir) 다음에 실행되는 자리(RUN_SPOTS · 셸 rc)는 보지 않는다"""
    if not path:
        return '쓰는 곳이 비었다'
    parts = path.split('/')
    if '.ssh' in parts or posixpath.basename(path.rstrip('/')) in PROTECTED_NAMES:
        return f'보호 경로({path})'
    if run_spots and (posixpath.basename(path.rstrip('/')) in RUN_NAMES or '.config/systemd' in path):
        return f'다음에 실행되는 자리({path})'
    if path.startswith('/'):
        return f'보호 경로({path})' if guarded(normal_abs(path), run_spots) else None
    for base in cwds or {'~'}:
        if base == '?':
            return f'cd 로 간 곳을 모르는 상대 경로({path})'
        if base == '~':
            if '..' in parts:
                return f'홈 밖을 가리킬 수 있는 상대 경로({path})'
            continue
        if guarded(normal_abs(posixpath.join(base, path)), run_spots):
            return f'보호 경로({posixpath.join(base, path)})'
    return None


def check_free(name, args, cwds):
    """옵션 자유 명령 — 막는 옵션만 보고, 쓰기 명령은 이름 인자 · 옵션 값 · 붙여 쓴 쓰는 곳을 모두 보호 경로와 견준다"""
    rule = FREE[name]
    targets, index, ended = [], 0, False
    while index < len(args):
        arg = args[index]
        index += 1
        if ended or arg == '-' or not arg.startswith('-'):
            targets.append(arg)
            continue
        if arg == '--':
            ended = True
            continue
        if arg.startswith('--'):
            option, has_value, value = arg.partition('=')
            if len(option) > 2 and any(banned.startswith(option) for banned in rule['long']):
                return f'{name} {option}({rule["why"]})'
            if has_value:
                targets.append(value)
            continue
        letters, letter, value = short_letters(arg, rule['values'])
        bad = next((each for each in letters if each in rule['ban']), None)
        if bad or letter and letter in rule['ban']:
            return f'{name} -{bad or letter}({rule["why"]})'
        if letter in rule['out'] and letter and value:
            targets.append(value)
    if name == 'cp':
        reason, landed = cp_landing(args)
        if reason:
            return reason
        targets += landed
    if name in WRITERS:
        for target in targets:
            why = protected_path(target, cwds, run_spots=name != 'mkdir')
            if why:
                return f'{name} 쓰기 — {why}'
    return None


def cp_landing(args):
    """cp 가 실제로 쓰는 곳 — 목적지가 폴더면 폴더 + 원본 이름(cp /tmp/rc.local /etc → /etc/rc.local · -t 폴더도).
    재귀(-r · -R · -a · --recursive · --archive) · 원본 경로째(--parents)는 하위에 생길 경로를 다 판정 못 하니 확인(2026-11-11 자동 리뷰 #287)"""
    names, folder, index, ended = [], None, 0, False
    while index < len(args):
        arg = args[index]
        index += 1
        if ended or arg == '-' or not arg.startswith('-'):
            names.append(arg)
            continue
        if arg == '--':
            ended = True
            continue
        if arg.startswith('--'):
            option, _, value = arg.partition('=')
            if len(option) > 2 and ('--recursive'.startswith(option) or '--archive'.startswith(option)):
                return f'cp {option}(재귀 복사 — 하위에 생길 경로를 다 판정 못 한다)', []
            if len(option) > 3 and '--parents'.startswith(option):
                # 원본 경로를 목적지 아래에 그대로 만든다(cp --parents ssh/sshd_config /etc → /etc/ssh/sshd_config) — 2026-11-11 보안 재검토
                return f'cp {option}(원본 경로째 복사 — 실제 쓰는 곳을 다 판정 못 한다)', []
            if len(option) > 3 and '--target-directory'.startswith(option):
                if not value and index < len(args):
                    value = args[index]
                    index += 1
                folder = value
            continue
        letters, letter, value = short_letters(arg, 'tS')
        recursive = next((each for each in letters if each in 'rRa'), None)
        if recursive:
            return f'cp -{recursive}(재귀 복사 — 하위에 생길 경로를 다 판정 못 한다)', []
        if letter and not value and index < len(args):
            value = args[index]
            index += 1
        if letter == 't':
            folder = value
    if folder is None:
        if len(names) < 2:
            return None, []
        folder, names = names[-1], names[:-1]
    landed = [posixpath.join(folder, posixpath.basename(posixpath.normpath(source))) for source in names]
    return None, landed + [folder]


def check_find(args):
    index, seen_test = 0, False
    while index < len(args):
        arg = args[index]
        index += 1
        if arg in FIND_RUNS:
            return f'다른 명령을 돌린다(find {arg})'
        if arg in FIND_FLAGS:
            seen_test = seen_test or arg not in ('-L', '-H', '-P')
            continue
        if arg in FIND_ARGS:
            if index >= len(args):
                return f'find {arg} 값이 없다'
            index += 1
            seen_test = True
            continue
        if arg.startswith('-') or seen_test:
            return f'find {arg}(허용 조건이 아니다)'
    return None


def check_curl(args, cwds):
    """GET · HEAD 만 — -s -S -I -L -f -k -i -v -O · -o <파일> · -w 형식 · 시간 제한 · http(s) 주소. 받은 파일 쓰는 곳은 보호 경로가 아니어야"""
    rule = spec('sSILfkivO', 'owmX', '--silent --show-error --head --location --fail --insecure --include --compressed --verbose --remote-name --output= --write-out= --max-time= --connect-timeout= --request= --url=')
    reason, plain, values = parse('curl', args, rule)
    if reason:
        return reason
    urls = list(plain)
    for option, value in values:
        if option in ('-o', '--output') and value != '/dev/null':
            why = protected_path(value, cwds)
            if why:
                return f'curl {option} — {why}'
        if option in ('-X', '--request') and value.upper() not in ('GET', 'HEAD'):
            return f'curl {option} {value}(GET · HEAD 만)'
        if option in ('-w', '--write-out') and (value.startswith('@') or 'output' in value.lower() or 'stderr' in value.lower()):
            return 'curl -w 의 @파일 · %output(파일 쓰기)'
        if option in ('-m', '--max-time', '--connect-timeout') and not re.fullmatch(r'\d+(\.\d+)?', value):
            return f'curl {option} 는 숫자만'
        if option == '--url':
            urls.append(value)
    if not urls:
        return 'curl 주소가 없다'
    bad = next((url for url in urls if not re.match(r'^https?://[^\s]+$', url, re.IGNORECASE)), None)
    if bad:
        return f'curl 주소는 http(s):// 만({bad[:40]})'
    metadata = next((url for url in urls if metadata_host(url)), None)
    if metadata:
        return f'curl 클라우드 메타데이터 주소({metadata[:40]} — 자격 증명이 나온다)'
    # -O 는 주소의 마지막 조각 이름으로 지금 폴더에 쓴다
    if '--remote-name' in args or any(arg.startswith('-') and not arg.startswith('--') and 'O' in short_letters(arg, 'owmX')[0] for arg in args):
        for url in urls:
            name = re.split(r'[?#]', url)[0].rstrip('/').rsplit('/', 1)[-1]
            why = protected_path(name, cwds)
            if why:
                return f'curl -O — {why}'
    return None


def metadata_host(url):
    """클라우드 메타데이터 주소면 참 — 169.254.* · metadata.* · fd00:ec2::254 · 숫자 하나 · 16진 · 0 으로 시작하는 조각으로 감싼 IP"""
    match = re.match(r'^https?://(?:[^/@?#]*@)?(\[[^\]]*\]|[^/:?#]+)', url, re.IGNORECASE)
    host = (match.group(1) if match else '').lower().rstrip('.')
    if host.startswith('169.254.') or host.startswith('metadata') or 'fd00:ec2::254' in host:
        return True
    # 2852039166 · 0xa9fea9fe · 0251.0376.0251.0376 · 169.254 줄임 — 점 네 조각 보통 IP 가 아닌 숫자 주소는 모두
    if re.fullmatch(r'[0-9a-fx.]+', host) and re.search(r'\d', host) and not re.fullmatch(r'((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)', host):
        return True
    return False


def check_sub(name, plain, values, args):
    """하위 명령 · 그 뒤 인자 — parse 를 지난 뒤"""
    first = plain[0] if plain else None
    if name in ('hostnamectl', 'timedatectl') and first is None:
        return None
    if first not in SUBCOMMANDS[name]:
        return f'{name} {first or ""}'.strip() + ' (읽기 하위 명령이 아니다)'
    rest = plain[1:]
    if name in ('docker', 'podman'):
        second = DOCKER_SECOND if name == 'docker' else PODMAN_SECOND
        if first == 'stats' and '--no-stream' not in args:
            return f'{name} stats 는 --no-stream 만'
        if first in second and (not rest or rest[0] not in second[first]):
            return f'{name} {first} {rest[0] if rest else ""}'.strip() + ' (읽기 하위 명령이 아니다)'
    if name == 'systemctl' and first == 'show':
        # 옵션 없는 show · -a 는 Environment= 칸(비밀값)까지 낸다 — -p 로 칸을 고르고 Environment 는 고르지 않는다
        properties = [value for option, value in values if option in ('-p', '-P', '--property')]
        if not properties:
            return 'systemctl show 는 -p 로 칸을 골라야(옵션 없는 show 는 Environment 가 보인다)'
        if any('environ' in value.lower() for value in properties):
            return 'systemctl show -p Environment(환경 변수 — 비밀값)'
        if '--all' in args or any(arg.startswith('-') and not arg.startswith('--') and 'a' in short_letters(arg, 'tnopP')[0] for arg in args):
            return 'systemctl show -a(모든 칸 — Environment 까지)'
    if name == 'pm2' and first == 'logs' and '--nostream' not in args:
        return 'pm2 logs 는 --nostream 만'
    if name in ('hostnamectl', 'timedatectl') and rest:
        return f'{name} {first} 뒤 인자'
    return None


def git_front(args):
    """git -C <폴더> … 의 앞 옵션을 걷어 낸 나머지 · 다른 앞 옵션이면 None"""
    while len(args) >= 2 and args[0] == '-C':
        args = args[2:]
    return None if args and args[0].startswith('-') else args


def check_git(args):
    """git 읽기 하위 명령 — 앞 옵션은 -C 만(-c 설정 바꾸기 · --git-dir · --exec-path 는 없다) · 쓰기 · 바깥 명령 옵션은 막는다"""
    rest = git_front(args)
    if rest is None:
        return f'git {next((arg for arg in args if arg.startswith("-") and arg != "-C"), "-C")}(앞 옵션은 -C 만)'
    sub, rest = (rest[0], rest[1:]) if rest else ('', [])
    if sub not in GIT_READ:
        return f'git {sub}'.strip() + '(읽기 하위 명령이 아니다)'
    for arg in rest:
        if arg == '--':
            break
        option = arg.partition('=')[0]
        if arg.startswith('--') and len(option) > 2 and any(banned.startswith(option) for banned in GIT_BANS):
            return f'git {sub} {option}(파일 쓰기 · 바깥 명령)'
        if sub == 'grep' and arg.startswith('-') and not arg.startswith('--') and 'O' in arg:
            return 'git grep -O(바깥 명령으로 연다)'
    if sub in GIT_LIST:
        reason, plain, _ = parse(f'git {sub}', rest, GIT_LIST[sub])
        if reason:
            return reason
        if plain and not any(arg in ('-l', '--list') for arg in rest):
            return f'git {sub} 만들기(목록은 -l · --list)'
    plain = [arg for arg in rest if not arg.startswith('-')]
    if sub == 'stash' and rest[:1] not in (['list'], ['show']):
        # 하위 명령 없는 git stash(옵션만 줘도)는 push 와 같다 — 작업트리를 치운다(2026-11-11 자동 리뷰 #287)
        return f'git stash {(rest or ["(하위 명령 없음 = push)"])[0]}(list · show 만)'
    if sub == 'worktree' and plain[:1] != ['list']:
        return f'git worktree {(plain or [""])[0]}'.strip() + '(list 만)'
    if sub == 'reflog' and plain[:1] and plain[0] in ('expire', 'delete', 'drop'):
        return f'git reflog {plain[0]}(지우기)'
    return None


def sed_regex_end(script, position, delim):
    """구분 글자까지 건너뛴 다음 자리 — 백슬래시 뒤 글자는 건너뛴다(GNU match_slash 와 같다) · 못 닫으면 -1"""
    while position < len(script):
        if script[position] == '\\':
            position += 2
            continue
        if script[position] == delim:
            return position + 1
        position += 1
    return -1


def sed_address(script, position):
    """주소 하나를 건너뛴 자리 — 숫자 · first~step · $ · +N · ~N · /정규식/ · \\c정규식c(뒤 I · M) · 못 읽으면 -1"""
    if position >= len(script):
        return position
    char = script[position]
    if char.isdigit() or char in '+~':
        position += 1
        while position < len(script) and (script[position].isdigit() or script[position] == '~'):
            position += 1
        return position
    if char == '$':
        return position + 1
    if char in '/\\':
        if char == '\\':
            if position + 1 >= len(script):
                return -1
            position, delim = position + 2, script[position + 1]
        else:
            position, delim = position + 1, '/'
        position = sed_regex_end(script, position, delim)
        while 0 <= position < len(script) and script[position] in 'IM':
            position += 1
    return position


def sed_file(command, filename, cwds):
    """sed 의 r · R · w · W 파일 — 읽기는 비밀값 · 쓰기는 보호 경로도"""
    if not filename:
        return f'sed {command} 파일 이름이 없다'
    if secret_arg(filename):
        return f'비밀값이 들 수 있는 파일({filename.rsplit("/", 1)[-1]})'
    if command in 'wW' and filename not in ('/dev/stdout', '/dev/stderr'):
        why = protected_path(filename, cwds)
        if why:
            return f'sed {command} 쓰기 — {why}'
    return None


def sed_script(script, cwds):
    """sed 스크립트 한 줄 — 명령마다. e · s///e 는 셸을 돌리니 확인 · 모르는 글자도 확인"""
    position, size = 0, len(script)
    while position < size:
        if script[position] in ' \t;':
            position += 1
            continue
        position = sed_address(script, position)
        if 0 <= position < size and script[position] == ',':
            position = sed_address(script, position + 1)
        if position < 0:
            return 'sed 주소를 읽지 못했다'
        while position < size and script[position] in ' \t!':
            position += 1
        if position >= size:
            return 'sed 주소 뒤에 명령이 없다'
        command = script[position]
        position += 1
        if command == '#' or command in 'aic':
            break
        if command in ':btTv':
            end = script.find(';', position)
            position = size if end < 0 else end
            continue
        if command in 'rRwW':
            return sed_file(command, script[position:].strip(), cwds)
        if command == 'e':
            return 'sed e(셸 명령을 돌린다)'
        if command in 'qQlL':
            while position < size and (script[position].isdigit() or script[position] in ' \t'):
                position += 1
            continue
        if command in SED_SIMPLE:
            continue
        if command in 'sy':
            if position >= size or script[position] in '\\\n':
                return f'sed {command} 구분 글자'
            delim = script[position]
            position = sed_regex_end(script, position + 1, delim)
            position = sed_regex_end(script, position, delim) if position >= 0 else -1
            if position < 0:
                return f'sed {command} 를 닫지 못했다'
            while command == 's' and position < size and script[position] not in ';}':
                flag = script[position]
                if flag == 'e':
                    return 'sed s///e(바꾼 글을 셸 명령으로 돌린다)'
                if flag == 'w':
                    return sed_file('w', script[position + 1:].strip(), cwds)
                if not (flag in 'gpiImM \t' or flag.isdigit()):
                    return f'sed s 의 끝 글자 {flag}(판정 못 함)'
                position += 1
            continue
        return f'sed {command}(판정 못 한 명령)'
    return None


def check_sed(args, cwds):
    """sed — 스크립트(-e · 첫 이름 인자)를 읽어 본다 · -i 면 고칠 파일이 보호 경로가 아니어야 · -f(파일 스크립트)는 확인"""
    scripts, files, in_place, index, ended = [], [], False, 0, False
    while index < len(args):
        arg = args[index]
        index += 1
        if ended or arg == '-' or not arg.startswith('-'):
            files.append(arg)
            continue
        if arg == '--':
            ended = True
            continue
        if arg.startswith('--'):
            option, has_value, value = arg.partition('=')
            if option in SED_LONG and not has_value:
                continue
            if option == '--in-place':
                in_place = True
                continue
            if option in ('--expression', '--line-length'):
                if not has_value:
                    if index >= len(args):
                        return f'sed {option} 값이 없다'
                    value, index = args[index], index + 1
                if option == '--expression':
                    scripts.append(value)
                continue
            return f'sed {option}(판정 못 한 옵션)'
        for position, letter in enumerate(arg[1:]):
            if letter in SED_FLAGS:
                continue
            if letter == 'i':
                in_place = True
                break
            if letter in 'el':
                value = arg[position + 2:]
                if not value:
                    if index >= len(args):
                        return f'sed -{letter} 값이 없다'
                    value, index = args[index], index + 1
                if letter == 'e':
                    scripts.append(value)
                break
            if letter == 'f':
                return 'sed -f(파일에 든 스크립트는 읽지 못한다)'
            return f'sed -{letter}(판정 못 한 옵션)'
    if not scripts:
        if not files:
            return 'sed 스크립트가 없다'
        scripts.append(files.pop(0))
    for script in scripts:
        why = sed_script(script, cwds)
        if why:
            return why
    if in_place:
        for target in files:
            why = protected_path(target, cwds)
            if why:
                return f'sed -i — {why}'
    return None


def danger(name, args):
    """위험 표에 든 명령이면 '분류(명령)' — 하위 명령까지 보는 것(systemctl · docker · podman · kubectl · git · find)도 여기"""
    if name.startswith('mkfs'):
        return f'디스크({name})'
    if name in DANGER_NAMES:
        return f'{DANGER_NAMES[name]}({name})'
    if name == 'find' and '-delete' in args:
        return '삭제(find -delete)'
    if name == 'git':
        rest = git_front(args) or []
        if rest[:1] == ['clean'] or rest[:1] == ['reset'] and '--hard' in rest:
            return f'삭제(git {rest[0]}{" --hard" if rest[0] == "reset" else ""})'
        return None
    plain = [arg for arg in args if not arg.startswith('-')]
    if name == 'k3s' and plain[:1] == ['kubectl']:
        name, plain = 'kubectl', plain[1:]
    if not plain:
        return None
    first = plain[0]
    if name == 'systemctl' and first in SYSTEMCTL_DANGER:
        return f'{SYSTEMCTL_DANGER[first]}(systemctl {first})'
    if name == 'kubectl' and first in KUBECTL_DANGER:
        return f'{KUBECTL_DANGER[first]}(kubectl {first})'
    if name in ('docker', 'podman'):
        word = plain[1] if first in CONTAINER_DANGER_SECOND and len(plain) > 1 and plain[1] in CONTAINER_DANGER_SECOND[first] else None
        if word or first in CONTAINER_DANGER:
            kind = '삭제' if (word or first) in REMOVE_WORDS else SERVICE_KIND
            return f'{kind}({name} {first}{" " + word if word else ""})'
    return None


def check_cd(args, cwds, under_sudo):
    """cd — 갈 수 있는 곳을 cwds 에 더한다(실패 · 파이프 안 cd 도 있으니 바꾸지 않고 모은다)"""
    if under_sudo:
        return 'sudo cd'
    rest = [arg for arg in args if arg not in ('-L', '-P')]
    if len(rest) > 1:
        return 'cd 인자가 많다'
    if not rest:
        cwds.add('~')
    elif rest[0] == '-':
        cwds.add('?')
    else:
        cwds.update({join_cwd(base, rest[0]) for base in cwds})
    return None


def judge(name, args, cwds, under_sudo):
    """위험 표 · 다른 명령 돌리기를 지난 명령 — 명령마다 판정 · 옵션 자유 목록 · 그 밖은 판정 못 함"""
    if name == 'cd':
        return check_cd(args, cwds, under_sudo)
    if name == 'git':
        return check_git(args)
    if name == 'sed':
        return check_sed(args, cwds)
    if name == 'docker' and args and args[0].startswith('-'):
        return f'docker {args[0]}(앞 옵션 — 다른 데몬 · 설정)'
    if name in EXACT:
        return check_exact(name, args)
    if name == 'find':
        return check_find(args)
    if name == 'ps':
        return check_ps(args)
    if name == 'ip':
        return check_ip(args)
    if name == 'curl':
        return check_curl(args, cwds)
    if name == 'kubectl':
        return check_kubectl(args)
    if name == 'k3s':
        return check_kubectl(args[1:]) if args and args[0] == 'kubectl' else 'k3s 는 kubectl get 만'
    if name == 'sar':
        return check_sar(args)
    if name == 'sleep':
        if len(args) != 1 or not re.fullmatch(r'\d+(\.\d+)?', args[0]) or float(args[0]) > SLEEP_MAX:
            return f'sleep 은 {SLEEP_MAX}초 이하 숫자 하나만'
        return None
    if name == 'podman' and args and args[0].startswith('-'):
        return f'podman {args[0]}(앞 옵션 — 다른 연결 · 설정)'
    if name == 'command':
        return None if len(args) >= 2 and args[0] == '-v' and not any(arg.startswith('-') for arg in args[1:]) else 'command 는 -v 만'
    if name == 'iptables':
        bad = next((arg for arg in args if arg not in IPTABLES_WORDS), None)
        return f'iptables {bad}' if bad else None
    if name == 'dpkg':
        return None if args and args[0] in ('-l', '--list', '-s', '--status') and not any(arg.startswith('-') for arg in args[1:]) else 'dpkg 는 -l · -s 만'
    if name in FREE:
        return check_free(name, args, cwds)
    if name not in SPECS:
        return f'판정 못 한 명령({name})'
    reason, plain, values = parse(name, args, SPECS[name])
    if reason:
        return reason
    if name == 'date' and any(not arg.startswith('+') for arg in plain):
        return 'date 인자(시각 바꾸기)'
    if name in SUBCOMMANDS:
        return check_sub(name, plain, values, args)
    return None


def check_one(words, cwds=None, under_sudo=False):
    """명령 하나(낱말 목록) — 바로 실행이면 None, 확인할 것이면 이유. cwds 는 cd 로 갈 수 있는 곳(명령 잇기 사이에 쌓인다)"""
    if cwds is None:
        cwds = {'~'}
    if not words:
        return '빈 명령'
    if words[0] == SAR_ENV and not under_sudo:
        return check_sar(words[2:]) if len(words) > 1 and words[1] == 'sar' else f'{SAR_ENV} 는 sar 앞에서만'
    if re.match(r'^[A-Za-z_]\w*=', words[0]):
        return f'환경 값 앞붙임({words[0].split("=")[0]}=…)'
    if words[0] == 'sudo':
        if under_sudo:
            return 'sudo 안의 sudo'
        rest = words[1:]
        while rest and rest[0] == '-n':
            rest = rest[1:]
        if rest and rest[0].startswith('-'):
            return f'sudo 옵션 {rest[0]}'
        if not rest:
            return 'sudo 뒤에 명령이 없다'
        # sudo 뒤도 같은 판정(2026-11-11 — 예전의 더 좁은 목록은 없앴다)
        return check_one(rest, cwds, under_sudo=True)
    name, args = words[0], words[1:]
    if '/' in name:
        return f'경로로 부른 명령({name})'
    for arg in args:
        bad = secret_piece(arg)
        if bad:
            return f'비밀값이 들 수 있는 파일({bad})'
    hazard = danger(name, args)
    if hazard:
        if name in READ_FORMS and judge(name, args, cwds, under_sudo) is None:
            return None
        return f'위험 명령 — {hazard}'
    if name in RUNNERS and not (name in EXACT and check_exact(name, args) is None):
        return f'다른 명령을 돌린다({name})' if name not in ('env', 'printenv') else f'{name}(환경 변수가 보인다)'
    return judge(name, args, cwds, under_sudo)


def check_ps(args):
    words = [arg for arg in args if not arg.startswith('-')]
    dashed = [arg for arg in args if arg.startswith('-')]
    if words and not dashed and len(words) == 1 and words[0] and set(words[0]) <= PS_BSD:
        return None
    reason, plain, values = parse('ps', args, PS)
    if reason:
        return reason
    if any(not re.fullmatch(r'[\d,]+', arg) for arg in plain):
        return 'ps 의 BSD 꼴은 aux 같은 글자만(e · o 는 확인 대상)'
    if any('env' in value.lower() for _, value in values):
        return 'ps 형식에 env(환경 변수)'
    return None


def check_ip(args):
    while args and args[0] in IP_OPTIONS:
        args = args[1:]
    if not args or args[0] not in IP_OBJECTS:
        return f'ip {(args or [""])[0]}'.strip() + '(읽기 하위 명령이 아니다)'
    rest = args[1:]
    if rest and rest[0] not in IP_ACTIONS and rest[0].startswith('-'):
        return f'ip {rest[0]}'
    if rest and rest[0] not in IP_ACTIONS and rest[0] not in ('dev', 'to', 'table', 'from'):
        return f'ip {args[0]} {rest[0]}(읽기 하위 명령이 아니다)'
    if any(arg.startswith('-') for arg in rest):
        return 'ip 뒤쪽 옵션'
    return None


def check_kubectl(args):
    """kubectl get <자원> [이름] — 정한 자원 · 표 출력만(kubectl · k3s kubectl 이 같이 쓴다)"""
    if not args or args[0] != 'get':
        return f'kubectl {(args or [""])[0]}'.strip() + '(get 만)'
    reason, plain, values = parse('kubectl get', args[1:], KUBECTL_GET)
    if reason:
        return reason
    if not plain or plain[0] not in KUBECTL_RESOURCES:
        return f'kubectl get {plain[0] if plain else ""}'.strip() + '(정한 자원이 아니다 — pods · deployments · nodes · statefulsets · daemonsets)'
    if len(plain) > 2:
        return 'kubectl get 이름 인자가 많다'
    for option, value in values:
        if option in ('-o', '--output') and value != 'wide':
            return f'kubectl get {option} {value}(표 출력 — wide 만)'
        if option == '--request-timeout' and not re.fullmatch(r'\d+[sm]?', value):
            return 'kubectl --request-timeout 은 숫자(s · m)만'
    return None


def check_sar(args):
    """sar -u · -q · -r · -n DEV · -f /var/log/sysstat/saNN · -s/-e 시각 · 끝의 간격 · 횟수 숫자만"""
    reason, plain, values = parse('sar', args, SAR)
    if reason:
        return reason
    # 간격만 주면 끝없이 돈다 — 간격 · 횟수 둘 다(짧게)
    if plain and (len(plain) != 2 or any(not arg.isdigit() for arg in plain) or int(plain[0]) > SLEEP_MAX or not 1 <= int(plain[1]) <= 10):
        return f'sar 끝 인자는 간격(≤{SLEEP_MAX}) · 횟수(≤10) 숫자 둘만'
    for option, value in values:
        if option == '-n' and value != 'DEV':
            return f'sar -n {value}(DEV 만)'
        if option == '-f' and not SAR_FILE.fullmatch(value):
            return f'sar -f {value}(/var/log/sysstat/saNN 만)'
        if option in ('-s', '-e') and not SAR_TIME.fullmatch(value):
            return f'sar {option} {value}(HH:MM[:SS] 만)'
    return None


def unquoted_expansion(command):
    """따옴표 · 백슬래시 밖의 * ? [ { } ~ — 원격 셸이 펼치니 이름 검사를 비켜 간다(.{env,x} · .en? · ~/.ssh)"""
    quote, index = None, 0
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif quote == '"':
            if char == '\\':
                index += 1
            elif char == '"':
                quote = None
        elif char == '\\':
            index += 1
        elif char in '\'"':
            quote = char
        elif char in SHELL_EXPANDS:
            return char
        index += 1
    return None


def shell_dollar(command):
    """홑따옴표 밖의 $ — 따옴표 밖 · 쌍따옴표 안 · 백슬래시 뒤(\\$ 도 막는다 — 좁게)는 원격 셸이 변수 · 명령 치환으로 펼칠 수 있다.
    홑따옴표 안('^$')은 글자 그대로라 된다. 백슬래시 뒤 홑따옴표(\\')는 따옴표를 열지 않는다"""
    quote, index = None, 0
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif char == '$':
            return True
        elif quote == '"':
            if char == '\\':
                if command[index + 1:index + 2] == '$':
                    return True
                index += 1
            elif char == '"':
                quote = None
        elif char == '\\':
            if command[index + 1:index + 2] == '$':
                return True
            index += 1
        elif char in '\'"':
            quote = char
        index += 1
    return False


def redirect_marks(command):
    """따옴표 · 백슬래시 밖의 < · > 든 연산자 묶음마다 — 바로 앞에 붙은 숫자(앞은 처음 · 공백 · 연산자)가 있나.
    shlex 는 띄어쓰기를 잊어 `date 11081200 >/dev/null` 과 `date 11081200>/dev/null` 을 가르지 못한다(2026-11-08 PR 리뷰 2)"""
    marks, quote, index = [], None, 0
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif quote == '"':
            if char == '\\':
                index += 1
            elif char == '"':
                quote = None
        elif char == '\\':
            index += 1
        elif char in '\'"':
            quote = char
        elif char in '();<>|&':
            end = index
            while end < len(command) and command[end] in '();<>|&':
                end += 1
            if any(op in command[index:end] for op in '<>'):
                start = index
                while start > 0 and command[start - 1].isdigit():
                    start -= 1
                before = command[start - 1] if start > 0 else ' '
                marks.append(start < index and (before.isspace() or before in '();<>|&'))
            index = end
            continue
        index += 1
    return marks


def finish(words, targets, cwds):
    """명령 하나를 판정하고 그 명령의 쓰기 리다이렉트 쓰는 곳을 본다(cd 가 cwds 를 넓힌 뒤 — 넉넉히)"""
    reason = check_one(words, cwds)
    if reason:
        return reason
    for target in targets:
        if secret_arg(target):
            return f'쓰기 리다이렉트 — 비밀값이 들 수 있는 파일({re.split(r"[/:=]", target.rstrip("/"))[-1]})'
        why = protected_path(target, cwds)
        if why:
            return f'쓰기 리다이렉트 — {why}'
    return None


def check(command):
    """원격 명령 글자 전체 — 바로 실행이면 None, 확인할 것이면 이유. 명령 잇기(; && || |) 안의 명령을 모두 본다"""
    if not command.strip():
        return '빈 명령'
    if re.search(r'[\n\r]', command):
        return '줄바꿈(여러 줄 명령)'
    if '`' in command or shell_dollar(command):
        return '$ · 백틱(변수 · 명령 치환 — 홑따옴표 안의 $ 만 된다)'
    expands = unquoted_expansion(command)
    if expands:
        return f'따옴표 밖의 {expands}(원격 셸이 펼친다 — 이름을 하나씩 적는다)'
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.commenters = ''
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError as error:
        return f'따옴표가 맞지 않다({error})'
    marks = redirect_marks(command)
    if len(marks) != sum(1 for token in tokens if token and all(char in '();<>|&' for char in token) and any(op in token for op in '<>')):
        return '리다이렉트를 읽지 못했다'
    marks.reverse()
    cwds = {'~'}
    words, targets, index = [], [], 0
    while index < len(tokens):
        token = tokens[index]
        # 이 연산자 바로 앞에 붙은 fd 숫자 — 붙은 것만 fd(나머지 숫자는 그 명령의 인자)
        attached = marks.pop() if token and all(char in '();<>|&' for char in token) and any(op in token for op in '<>') else False
        if token in SEPARATORS:
            reason = finish(words, targets, cwds)
            if reason:
                return reason
            words, targets, index = [], [], index + 1
            continue
        if token in WRITE_REDIRECTS:
            target = tokens[index + 1] if index + 1 < len(tokens) else ''
            if not target or all(char in '();<>|&' for char in target):
                return f'쓰기 리다이렉트 {token}(쓰는 곳이 없다)'
            if target != '/dev/null':
                targets.append(target)
            if attached and words and words[-1].isdigit():
                words.pop()
            index += 2
            continue
        if token in ('>&', '<&'):
            target = tokens[index + 1] if index + 1 < len(tokens) else ''
            if not target.isdigit():
                return f'리다이렉트 {token}{target}'
            if attached and words and words[-1].isdigit():
                words.pop()
            index += 2
            continue
        if token == '<':
            target = tokens[index + 1] if index + 1 < len(tokens) else ''
            if not target or secret_arg(target):
                return f'읽기 리다이렉트 {target}'.strip()
            index += 2
            continue
        if token and all(char in '();<>|&' for char in token):
            return f'셸 문법 {token}(서브셸 · heredoc · 백그라운드 · 프로세스 치환)'
        words.append(token)
        index += 1
    return finish(words, targets, cwds)


def key(server, kind, text):
    return f'server-{kind}:' + hashlib.sha256(f'{server}\0{text}'.encode('utf-8')).hexdigest()[:12]


def used_file_default():
    """쓴 승인 기록 — 팩 데이터 state/server-approvals-used(옛 구조 본체면 본체 폴더)"""
    athena_dir = str(pathlib.Path(__file__).resolve().parents[2])
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from athena_config import paths
    return os.path.join(paths(athena_dir)['state'], 'server-approvals-used')


def claim(used_file, request_id):
    """승인 id 를 쓴 것으로 적는다 — 이미 있으면 False(잠금 안에서 보고 적는다 · 한 번만)"""
    os.makedirs(os.path.dirname(os.path.abspath(used_file)), exist_ok=True)
    with open(used_file, 'a+', encoding='utf-8') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        if request_id in handle.read().split():
            return False
        handle.write(request_id + '\n')
        handle.flush()
    return True


def approved(request_bin, request_id, want_key, used_file=''):
    """요청 bin(bin/athena · 시험은 가짜)의 request show 로 읽는다 — 환경 값으로 답을 넣는 길은 없다(2026-11-08 보안 검토 참고).
    맞으면 쓴 것으로 적고(같은 승인은 한 번만 — 요청 본문 "그대로 한 번 실행") · answered 면 요청을 닫는다(2026-11-08 PR 리뷰 2)"""
    if not re.match(r'^[\w-]+$', request_id or ''):
        return False
    try:
        raw = subprocess.run([request_bin, 'request', 'show', request_id, '--json'], capture_output=True, text=True, timeout=20).stdout.strip().split('\n')[-1]
        request = (json.loads(raw) or {}).get('request') or {}
    except Exception:
        return False
    answer = request.get('answer') or {}
    if request.get('dedupeKey') != want_key or request.get('state') not in ('answered', 'delivered') or answer.get('choice') != '실행':
        return False
    try:
        at = datetime.datetime.fromisoformat(str(answer.get('at')).replace('Z', '+00:00'))
    except Exception:
        return False
    if datetime.datetime.now(datetime.timezone.utc) - at > datetime.timedelta(minutes=60):
        return False
    try:
        if not claim(used_file or used_file_default(), request_id):
            return False
    except Exception:
        return False
    if request.get('state') == 'answered':
        # 닫기는 덤 — 못 닫아도 쓴 기록이 다시 쓰기를 막는다(delivered 는 cancel 이 받지 않는다)
        try:
            subprocess.run([request_bin, 'request', 'cancel', request_id, '--reason', '서버 명령 승인을 한 번 썼다'], capture_output=True, timeout=20)
        except Exception:
            pass
    return True


if __name__ == '__main__':
    argv = sys.argv[1:]
    if len(argv) >= 2 and argv[0] == 'check':
        why = check(' '.join(argv[1:]))
        if why:
            print(why)
        sys.exit(1 if why else 0)
    if len(argv) >= 4 and argv[0] == 'key':
        print(key(argv[1], argv[2], ' '.join(argv[3:])))
        sys.exit(0)
    if len(argv) in (4, 5) and argv[0] == 'approved':
        sys.exit(0 if approved(argv[1], argv[2], argv[3], argv[4] if len(argv) == 5 else '') else 1)
    if len(argv) == 2 and argv[0] == 'secret':
        sys.exit(0 if secret_arg(argv[1]) else 1)
    if len(argv) == 2 and argv[0] == 'protected':
        why = protected_path(argv[1])
        if why:
            print(why)
        sys.exit(0 if why else 1)
    print(__doc__.split('CLI')[1], file=sys.stderr)
    sys.exit(2)