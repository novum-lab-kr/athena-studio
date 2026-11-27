#!/usr/bin/env python3
"""서버 명령 판정 — **정말 위험한 것만 묻고 나머지는 바로**(2026-11-27 사용자 결정 "앵간한건 다 빼자" · 11-11 "위험한 것만 묻는다" 를 더 좁혔다).

묻는 것(→ ssh-run.sh 가 [작업] 확인 요청) — ASK 표 · 아래 검사만:
  - 재부팅 · 전원 끄기(reboot · shutdown · poweroff · halt · init · systemctl reboot/poweroff … · systemctl start/isolate reboot.target 무리 · systemd-run 안)
  - 디스크(mkfs · fdisk · parted · dd · mount · umount … — fdisk -l · parted -l · 인자 없는 mount 같은 목록 보기는 바로) · /dev 쓰기
  - 방화벽 바꾸기(ufw · iptables · nft · firewall-cmd — status · -L · list 같은 보기는 바로)
  - 사용자 · 권한(useradd · userdel · usermod · passwd · visudo …) · sudoers · /etc/passwd 무리 · /etc/ssh · .ssh 쓰기(.ssh 는 읽기도 — 목록 보기만 바로)
  - 재귀 삭제(rm -r · rm -rf · find -delete)
  - 비밀 파일 읽기 · 출력(.env · 키 · 인증서 … 이름 · env/printenv 단독 · set · export -p · declare -p 단독 · ps e · systemctl show 의 Environment · docker inspect ·
    compose config · kubectl secret · 이름에 TOKEN · SECRET · PASSWORD 가 든 $변수)
  - 클라우드 메타데이터 주소(169.254.* · metadata.* · 숫자로 감싼 IP)
그 밖은 모두 바로 — 서비스 재시작 · 패키지 설치 · crontab · cp -r · sh -c · 명령 치환 · 변수 · * 펼침 · 판정 못 한 명령 ·
  /etc/systemd · /usr/local/bin 쓰기 …
어디에 숨겨도 같은 검사 — ; && || | 줄바꿈 · $( ) · 백틱 · <( ) · sh -c '…' · eval · find -exec · sudo · env · xargs · timeout 같은
  감싸기를 벗겨 명령마다 본다. 실수 방지용이지 보안 경계가 아니다(변수로 부른 명령 · 스크립트 파일 안은 보지 못한다).
쓰는 곳: scripts/ssh-run.sh(실행 전 판정 · 승인 확인) · 앱 서버 상태 칸 · 등록 접속 시험(`true`).

CLI(ssh-run.sh 가 부른다)
  server_allow.py check <원격 명령>                 바로면 0 · 물을 것이면 1 + 이유 한 줄(stdout)
  server_allow.py key <서버> <종류> <글…>           확인 요청 중복 방지 키 server-<종류>:<해시 12자>
  server_allow.py approved <요청 bin> <요청 id> <키> [<사용 기록 파일>]
                                                    그 요청이 이 키 · 답 "실행" · 60분 안 · 아직 안 쓴 승인이면 0 — 쓴 것으로 적고(한 번만) answered 면 요청을 닫는다
  server_allow.py secret <경로>                     비밀값이 들 수 있는 파일 이름이면 0(ssh-run.sh --get · --put 이 부른다)
  server_allow.py protected <경로>                  쓰면 물을 경로(sudoers · /etc/passwd 무리 · /etc/ssh · .ssh · /dev)면 0 + 이유(ssh-run.sh --put 이 부른다)
"""
import datetime
import fcntl
import fnmatch
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
# SECRET_PATH 의 폴더 — cd 로 간 곳을 모를 때 상대 경로를 이 아래로 넣어 본다(SECRET_PATH 와 같이 고친다)
SECRET_DIRS = ('.docker', '.kube')
# 값을 보이면 비밀값이 나올 수 있는 변수 이름(따옴표 밖 · 큰따옴표 안의 $이름 · ${이름})
SECRET_VAR = re.compile(r'TOKEN|SECRET|PASSW|PASSPHRASE|API_?KEY|PRIVATE|CREDENTIAL|AUTH', re.IGNORECASE)

