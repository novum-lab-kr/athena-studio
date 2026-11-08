#!/usr/bin/env python3
"""서버 명령 허용 목록 — 묻지 않고 돌려도 되는 **읽기 명령만** 고른다(계획서 Decisions "D2 바뀜" · 2026-11-08 사용자 "서버는 위험해서 엄격하게").

정해 둔 읽기 명령 · 정해 둔 옵션만 자유 · 나머지는 기본 막힘(→ ssh-run.sh 가 [작업] 확인 요청을 연다).
명령마다 **허용 옵션 목록**(SPECS)을 둔다 — 막는 옵션을 적는 대신 되는 옵션만 적는다(2026-11-08 보안 검토 높음1).
  - 묶은 짧은 옵션(-uo)은 글자마다 풀어 본다 · 값을 받는 글자 뒤는 값이다(-oFILE · -o FILE)
  - 긴 옵션은 **이름이 똑같을 때만** — 줄임(--out → --output)은 GNU · git 이 받아 주니 모두 막힌다
  - 이름 인자(파일 · 경로)와 옵션 값 모두 비밀 파일 이름 검사 · 따옴표 밖 * ? [ { } ~ 는 명령 전체에서 막힌다(원격 셸이 펼친다)
파이프 · ; · && · || 로 이어 붙인 것은 명령마다 다 본다. 그 밖에 막는 것(= 확인 받기):
  - 목록에 없는 명령(sh -c · bash · eval · xargs · tee · sed · awk 같은 "다른 명령을 돌릴 수 있는 것" 포함)
  - 쓰기 리다이렉트(> · >> — /dev/null 만 된다) · heredoc · 서브셸 ( ) · $( ) · 백틱 · <( ) · 백그라운드 & · 줄바꿈 · $ 변수
  - VAR=값 앞붙임 · 경로로 부른 명령(/tmp/x) · sudo 의 -n 밖 옵션 · sudo 뒤는 더 좁은 목록(SUDO_OK)
  - 환경 변수를 보이는 것(systemctl show · ps e · /proc/*/environ · jq 의 env — jq 는 목록에서 뺐다) · curl 의 GET/HEAD 밖 · http(s) 밖 주소
  - 리다이렉트 앞 fd 숫자는 원문에서 연산자에 바로 붙은 것(2> · 2>&1)만 — 띄어 쓴 숫자(date 11081200 >/dev/null)는 인자로 본다
비밀 파일 이름 검사는 흔한 이름만 막는다(.env · 키 · 인증서 · ssh_host_*_key · .docker/config.json · .kube/config …) — 모든 비밀 파일을 알지는 못한다.
쓰는 곳: scripts/ssh-run.sh(실행 전 판정 · 승인 확인) · 앱 서버 상태 칸 · 등록 접속 시험(`true`)도 이 목록 안의 명령만 쓴다.

CLI(ssh-run.sh 가 부른다)
  server_allow.py check <원격 명령>                 허용이면 0 · 아니면 1 + 이유 한 줄(stdout)
  server_allow.py key <서버> <종류> <글…>           확인 요청 중복 방지 키 server-<종류>:<해시 12자>
  server_allow.py approved <요청 bin> <요청 id> <키> [<사용 기록 파일>]
                                                    그 요청이 이 키 · 답 "실행" · 60분 안 · 아직 안 쓴 승인이면 0 — 쓴 것으로 적고(한 번만) answered 면 요청을 닫는다
  server_allow.py secret <경로>                     비밀값이 들 수 있는 파일 이름이면 0(ssh-run.sh --get · --put 이 부른다)
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


# 아무 셸이나 쓰는 읽기 명령 — 옵션은 여기 적은 것만. 쓰기 · 다른 파일 읽기 · 끝없이 도는 옵션(-f 따라가기 · -c 반복)은 뺐다
SPECS = {
    'ls': spec('aAlhdtrSR1inFsgocuUvGLHpQ', long='--all --almost-all --human-readable --directory --recursive --inode --numeric-uid-gid --size --full-time --color[=] --time-style= --sort= --block-size='),
    'stat': spec('Lft', 'c', '--dereference --file-system --terse --format= --printf='),
    'file': spec('bLhizkN', long='--brief --mime --mime-type --mime-encoding --dereference --no-dereference'),
    'wc': spec('lwcmL', long='--lines --words --bytes --chars --max-line-length'),
    'du': spec('shacLkmxb', 'd', '--summarize --human-readable --all --apparent-size --one-file-system --total --max-depth= --block-size='),
    'df': spec('hHPTlkmaiv', 'txB', '--human-readable --portability --print-type --local --all --inodes --total --type= --exclude-type= --output[=] --block-size='),
    'free': spec('bkmghltwv', long='--bytes --kilo --mega --giga --human --wide --total --si --lohi'),
    'uptime': spec('ps', long='--pretty --since'),
    'uname': spec('asnrvmpio', long='--all'),
    'whoami': spec(most=0),
    'id': spec('ugGnrz', long='--user --group --groups --name --real'),
    'groups': spec(),
    'pgrep': spec('lafxnovic', 'uUgGPts', '--list-name --list-full --full --exact --newest --oldest --count --inverse --ignore-case'),
    'pidof': spec('sxc', 'o'),
    'netstat': spec('tulpnaeirsWvxw', long='--tcp --udp --listening --programs --numeric --all --extend --interfaces --route --statistics --wide'),
    'lsblk': spec('afmpnlbsdiJrStO', 'oe', '--all --fs --perms --paths --list --bytes --json --output= --exclude='),
    'findmnt': spec('lnDrJAa', 'toT', '--list --noheadings --df --raw --json --types= --output= --target='),
    'lscpu': spec('aebcJxyp', long='--all --extended --json --hex --parse[=]'),
    'nproc': spec(long='--all --ignore=', most=0),
    'lsof': spec('nPltVbwR', 'ipuctsgd'),
    'vmstat': spec('asdDwtfmn', 'S', most=2),
    'iostat': spec('xcdkmhtNzy', 'p', most=2),
    'last': spec('naFxwiR', 'nst', digits=True),
    'w': spec('hisu', long='--no-header --short --ip-addr'),
    'who': spec('abdHlmpqrTtu', long='--all --boot --heading --count --runlevel --users'),
    'basename': spec('az', 's', '--multiple --zero --suffix='),
    'dirname': spec('z'),
    'readlink': spec('fenmqsvz', long='--canonicalize --canonicalize-existing --canonicalize-missing --no-newline'),
    'realpath': spec('esqmLPz', long='--canonicalize-existing --canonicalize-missing --quiet --no-symlinks'),
    'which': spec('a'),
    'type': spec('aftpP'),
    'true': spec(most=0),
    'echo': spec('neE'),
    'printf': spec(),
    'cut': spec('snz', 'bcdf', '--complement --only-delimited --bytes= --characters= --delimiter= --fields= --output-delimiter='),
    'tr': spec('cCdst', most=2),
    'column': spec('tnexJ', 'sco', '--table --separator= --output-separator= --json'),
    'getent': spec(),
    'dig': spec('46', 'xtcpq'),
    'nslookup': spec(most=2),
    'host': spec('aCdlrTvw46', 'tWcR'),
    'lsb_release': spec('aidrcs', long='--all --id --description --release --codename --short'),
    'sort': spec('bdfgiMhnRrsuVcCmz', 'ktS', '--numeric-sort --reverse --unique --human-numeric-sort --ignore-case --version-sort --stable --general-numeric-sort --month-sort --ignore-leading-blanks --dictionary-order --zero-terminated --check --merge --key= --field-separator='),
    'uniq': spec('cdDiuz', 'fsw', '--count --repeated --unique --ignore-case --zero-terminated --skip-fields= --skip-chars= --check-chars=', most=0),
    'tree': spec('adfiFlpsughDCnAJXrtvUQN', 'LPI', '--noreport --dirsfirst --du --prune --charset='),
    'ss': spec('tulpnaexmoiswH4601r', 'Af', '--tcp --udp --listening --processes --numeric --all --extended --memory --options --info --summary --no-header --resolve'),
    'ping': spec('nq46', 'cWwiIs'),
    'hostname': spec('IifsdAa', long='--all-ip-addresses --ip-address --fqdn --short --domain --all-fqdns', most=0),
    'date': spec('uRI', 'dr', '--utc --rfc-2822 --iso-8601[=] --rfc-3339= --date= --reference='),
    'hostnamectl': spec(most=1),
    'timedatectl': spec(most=1),
    'cat': spec('nbsAvETet'),
    'head': spec('qvz', 'nc', '--quiet --silent --verbose --lines= --bytes=', digits=True),
    'tail': spec('qvz', 'nc', '--quiet --silent --verbose --lines= --bytes=', digits=True),
    'grep': spec('inHhvwxclLqsEFGPabzoT', 'eABCm', '--ignore-case --line-number --count --invert-match --word-regexp --line-regexp --files-with-matches --files-without-match --fixed-strings --extended-regexp --basic-regexp --perl-regexp --only-matching --no-filename --with-filename --quiet --silent --text --color[=] --colour[=] --regexp= --max-count= --after-context= --before-context= --context=', digits=True),
    'zcat': spec('fq'),
    'diff': spec('uqybwiaEc', 'U', '--brief --unified[=] --ignore-all-space --ignore-space-change --ignore-case --text --side-by-side', most=2),
    'md5sum': spec('bt'),
    'sha256sum': spec('bt'),
    'journalctl': spec('kqraexmb', 'nouptSUg', '--no-pager --no-hostname --reverse --utc --quiet --list-boots --disk-usage --catalog --merge --all --dmesg --pager-end --boot[=] --lines[=] --unit= --since= --until= --priority= --output= --identifier= --grep= --user-unit=', digits=True),
    'systemctl': spec('alq', 'tno', '--no-pager --no-legend --plain --all --failed --full --quiet --type= --state= --lines= --output='),
    'docker': spec('aqsltv', 'np', '--all --quiet --no-trunc --no-stream --timestamps --digests --size --latest --verbose --format= --filter= --tail= --since= --until= --project-name='),
    'pm2': spec(long='--nostream --raw --err --out --no-color --lines='),
    'git': spec('sbvalrmodp', 'n', '--oneline --stat --shortstat --summary --name-only --name-status --graph --decorate --all --no-color --short --branch --porcelain[=] --abbrev-ref --show-toplevel --is-inside-work-tree --tags --long --always --merges --no-merges --first-parent --reverse --patch --no-patch --show-current --list --remotes --verbose --cached --others --modified --deleted --exclude-standard --untracked-files[=] --format= --pretty= --since= --until= --author= --grep= --max-count= --date= --contains= --merged= --no-merged= --sort= --points-at= --abbrev=', digits=True),
    'apt': spec('a', long='--installed --upgradable --all-versions'),
    'npm': spec('agl', long='--all --json --long --global --parseable --prod --production --depth='),
    'caddy': spec(long='--pretty --config= --adapter='),
}
# sudo 뒤에 올 수 있는 명령 — root 로 읽어야 하는 것만(더 좁게)
SUDO_OK = {'systemctl', 'journalctl', 'docker', 'ss', 'lsof', 'netstat', 'iptables', 'ufw', 'nginx', 'ls', 'du', 'cat', 'head', 'tail', 'grep', 'crontab'}
# 하위 명령까지 정한 것 — 첫 이름 인자가 이 안에 있어야(systemctl show · cat 은 Environment= 가 보여 확인 대상)
SUBCOMMANDS = {
    'systemctl': {'status', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'get-default'},
    'docker': {'ps', 'logs', 'images', 'stats', 'version', 'info', 'top', 'port', 'compose', 'network', 'volume', 'container', 'image', 'system'},
    'pm2': {'ls', 'list', 'status', 'logs'},
    'git': {'status', 'log', 'branch', 'rev-parse', 'describe', 'show', 'tag', 'ls-files'},
    'apt': {'list'},
    'npm': {'ls', 'list'},
    'caddy': {'version', 'validate', 'list-modules', 'adapt'},
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
}
# find 의 조건 — 값 없는 것 · 값 하나를 받는 것(-fprint · -exec · -delete … 는 없다)
FIND_FLAGS = {'-print', '-print0', '-ls', '-empty', '-xdev', '-mount', '-readable', '-executable', '-writable', '-not', '!', '-a', '-o', '-and', '-or', '-prune', '-true', '-false', '-L', '-H', '-P', '-depth'}
FIND_ARGS = {'-name', '-iname', '-path', '-ipath', '-wholename', '-type', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-maxdepth', '-mindepth', '-newer', '-user', '-group', '-perm', '-regex', '-iregex', '-links', '-samefile', '-printf', '-uid', '-gid'}
IP_OPTIONS = {'-br', '-brief', '-4', '-6', '-s', '-stats', '-c', '-color', '-d', '-details', '-j', '-json', '-p', '-pretty', '-o', '-oneline'}
IP_OBJECTS = {'a', 'addr', 'address', 'r', 'route', 'link', 'l', 'n', 'neigh', 'rule'}
IP_ACTIONS = {'show', 'list', 'ls', 'lst', 'get'}
IPTABLES_WORDS = {'-L', '-S', '-n', '-v', '--list', '--line-numbers', '-t', 'filter', 'nat', 'mangle', 'raw'}
# ps 의 BSD 꼴(대시 없는 aux) — e(환경 변수 보이기) · o(형식 값)는 없다
PS_BSD = set('auxwfjlrcSTh')
PS = spec('aAdefFlwHjLTMyNx', 'oOpuUgGtCsq', '--sort= --no-headers --forest --headers --format= --pid= --ppid= --user= --cols= --width=')


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


def check_find(args):
    index, seen_test = 0, False
    while index < len(args):
        arg = args[index]
        index += 1
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


def check_curl(args):
    """GET · HEAD 만 — -s -S -I -L -f -k -i -v · -o /dev/null · -w 형식 · 시간 제한 · http(s) 주소"""
    rule = spec('sSILfkiv', 'owmX', '--silent --show-error --head --location --fail --insecure --include --compressed --verbose --output= --write-out= --max-time= --connect-timeout= --request= --url=')
    reason, plain, values = parse('curl', args, rule)
    if reason:
        return reason
    urls = list(plain)
    for option, value in values:
        if option in ('-o', '--output') and value != '/dev/null':
            return 'curl -o 는 /dev/null 만'
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
    return f'curl 주소는 http(s):// 만({bad[:40]})' if bad else None


def check_sub(name, plain, values, args):
    """하위 명령 · 그 뒤 인자 — parse 를 지난 뒤"""
    first = plain[0] if plain else None
    if name in ('hostnamectl', 'timedatectl') and first is None:
        return None
    if first not in SUBCOMMANDS[name]:
        return f'{name} {first or ""}'.strip() + ' (읽기 하위 명령이 아니다)'
    rest = plain[1:]
    if name == 'docker':
        if first == 'stats' and '--no-stream' not in args:
            return 'docker stats 는 --no-stream 만'
        if first in DOCKER_SECOND and (not rest or rest[0] not in DOCKER_SECOND[first]):
            return f'docker {first} {rest[0] if rest else ""}'.strip() + ' (읽기 하위 명령이 아니다)'
    if name == 'git' and first in ('branch', 'tag') and rest and '-l' not in args and '--list' not in args:
        return f'git {first} 만들기 · 지우기'
    if name == 'pm2' and first == 'logs' and '--nostream' not in args:
        return 'pm2 logs 는 --nostream 만'
    if name in ('hostnamectl', 'timedatectl') and rest:
        return f'{name} {first} 뒤 인자'
    return None


def check_one(words, under_sudo=False):
    """명령 하나(낱말 목록) — 허용이면 None, 아니면 이유"""
    if not words:
        return '빈 명령'
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
        if rest[0] not in SUDO_OK:
            return f'sudo 로 돌리는 {rest[0]}(sudo 뒤는 더 좁은 목록)'
        return check_one(rest, under_sudo=True)
    name, args = words[0], words[1:]
    if '/' in name:
        return f'경로로 부른 명령({name})'
    for arg in args:
        if secret_arg(arg):
            return f'비밀값이 들 수 있는 파일({re.split(r"[/:=]", arg.rstrip("/"))[-1]})'
    if name == 'git':
        # git -C <폴더> … 만 — -c(설정 바꾸기 · 다른 명령 돌리기) · --git-dir 같은 앞 옵션은 없다
        while len(args) >= 2 and args[0] == '-C':
            args = args[2:]
        if args and args[0].startswith('-'):
            return f'git {args[0]}(앞 옵션은 -C 만)'
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
        return check_curl(args)
    if name == 'command':
        return None if len(args) >= 2 and args[0] == '-v' and not any(arg.startswith('-') for arg in args[1:]) else 'command 는 -v 만'
    if name == 'iptables':
        bad = next((arg for arg in args if arg not in IPTABLES_WORDS), None)
        return f'iptables {bad}' if bad else None
    if name == 'dpkg':
        return None if args and args[0] in ('-l', '--list', '-s', '--status') and not any(arg.startswith('-') for arg in args[1:]) else 'dpkg 는 -l · -s 만'
    if name not in SPECS:
        return f'허용 목록에 없는 명령({name})'
    reason, plain, values = parse(name, args, SPECS[name])
    if reason:
        return reason
    bad = next((value for _, value in values if secret_arg(value)), None)
    if bad:
        return f'비밀값이 들 수 있는 파일({re.split(r"[/:=]", bad.rstrip("/"))[-1]})'
    if name == 'date' and any(not arg.startswith('+') for arg in plain):
        return 'date 인자(시각 바꾸기)'
    if name == 'diff' and '-' in plain:
        return 'diff - (입력)'
    if name in SUBCOMMANDS:
        return check_sub(name, plain, values, args)
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


def check(command):
    """원격 명령 글자 전체 — 허용이면 None, 아니면 이유"""
    if not command.strip():
        return '빈 명령'
    if re.search(r'[\n\r]', command):
        return '줄바꿈(여러 줄 명령)'
    if '`' in command or '$' in command:
        return '$ · 백틱(변수 · 명령 치환)'
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
    words, index = [], 0
    while index < len(tokens):
        token = tokens[index]
        # 이 연산자 바로 앞에 붙은 fd 숫자 — 붙은 것만 fd(나머지 숫자는 그 명령의 인자)
        attached = marks.pop() if token and all(char in '();<>|&' for char in token) and any(op in token for op in '<>') else False
        if token in SEPARATORS:
            reason = check_one(words)
            if reason:
                return reason
            words, index = [], index + 1
            continue
        if token in WRITE_REDIRECTS:
            target = tokens[index + 1] if index + 1 < len(tokens) else ''
            if target != '/dev/null':
                return f'쓰기 리다이렉트({token} {target})'.strip()
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
    return check_one(words)


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
    print(__doc__.split('CLI')[1], file=sys.stderr)
    sys.exit(2)