SEPARATORS = {';', '&&', '||', '|', '|&', '&', '(', ')', ';;', '((', '))'}
WRITE_REDIRECTS = {'>', '>>', '>|', '&>', '&>>'}
# 명령 자리에 오는 셸 낱말 — 건너뛰고 다음 낱말이 명령
KEYWORDS = {'{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'for', 'case', 'esac', 'in', 'time', 'coproc'}
# 셸 · 감싸기 안을 다시 보는 깊이
DEPTH_MAX = 6

POWER = {'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'telinit', 'kexec'}
SYSTEMCTL_POWER = {'reboot', 'poweroff', 'halt', 'kexec', 'soft-reboot', 'suspend', 'hibernate', 'hybrid-sleep', 'suspend-then-hibernate', 'rescue', 'emergency'}
# systemctl start · isolate 로 켜면 재부팅 · 전원 끄기가 되는 대상(isolate 는 확장자 없이 줘도 .target 이다) · 그 대상이 부르는 systemd-*.service — 2026-11-28 PR #382 · #384 리뷰
POWER_UNIT = re.compile(r'^((reboot|poweroff|halt|kexec|soft-reboot|ctrl-alt-del|runlevel[06])(\.target)?|systemd-(reboot|poweroff|halt|kexec|soft-reboot)(\.service)?)$')
# 대상 이름을 줘도 켜지 않는 systemctl 동사 — 보기만
SYSTEMCTL_READ = {'status', 'show', 'cat', 'help', 'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files'}
DISK = {'dd', 'umount', 'wipefs', 'gdisk', 'cfdisk', 'mkswap', 'swapoff', 'losetup'}
# 목록 보기 옵션이 있으면 바로인 디스크 도구
DISK_LIST = {'fdisk': {'-l', '--list'}, 'sfdisk': {'-l', '--list'}, 'parted': {'-l', '--list'}}
USERS = set('useradd userdel usermod passwd visudo sudoedit vipw vigr chpasswd chage adduser deluser addgroup delgroup '
            'groupadd groupdel groupmod gpasswd'.split())
IPTABLES = {'iptables', 'ip6tables', 'iptables-legacy', 'ip6tables-legacy', 'iptables-nft', 'ip6tables-nft'}
# iptables 보기 꼴 — 이 낱말 · 표 이름만
IPTABLES_READ = {'-L', '-S', '-n', '-v', '-x', '--list', '--list-rules', '--line-numbers', '--numeric', '--verbose', '--exact', '-t', '--table',
                 'filter', 'nat', 'mangle', 'raw', 'security', 'INPUT', 'OUTPUT', 'FORWARD', 'PREROUTING', 'POSTROUTING'}
FIREWALL_READ = ('--list', '--get', '--query', '--state', '--version', '--info', '--zone', '--permanent')
# 쓰는 곳이 목적지 하나인 명령(원본은 읽기) — 마지막 이름 인자 · -t 폴더
COPY_LIKE = {'cp', 'install', 'ln', 'rsync'}
# 이름 인자 모두를 쓰는 곳으로 보는 명령
WRITERS = {'mv', 'tee', 'touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'patch'}
# 벗겨 낼 감싸기 — 값을 받는 옵션 글자(짧은 옵션)
WRAPPERS = {
    'sudo': 'ugpCDrtUhRT', 'doas': 'uC', 'nohup': '', 'nice': 'n', 'ionice': 'cnpP', 'timeout': 'sk', 'stdbuf': 'ioe',
    'setsid': '', 'exec': 'a', 'command': '', 'builtin': '', 'xargs': 'adEeIiLlnPs', 'watch': 'nqd', 'chrt': 'p', 'taskset': 'c',
    'unbuffer': '', 'flock': 'wEc', 'caffeinate': 'w', 'busybox': '', 'systemd-run': 'upEHMs',
}
# 값을 다음 낱말로 받는 긴 옵션(--unit x) — 그 감싸기만
WRAPPER_LONG = {'systemd-run': {'--unit', '--property', '--setenv', '--description', '--slice', '--uid', '--gid', '--nice', '--working-directory',
                                '--machine', '--host', '--service-type', '--on-active', '--on-boot', '--on-startup', '--on-unit-active',
                                '--on-unit-inactive', '--on-calendar', '--timer-property', '--path-property', '--socket-property'}}
# 첫 이름 인자를 하나 더 건너뛰는 감싸기(timeout <시간> · chroot <폴더> · flock <파일> · chrt <우선순위> · taskset <마스크>)
WRAPPER_FIRST = {'timeout': 1, 'chroot': 1, 'flock': 1, 'chrt': 1, 'taskset': 1}
# .ssh 폴더 아래 이름을 줘도 바로인 명령 — 목록 · 정보 보기만(cat · tar · cp 로 키를 읽는 것은 묻는다)
SSH_LISTERS = {'ls', 'stat', 'du', 'find', 'file', 'test', '[', 'namei', 'realpath', 'readlink', 'tree', 'mkdir', 'chmod', 'chown', 'ssh-keygen'}
# 파일 내용을 읽어 보이는 명령 — 경로가 치환($( ) · 백틱)으로 정해지면 비밀 파일인지 알 수 없으니 묻는다(2026-11-27 PR #382 리뷰)
READERS = set('cat tac nl less more head tail grep egrep fgrep zgrep rg sed awk gawk cut sort uniq paste jq yq base64 base32 xxd od hexdump '
              'strings diff cmp comm tr fold column iconv zcat bzcat xzcat gzip bzip2 xz zstd tar zip cpio cp scp rsync dd source'.split())
SHELLS = {'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'su', 'runuser'}


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


# 비밀 파일 이름 보기 — glob(.e* · *.pem · .{a,b})이 이 이름에 맞으면 묻는다(* · .* 처럼 글자 없는 glob · *.json 같은 흔한 꼴은 빼고)
SECRET_SAMPLES = ('.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'id_ecdsa', '.npmrc', '.pgpass', '.netrc',
                  '.git-credentials', 'credentials', 'secret', 'authorized_keys', 'shadow',
                  'server.key', 'server.pem', 'cert.p12', 'environ')
# 낱말에 붙인 변수($1 · "$_" · ${X}) — 지우고 다시 본다(.e"$1"nv → .env)
SHELL_VAR = re.compile(r'\$(\{[^}]*\}|[A-Za-z_]\w*|[0-9@*#?$!_-])')


def glob_secret(piece):
    """마지막 조각이 비밀 이름에 맞는 glob 이면 참 — 중괄호는 펼쳐서"""
    name = piece.rstrip('/').rsplit('/', 1)[-1]
    if not re.search(r'[*?\[{]', name) or not re.sub(r'[*?\[\]{},.]', '', name):
        return False
    match = re.search(r'\{([^{}]*)\}', name)
    names = [name[:match.start()] + each + name[match.end():] for each in match.group(1).split(',')] if match else [name]
    return any(fnmatch.fnmatchcase(sample, each) for each in names for sample in SECRET_SAMPLES if re.search(r'[*?\[]', each) or each == sample)


def secret_piece(arg, cwds):
    """낱말 · 그 안의 공백 조각(sed 스크립트 '1r /x/.env' 같은 것) · glob · 붙인 변수를 지운 꼴 · cd 한 곳에 붙인 상대 경로에서 비밀 이름 — 없으면 None"""
    variants = [arg]
    if '$' in arg:
        bare = SHELL_VAR.sub('', arg)
        variants += [bare, bare.lstrip('/')] if arg.startswith('$') else [bare]
    for variant in variants:
        pieces = [variant] + (variant.split() if len(variant.split()) > 1 else [])
        for piece in pieces:
            if secret_arg(piece) or glob_secret(piece):
                return re.split(r'[/:=]', piece.rstrip('/'))[-1]
        if variant and not variant.startswith(('/', '~', '-')):
            for base in cwds:
                for prefix in SECRET_DIRS if base == '?' else (base,):
                    if secret_arg(posixpath.join(prefix, variant)):
                        return posixpath.join(prefix, variant)
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


def protected_path(path, cwds=None):
    """쓰면 물을 경로면 이유 — sudoers · /etc/passwd 무리 · /etc/ssh · .ssh(사용자 · 권한) · /dev(디스크 — /dev/null · stdout · stderr · tty 빼고).
    상대 경로는 cd 한 곳에 붙여서도 본다"""
    if not path:
        return None
    candidates = [path] + [posixpath.join(base, path) for base in cwds or () if base not in ('~', '?') and not path.startswith(('/', '~'))]
    for each in candidates:
        normal = '/' + posixpath.normpath(each).lstrip('/') if each.startswith('/') else posixpath.normpath(each)
        parts = normal.split('/')
        base = parts[-1]
        if '.ssh' in parts or base.startswith('sudoers') or base in ('passwd', 'shadow', 'group', 'gshadow') \
                or re.match(r'^/etc/(ssh|sudoers\.d)(/|$)', normal):
            return f'사용자 · 권한 파일 쓰기({path})'
        if re.match(r'^/dev/(?!(null|stdout|stderr|tty|fd/\d+)$)', normal):
            return f'디스크 — 장치 쓰기({path})'
    return None


def short_has(args, letters, long=()):
    """옵션 묶음(-rf)에 그 글자가 있나 · 긴 옵션(GNU 줄임 --rec 까지) — -- 뒤는 보지 않는다"""
    for arg in args:
        if arg == '--':
            return False
        if arg.startswith('--'):
            option = arg.partition('=')[0]
            if len(option) > 4 and any(each.startswith(option) for each in long):
                return True
        elif arg.startswith('-') and any(letter in arg[1:] for letter in letters):
            return True
    return False


def plain_args(args):
    return [arg for arg in args if arg == '-' or not arg.startswith('-')]


def dangerous(name, args, cwds):
    """감싸기를 벗긴 명령 하나 — 물을 것이면 이유"""
    first = next((arg for arg in args if not arg.startswith('-')), None)
    if name in POWER:
        return f'재부팅 · 전원 끄기({name})'
    if name == 'systemctl' and first in SYSTEMCTL_POWER:
        return f'재부팅 · 전원 끄기(systemctl {first})'
    if name == 'systemctl' and first not in SYSTEMCTL_READ:
        unit = next((arg for arg in plain_args(args)[1:] if POWER_UNIT.match(arg)), None)
        if unit:
            return f'재부팅 · 전원 끄기(systemctl {first} {unit})'
    if name.startswith('mkfs') or name in DISK:
        return f'디스크({name})'
    if name in DISK_LIST and not any(arg in DISK_LIST[name] for arg in args):
        return f'디스크({name})'
    if name == 'mount' and any(arg not in ('-l', '--show-labels') for arg in args):
        return '디스크(mount)'
    if name == 'ufw' and not (args[:1] == ['status'] or args[:2] == ['app', 'list'] or args in (['version'], ['--version'])):
        return f'방화벽 바꾸기(ufw {" ".join(args[:2])})'.replace(' )', ')')
    if name in IPTABLES and any(arg not in IPTABLES_READ for arg in args):
        return f'방화벽 바꾸기({name})'
    if name in ('iptables-restore', 'ip6tables-restore', 'ebtables', 'arptables'):
        return f'방화벽 바꾸기({name})'
    if name == 'nft' and plain_args(args)[:1] not in (['list'], ['--version']) and args != ['--version']:
        return '방화벽 바꾸기(nft)'
    if name == 'firewall-cmd' and any(not arg.startswith(FIREWALL_READ) for arg in args):
        return '방화벽 바꾸기(firewall-cmd)'
    if name in USERS:
        return f'사용자 · 권한({name})'
    if name == 'rm' and short_has(args, 'rR', ('--recursive',)):
        return '재귀 삭제(rm -r)'
    if name == 'find' and '-delete' in args:
        return '재귀 삭제(find -delete)'
    return secret_output(name, args) or write_target(name, args, cwds)


def secret_output(name, args):
    """환경 변수 · 자격 증명을 보이는 명령"""
    if name in ('env', 'printenv'):
        return f'비밀값 출력({name} — 환경 변수가 보인다)'
    if env_dump(name, args):
        return f'비밀값 출력({" ".join([name] + args)} — 환경 변수가 보인다)'
    # 컨테이너 안에서 돌리는 env · printenv(docker exec web env · kubectl exec web -- printenv)
    if name in ('docker', 'podman', 'nerdctl', 'kubectl', 'oc') and 'exec' in args and any(arg in ('env', 'printenv') for arg in args):
        return f'비밀값 출력({name} exec … env — 환경 변수가 보인다)'
    if name == 'ps' and any(re.fullmatch(r'[a-zA-Z]*e[a-zA-Z]*', arg) for arg in args) or name == 'ps' and any('env' in arg.lower() for arg in args):
        return '비밀값 출력(ps e — 환경 변수가 보인다)'
    words = plain_args(args)
    if name == 'systemctl' and words[:1] == ['show']:
        fields = [field.strip().lower() for index, arg in enumerate(args)
                  for value in [property_value(args, index)] if value is not None for field in value.split(',')]
        if not fields or short_has(args, 'a', ('--all',)):
            return 'systemctl show 는 -p 로 칸을 골라야(옵션 없는 show · -a 는 Environment 가 보인다)'
        if any(char in field for field in fields for char in '*?['):
            return 'systemctl show -p 의 glob(Environment 까지 보일 수 있다)'
        if any(field.startswith(('environment', 'setcredential', 'loadcredential')) and field != 'environmentfiles' for field in fields):
            return '비밀값 출력(systemctl show -p Environment)'
    if name in ('docker', 'podman', 'nerdctl') and ('inspect' in words[:2] or words[:2] == ['compose', 'config']):
        return f'비밀값 출력({name} {" ".join(words[:2])} — 환경 변수 값이 보인다)'
    if name in ('kubectl', 'k3s', 'oc'):
        if any(word.startswith(('secret', 'configmap', 'cm')) for word in words) and any(word in ('get', 'describe', 'edit') for word in words):
            return f'비밀값 출력({name} secret)'
    return None


def env_dump(name, args):
    """셸 변수를 통째로 내보내는 꼴 — 인자 없는 set · export · 이름 없는 export -p · declare · typeset(-f · -F 함수 목록은 빼고)"""
    if name == 'set':
        return not args
    if name not in ('export', 'declare', 'typeset') or plain_args(args):
        return False
    return not any(arg.startswith('-') and set(arg[1:]) <= {'f', 'F'} for arg in args)


def property_value(args, index):
    """systemctl show 의 -p · -P · --property 값 — 그 자리가 아니면 None"""
    arg = args[index]
    if arg in ('-p', '-P', '--property'):
        return args[index + 1] if index + 1 < len(args) else ''
    if arg.startswith('--property='):
        return arg.partition('=')[2]
    if re.match(r'^-[pP].', arg):
        return arg[2:]
    return None


def write_target(name, args, cwds):
    """쓰기 명령이 쓰는 곳 — 사용자 · 권한 파일 · 장치"""
    targets = []
    if name in COPY_LIKE:
        for index, arg in enumerate(args):
            if arg in ('-t', '--target-directory') and index + 1 < len(args):
                targets.append(args[index + 1])
            elif arg.startswith('--target-directory='):
                targets.append(arg.partition('=')[2])
        targets += plain_args(args)[-1:]
    elif name in WRITERS or name == 'sed' and short_has(args, 'i', ('--in-place',)):
        targets = plain_args(args)
    elif name == 'dd':
        targets = [arg[3:] for arg in args if arg.startswith('of=')]
    elif name == 'uniq':
        targets = plain_args(args)[1:2]
    # 출력 파일 옵션(sort -o · curl -o · wget -O · git log --output) · sed 스크립트의 w 파일
    targets += output_options(name, args)
    for target in targets:
        why = protected_path(target, cwds)
        if why:
            return why
    return None


def output_options(name, args):
    """출력 파일을 받는 옵션 값 — 그 명령만"""
    shorts = {'sort': 'o', 'curl': 'o', 'wget': 'O', 'tar': 'f'}.get(name, '')
    longs = {'sort': ('--output',), 'curl': ('--output',), 'wget': ('--output-document',), 'git': ('--output',)}.get(name, ())
    out = []
    for index, arg in enumerate(args):
        following = args[index + 1] if index + 1 < len(args) else ''
        if arg.startswith('--') and longs:
            option, has_value, value = arg.partition('=')
            if len(option) > 4 and any(each.startswith(option) for each in longs):
                out.append(value if has_value else following)
        elif shorts and re.match(rf'^-[a-zA-Z]*{shorts}', arg):
            rest = arg[arg.index(shorts, 1) + 1:]
            out.append(rest or following)
    if name == 'sed':
        out += [match.group(1) for arg in args for match in re.finditer(r'(?:^|[;\s/}])[wW]\s*(\S+)', arg)]
    return out


def unwrap(words):
    """감싸기(sudo · env · nohup · timeout · xargs …)와 앞 환경 값을 벗긴 (명령 이름, 인자) · 안에 다시 볼 셸 글자 목록"""
    inner = []
    while words:
        head = words[0]
        if head in KEYWORDS or re.match(r'^[A-Za-z_]\w*\+?=', head):
            words = words[1:]
            continue
        name = posixpath.basename(head)
        if name == 'env':
            rest = words[1:]
            while rest and (rest[0].startswith('-') or re.match(r'^[A-Za-z_]\w*=', rest[0])):
                if rest[0] in ('-u', '-C', '--unset', '--chdir') and len(rest) > 1:
                    rest = rest[1:]
                elif rest[0] in ('-S', '--split-string') and len(rest) > 1:
                    inner.append(rest[1])
                    rest = rest[1:]
                rest = rest[1:]
            if not rest:
                return 'env', words[1:], inner
            words = rest
            continue
        if name in WRAPPERS or name in WRAPPER_FIRST:
            values, rest = WRAPPERS.get(name, ''), words[1:]
            # command -v · -V 는 명령을 찾기만 한다(돌리지 않는다)
            if name == 'command' and command_lookup(rest):
                return name, words[1:], inner
            while rest and rest[0].startswith('-') and rest[0] != '-':
                option = rest[0]
                rest = rest[1:]
                if option == '--':
                    break
                if not option.startswith('--') and option[-1] in values and rest:
                    rest = rest[1:]
                elif option in WRAPPER_LONG.get(name, ()) and rest:
                    rest = rest[1:]
            rest = rest[WRAPPER_FIRST.get(name, 0):]
            if not rest:
                return name, words[1:], inner
            words = rest
            continue
        return name, words[1:], inner
    return '', [], inner


def command_lookup(args):
    """command 앞 옵션(-p · -v · -V 묶음)에 -v · -V 가 있으면 참 — 명령 이름 뒤 인자(rm -rfv)는 보지 않는다"""
    for arg in args:
        if not re.fullmatch(r'-[pvV]+', arg):
            return False
        if re.search(r'[vV]', arg):
            return True
    return False


def shell_strings(name, args):
    """안에 명령 글자를 받는 것 — sh -c '…' · su -c '…' · eval … · find -exec … ; 의 글자 목록"""
    if name in SHELLS:
        for index, arg in enumerate(args):
            if re.fullmatch(r'-[a-zA-Z]*c[a-zA-Z]*', arg) or arg == '--command':
                return args[index + 1:index + 2]
        return []
    if name == 'eval':
        return [' '.join(args)]
    if name == 'find':
        out, current = [], None
        for arg in args:
            if arg in ('-exec', '-execdir', '-ok', '-okdir'):
                current = []
            elif current is not None and arg in (';', '+', '\\;'):
                out.append(shlex.join(current))
                current = None
            elif current is not None:
                current.append(arg)
        if current:
            out.append(shlex.join(current))
        return out
    return []


def substitutions(command):
    """$( ) · <( ) · >( ) · 백틱 안의 글자 — 홑따옴표 안은 빼고(큰따옴표 안도 원격 셸이 돌린다)"""
    out, quote, index = [], None, 0
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif char == '\\':
            index += 1
        elif char == "'" and quote is None:
            quote = "'"
        elif char == '"':
            quote = None if quote == '"' else '"'
        elif char == '`':
            end = command.find('`', index + 1)
            out.append(command[index + 1:end if end > 0 else len(command)])
            index = end if end > 0 else len(command)
        elif char in '$<>' and command[index + 1:index + 2] == '(':
            depth, end = 0, index + 1
            while end < len(command):
                depth += {'(': 1, ')': -1}.get(command[end], 0)
                if depth == 0:
                    break
                end += 1
            out.append(command[index + 2:end])
        index += 1
    return out


def variable_reason(command):
    """홑따옴표 밖 $이름 · ${이름} 중 비밀값일 수 있는 이름"""
    quote, index = None, 0
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif char == '\\':
            index += 1
        elif char == "'" and quote is None:
            quote = "'"
        elif char == '"':
            quote = None if quote == '"' else '"'
        elif char == '$':
            match = re.match(r'\{?!?([A-Za-z_]\w*)', command[index + 1:])
            if match and SECRET_VAR.search(match.group(1)):
                return f'비밀값 출력(${match.group(1)})'
        index += 1
    return None


def tokens_of(command):
    """셸 낱말 — 따옴표가 맞지 않으면 공백 · 연산자로만 나눈다(판정 못 해도 바로 돈다)"""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.commenters = ''
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return re.findall(r'[;&|()<>]+|[^\s;&|()<>]+', command)


def check(command, depth=0):
    """원격 명령 글자 전체 — 바로면 None, 물을 것이면 이유. 이어 붙인 명령 · 치환 · 셸 안 글자를 모두 본다"""
    if not command.strip():
        return None if depth else '빈 명령'
    if depth > DEPTH_MAX:
        return '셸 안의 셸이 너무 깊다(판정 못 함)'
    for url in re.findall(r'https?://[^\s\'"`;|&()<>]+', command, re.IGNORECASE):
        if metadata_host(url):
            return f'클라우드 메타데이터 주소({url[:40]} — 자격 증명이 나온다)'
    reason = variable_reason(command)
    if reason:
        return reason
    for inner in substitutions(command):
        reason = check(inner, depth + 1)
        if reason:
            return reason
    cwds, names = set(), {}
    words, tokens, index = [], tokens_of(command.replace('\r', '\n').replace('\n', ' ; ')), 0
    while index <= len(tokens):
        token = tokens[index] if index < len(tokens) else ';'
        index += 1
        if token in WRITE_REDIRECTS or token == '<' or token in ('<>', '>&') and index < len(tokens) and not tokens[index].isdigit():
            target = tokens[index] if index < len(tokens) else ''
            index += 1
            if words and words[-1].isdigit():
                words.pop()
            why = secret_piece(target, cwds) and f'비밀 파일({secret_piece(target, cwds)})' or token != '<' and protected_path(target, cwds)
            if why:
                return why
            continue
        if token not in SEPARATORS and not all(char in ';&|()<>' for char in token):
            words.append(token)
            continue
        if words:
            reason = check_words(words, cwds, depth, names)
            if reason:
                return reason
        words = []
    return None


def check_words(words, cwds, depth, names):
    """명령 하나 — 감싸기를 벗기고 셸 안 글자는 다시 check. names 는 같은 줄에서 앞서 정한 변수 값(f=.env; cat $f)"""
    for word in words:
        assigned = re.match(r'^([A-Za-z_]\w*)\+?=(.*)$', word)
        if assigned:
            names[assigned.group(1)] = assigned.group(2)
    name, args, inner = unwrap(words)
    if name in ('export', 'declare', 'typeset', 'local', 'readonly') and not env_dump(name, args):
        return check_words(args, cwds, depth, names)
    if names:
        args = [SHELL_VAR.sub(lambda match: names.get(match.group(1).strip('{}'), match.group(0)), arg) if '$' in arg else arg for arg in args]
    for text in inner + shell_strings(name, args):
        reason = check(text, depth + 1)
        if reason:
            return reason
    if not name:
        return None
    if name == 'cd':
        target = plain_args(args)[:1]
        cwds.add(target[0] if target and target[0] != '-' else '?')
        return None
    if name in READERS and any(arg == '$' or '$(' in arg or '`' in arg for arg in args):
        return f'비밀 파일일 수 있음({name} 의 경로를 치환으로 정한다 — 판정 못 함)'
    # 비밀 파일 이름 — grep 의 -e <패턴> 자리 · 메타데이터 주소 · URL 은 파일이 아니다
    patterns = grep_patterns(name, args)
    for position, arg in enumerate(args):
        if position in patterns or re.match(r'^https?://', arg, re.IGNORECASE):
            continue
        bad = secret_piece(arg, cwds)
        if bad:
            return f'비밀 파일({bad})'
        if name not in SSH_LISTERS and '.ssh' in arg.rstrip('/').split('/') and not arg.startswith('-'):
            return f'비밀 파일(.ssh 폴더 읽기 — {arg[:40]})'
    if name in ('curl', 'wget'):
        # 주소처럼 생긴 것만(-m 10 같은 짧은 숫자 값은 빼고) — 점 · 콜론이 있거나 metadata · 0x 로 시작하거나 8자 이상 숫자
        hosts = [arg for arg in plain_args(args) if '.' in arg or ':' in arg or arg.lower().startswith(('metadata', '0x')) or len(arg) >= 8]
        bare = next((arg for arg in hosts if metadata_host('http://' + arg)), None)
        if bare:
            return f'클라우드 메타데이터 주소({bare[:40]} — 자격 증명이 나온다)'
    return dangerous(name, args, cwds)


def grep_patterns(name, args):
    """grep 무리의 -e <패턴> · --regexp=<패턴> 자리 — 파일이 아니라 찾을 글자라 비밀 이름 검사에서 뺀다(grep -e secret)"""
    spots, index = set(), 0
    if name not in ('grep', 'egrep', 'fgrep', 'zgrep', 'rg'):
        return spots
    while index < len(args):
        arg = args[index]
        if arg == '--':
            break
        if arg.startswith('--regexp='):
            spots.add(index)
        elif arg == '--regexp':
            spots.add(index + 1)
            index += 1
        elif arg.startswith('-') and not arg.startswith('--') and arg != '-':
            letters = arg[1:]
            position = next((spot for spot, letter in enumerate(letters) if letter in 'efmABCDd'), -1)
            if position >= 0 and letters[position] == 'e':
                spots.add(index if letters[position + 1:] else index + 1)
            if position >= 0 and not letters[position + 1:]:
                index += 1
        index += 1
    return spots


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
