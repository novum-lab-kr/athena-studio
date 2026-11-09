const test = require('node:test')
const assert = require('node:assert/strict')
const status = require('../src/lib/server-status.mts')

// ssh-run.sh --status 와 같은 칸 나누기(athena/scripts/ssh-run.sh STATUS_COMMAND)
const SAMPLE = [
  '==load', '1.50 0.80 0.40 2/300 12345',
  '==cpu', '4',
  '==mem',
  '               total        used        free      shared  buff/cache   available',
  'Mem:      8000000000  3000000000  1000000000    10000000  4000000000  6000000000',
  'Swap:              0           0           0',
  '==disk', 'Filesystem     1024-blocks      Used Available Capacity Mounted on', '/dev/vda1         40000000  18000000  22000000      45% /',
  '==failed', 'backup.service loaded failed failed Nightly backup',
  '==running', '23',
  '==docker', 'web|running', 'db|running', 'worker|exited',
  '==end', '',
].join('\n')

test('서버 상태: 칸마다 읽기', () => {
  const read = status.parseStatus(SAMPLE)
  // CPU % 는 앞 읽기와의 차이(/proc/stat)로만 — 부하 ÷ 코어로 짐작하지 않는다(결정 D8)
  assert.equal(read.cpuPercent, null)
  assert.equal(read.counters, null) // 옛 코어는 ==stat 없음
  assert.equal(read.load1, 1.5)
  assert.equal(read.load5, 0.8)
  assert.equal(read.load15, 0.4)
  assert.equal(read.memPercent, 25) // (8 − 6) / 8
  assert.equal(read.diskPercent, 45)
  assert.deepEqual(read.failed, ['backup'])
  assert.equal(read.running, 23)
  // 옛 형식(이름|State) — 종료 코드를 모르니 주의로 센다
  assert.deepEqual(read.docker, { up: 2, total: 3, down: ['worker'], stopped: [] })
})

test('서버 상태: 일부러 끈 컨테이너는 주의로 세지 않는다(종료 코드)', () => {
  const read = status.parseStatus([
    '==docker',
    'web|running|Up 3 weeks (healthy)',
    'deskrpg|exited|Exited (143) 2 months ago',
    'job|exited|Exited (0) 1 day ago',
    'draft|created|Created',
    'crash|exited|Exited (1) 2 hours ago',
    'killed|exited|Exited (137) 5 minutes ago',
    'loop|restarting|Restarting (1) 3 seconds ago',
    'gone|dead|Dead',
    '==end', '',
  ].join('\n'))
  assert.deepEqual(read.docker, { up: 1, total: 8, down: ['crash', 'killed', 'loop', 'gone'], stopped: ['deskrpg', 'job', 'draft'] })
  // 시간 기록의 fail 도 주의할 것만
  assert.equal(status.historyPoint({ at: 1, status: read, web: null }).fail, 4)
})

test('서버 상태: 리눅스가 아니거나 도구가 없으면 빈 칸 · 끝 칸이 없으면 못 읽은 것', () => {
  const read = status.parseStatus('==load\n==cpu\n==mem\n==disk\n==failed\n==running\n0\n==docker\n==end\n')
  assert.equal(read.cpuPercent, null)
  assert.equal(read.memPercent, null)
  assert.equal(read.diskPercent, null)
  assert.deepEqual(read.failed, [])
  assert.equal(read.docker, null)
  assert.equal(status.parseStatus('==load\n1 1 1\n'), null)
})

test('서버 상태: ssh 실패 글 → 이유 이름만', () => {
  assert.equal(status.failReason('user@x: Permission denied (publickey).', false), 'key-needed')
  assert.equal(status.failReason('Host key verification failed.', false), 'host-key')
  assert.equal(status.failReason('ssh: Could not resolve hostname x', false), 'unreachable')
  assert.equal(status.failReason('ssh: connect to host x port 22: Operation timed out', false), 'unreachable')
  assert.equal(status.failReason('', true), 'timeout')
  assert.equal(status.failReason('뭔가 다른 것', false), 'failed')
})

test('서버 상태: pack.json servers[] 에서 이름 · 별칭이 올바른 것만', () => {
  const pack = { servers: [{ name: 'dukbae', host: 'dukbae-server', paths: [] }, { name: 'Bad Name', host: 'x' }, { name: 'ok', host: 'a b' }, null] }
  assert.deepEqual(status.packServers(pack), [{ name: 'dukbae', host: 'dukbae-server' }])
  assert.deepEqual(status.packServers({}), [])
  assert.deepEqual(status.packServers(null), [])
  // 별칭은 글자 · 숫자 · _ 로 시작 — 맨 앞 - (ssh 옵션 -oProxyCommand=…) · . 은 뺀다(보안 검토 높음2 · 코어 ssh-run.sh 와 같은 꼴)
  assert.deepEqual(status.packServers({ servers: [{ name: 'evil', host: '-oProxyCommand=touch_x' }, { name: 'dots', host: '.hidden' }, { name: 'ok', host: 'web_1.prod' }] }), [{ name: 'ok', host: 'web_1.prod' }])
})

// 늘린 칸 — 마운트마다 디스크 · SWAP · 켜진 시간 · 에러 로그 수 · 보안 업데이트 수
const WIDE = [
  '==load', '0.40 0.30 0.20 1/200 1',
  '==cpu', '2',
  '==mem',
  '               total        used        free      shared  buff/cache   available',
  'Mem:      4000000000  1000000000  1000000000           0  2000000000  3000000000',
  'Swap:     2000000000  1200000000   800000000',
  '==disk', 'Filesystem     1024-blocks      Used Available Capacity Mounted on', '/dev/vda1         40000000  18000000  22000000      45% /',
  '==disks', 'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/vda1         40000000  18000000  22000000      45% /',
  '/dev/vdb1        100000000  85000000  15000000      85% /data',
  '/dev/vda15          100000      6000     94000       6% /boot/efi',
  '==failed',
  '==running', '12',
  '==docker',
  '==uptime', '93784.52 180000.10',
  '==errors', '7',
  '==updates', '3',
  '==end', '',
].join('\n')

test('서버 상태: 마운트별 디스크 · SWAP · 켜진 시간 · 에러 · 업데이트', () => {
  const read = status.parseStatus(WIDE)
  assert.deepEqual(read.disks, [{ mount: '/', percent: 45 }, { mount: '/data', percent: 85 }, { mount: '/boot/efi', percent: 6 }])
  assert.equal(read.diskPercent, 85) // 가장 찬 마운트
  assert.equal(read.swapPercent, 60)
  assert.equal(read.uptimeSeconds, 93784)
  assert.equal(read.errors, 7)
  assert.equal(read.updates, 3)
  assert.equal(read.docker, null)
})

test('서버 상태: 늘린 칸이 없는 옛 코어 · SWAP 없음이면 빈 칸', () => {
  const read = status.parseStatus(SAMPLE)
  assert.deepEqual(read.disks, [])
  assert.equal(read.diskPercent, 45) // ==disk 로
  assert.equal(read.swapPercent, null) // 전체 0
  assert.equal(read.uptimeSeconds, null)
  assert.equal(read.errors, null)
  assert.equal(read.updates, null)
})

test('응답 확인 주소: http(s) 만 · 계정이 든 주소는 거절', () => {
  assert.equal(status.healthUrl('https://example.com/health'), 'https://example.com/health')
  assert.equal(status.healthUrl('http://example.com'), 'http://example.com/')
  assert.equal(status.healthUrl('https://user:pw@example.com/'), null)
  assert.equal(status.healthUrl('ftp://example.com/'), null)
  assert.equal(status.healthUrl('not a url'), null)
  assert.equal(status.healthUrl(42), null)
  // 이 맥 · 내부망 주소는 쓰지 않는다(공유 팩이 내부망 GET 을 시키지 못하게 · 보안 검토 M2)
  for (const url of ['http://localhost/', 'http://LOCALHOST.:8080/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0.0.0.0/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://printer.local/', 'http://app.localhost/']) assert.equal(status.healthUrl(url), null, url)
  for (const url of ['http://172.32.0.1/', 'https://203.0.113.10/', 'http://[2001:db8::1]/']) assert.notEqual(status.healthUrl(url), null, url)
  const targets = status.packTargets({ servers: [{ name: 'web', host: 'web-1', health: 'https://example.com/ok' }, { name: 'db', host: 'db-1', health: 'https://a:b@example.com' }, { name: 'x y', host: 'bad' }] })
  assert.deepEqual(targets, [{ name: 'web', host: 'web-1', health: 'https://example.com/ok' }, { name: 'db', host: 'db-1', health: null }])
})

test('기록: 읽은 것만 숫자로 · 주소 · 이름 없음', () => {
  const read = status.parseStatus(WIDE)
  const point = status.historyPoint({ name: 'web', host: 'web-1', status: read, web: { ok: true, code: 200, ms: 180, certDate: null, certDays: null }, at: 1000 })
  assert.deepEqual(point, { t: 1000, cpu: null, mem: 25, swap: 60, disk: 85, ms: 180, fail: 0, load: 0.4, rx: null, tx: null, counters: null })
  assert.equal(status.historyPoint({ name: 'web', host: 'web-1', status: { ok: false, reason: 'timeout' }, web: null, at: 1000 }), null)
  // sar 를 읽는 서버 — 디스크 · 응답 시간 · 실패 수만(CPU · 메모리 · 스왑 · 부하 · 송수신 · 누적 값은 sar 몫)
  const lean = status.historyPoint({ name: 'web', host: 'web-1', status: read, web: { ok: true, code: 200, ms: 180, certDate: null, certDays: null }, at: 1000 }, true)
  assert.deepEqual(lean, { t: 1000, cpu: null, mem: null, swap: null, disk: 85, ms: 180, fail: 0, load: null, rx: null, tx: null })
  assert.ok(!('counters' in lean))
  assert.ok(!status.historyText([point]).includes('web'))
})

test('기록: 7일 지난 줄 · 깨진 줄은 빼고 시간 순', () => {
  const now = Date.UTC(2026, 10, 8)
  const day = 24 * 60 * 60 * 1000
  const text = [
    JSON.stringify({ t: now - 8 * day, cpu: 1, mem: 1, swap: null, disk: 1, ms: null, fail: 0 }),
    JSON.stringify({ t: now - 1000, cpu: 30, mem: 40, swap: null, disk: 50, ms: 100, fail: 1 }),
    '{"t": 12',
    JSON.stringify({ t: now - day, cpu: 10, mem: 20, swap: 5, disk: 50, ms: null, fail: 0 }),
  ].join('\n')
  const points = status.parseHistory(text, now)
  assert.deepEqual(points.map((point) => point.t), [now - day, now - 1000])
  // 옛 줄의 cpu(부하 ÷ 코어)는 버린다 · 새 줄(counters 칸 있음)은 그대로
  assert.equal(points[0].cpu, null)
  assert.equal(status.parseHistory(JSON.stringify({ t: now - 1000, cpu: 30, mem: 1, swap: null, disk: 1, ms: null, fail: 0, counters: null }), now)[0].cpu, 30)
  assert.equal(status.parseHistory(status.historyText(points), now).length, 2)
})

test('기록 그래프: 칸마다 평균 · 점이 없는 칸은 null', () => {
  const now = 10 * 60 * 60 * 1000
  const step = (60 * 60 * 1000) / 15 // 1시간 = 4분 칸 15개
  const at = (cell) => now - 60 * 60 * 1000 + cell * step + 1000
  const points = [
    { t: at(0), cpu: 10, mem: 50, swap: null, disk: 40, ms: 100, fail: 0 },
    { t: at(0) + 1000, cpu: 20, mem: 50, swap: null, disk: 40, ms: null, fail: 0 },
    { t: at(14), cpu: 90, mem: 60, swap: null, disk: 41, ms: 300, fail: 0 },
    { t: now - 2 * 60 * 60 * 1000, cpu: 99, mem: 99, swap: null, disk: 99, ms: 999, fail: 0 }, // 구간 밖
  ]
  const series = status.bucketHistory(points, '1h', now)
  assert.equal(series.cpu.length, 15)
  assert.equal(series.cpu[0], 15)
  assert.equal(series.ms[0], 100) // null 은 평균에 넣지 않는다
  assert.equal(series.cpu[1], null)
  assert.equal(series.cpu[14], 90)
  assert.equal(status.bucketHistory([], '7d', now).disk.length, 168)
})

// 지금 코어 STATUS_COMMAND 의 칸(실제 서버 출력 모양 · 이름은 가짜)
const FULL = [
  '==load', '2.50 1.20 0.90 3/400 999',
  '==cpu', '4',
  '==stat', 'cpu  1000 50 450 8000 500 0 100 0 0 0',
  '==mem',
  '               total        used        free      shared  buff/cache   available',
  'Mem:     16000000000  4000000000  2000000000           0 10000000000 12000000000',
  'Swap:     4000000000  1000000000  3000000000',
  '==disk', 'Filesystem       1-blocks         Used    Available Capacity Mounted on', '/dev/sda1  200000000000 120000000000  80000000000      60% /',
  '==disks', 'Filesystem     1024-blocks      Used Available Capacity Mounted on', '/dev/sda1      195312500 117187500  78125000      60% /',
  '==net',
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 9999999    100    0    0    0     0          0         0  9999999     100    0    0    0     0       0          0',
  '  eth0: 5000000   4000    0    0    0     0          0         0  2000000    3000    0    0    0     0       0          0',
  'docker0: 777777     10    0    0    0     0          0         0   777777      10    0    0    0     0       0          0',
  'vethab12: 55555     10    0    0    0     0          0         0    55555      10    0    0    0     0       0          0',
  'br-1a2b3c: 4444     10    0    0    0     0          0         0     4444      10    0    0    0     0       0          0',
  '  ens5: 1000000   900    0    0    0     0          0         0   500000     800    0    0    0     0       0          0',
  '==os', 'PRETTY_NAME="Ubuntu 24.04.4 LTS"',
  '==kernel', '6.8.0-100-generic',
  '==failed',
  '==services', 'cron.service', 'docker.service', 'ssh.service',
  '==docker',
  'web|running|Up 3 weeks (healthy)|shop-web:1a2b|shop',
  'db|running|Up 3 weeks|postgres:16|shop',
  'old|exited|Exited (143) 2 months ago|shop-old:9|shop',
  'lone|exited|Exited (1) 2 hours ago|busybox|',
  '==stats',
  'web|12.50%|418MiB / 15.62GiB|2.61%|28.2MB / 103MB|2.46GB / 2.03GB',
  'db|0.30%|1.5GiB / 15.62GiB|9.60%|1.1kB / 0B|512kB / 20MB',
  '==top', 'node 13.9 0.2', 'Web Content 4.0 1.5', 'postgres 1.1 3.0',
  '==detect', 'pm2', 'lxc', 'strange',
  '==uptime', '3600.00 1000.00',
  '==errors', '0',
  '==updates', '0',
  '==end', '',
].join('\n')

test('서버 상태: 부하 1·5·15 · 누적 값 · 크기 · OS · 서비스 이름 · 컨테이너 · 프로세스 · 감지', () => {
  const read = status.parseStatus(FULL)
  assert.deepEqual([read.load1, read.load5, read.load15], [2.5, 1.2, 0.9])
  // 바쁜 tick = 전체 − idle − iowait
  assert.equal(read.counters.total, 10100)
  assert.equal(read.counters.busy, 1600)
  // 루프백 · docker0 · veth · br- 는 빼고 eth0 + ens5
  assert.equal(read.counters.rx, 6000000)
  assert.equal(read.counters.tx, 2500000)
  assert.equal(read.memTotal, 16000000000)
  assert.equal(read.swapTotal, 4000000000)
  assert.deepEqual(read.rootDisk, { used: 120000000000, total: 200000000000 })
  assert.equal(read.diskPercent, 60)
  assert.equal(read.os, 'Ubuntu 24.04.4 LTS')
  assert.equal(read.kernel, '6.8.0-100-generic')
  assert.deepEqual(read.services, ['cron', 'docker', 'ssh'])
  assert.equal(read.running, 3)
  assert.deepEqual(read.docker, { up: 2, total: 4, down: ['lone'], stopped: ['old'] })
  const web = read.containers.find((row) => row.name === 'web')
  assert.equal(web.project, 'shop')
  assert.equal(web.image, 'shop-web:1a2b')
  assert.equal(web.state, 'up')
  assert.deepEqual(web.stats, { cpu: 12.5, memUsed: 418 * 1024 ** 2, memLimit: Math.round(15.62 * 1024 ** 3), memPercent: 2.61, rx: 28200000, tx: 103000000, read: 2460000000, write: 2030000000 })
  const lone = read.containers.find((row) => row.name === 'lone')
  assert.equal(lone.project, null)
  assert.equal(lone.state, 'down')
  assert.equal(lone.stats, null) // 꺼진 컨테이너는 stats 없음
  assert.equal(read.containers.find((row) => row.name === 'old').state, 'stopped')
  assert.deepEqual(read.top, [{ name: 'node', cpu: 13.9, mem: 0.2 }, { name: 'Web Content', cpu: 4, mem: 1.5 }, { name: 'postgres', cpu: 1.1, mem: 3 }])
  assert.deepEqual(read.detected, ['pm2']) // 아는 이름만 · lxc 는 늘 깔려 있어 뺀다(D10)
})

test('서버 상태: docker 크기 글 → 바이트(1000 · 1024 단위)', () => {
  assert.equal(status.sizeBytes('0B'), 0)
  assert.equal(status.sizeBytes('1.1kB'), 1100)
  assert.equal(status.sizeBytes('2MB'), 2000000)
  assert.equal(status.sizeBytes(' 1KiB '), 1024)
  assert.equal(status.sizeBytes('1.5GiB'), 1.5 * 1024 ** 3)
  assert.equal(status.sizeBytes('--'), null)
  assert.equal(status.sizeBytes(undefined), null)
})

test('서버 상태: 앞 읽기와의 차이 — CPU % · 받은 · 보낸 바이트', () => {
  const read = status.parseStatus(FULL)
  const before = { t: 1000, counters: { busy: 1000, total: 8100, rx: 5000000, tx: 2000000 } }
  const rated = status.withRates(read, 1000 + 180000, before)
  assert.equal(rated.cpuPercent, 30) // 600 / 2000
  assert.equal(rated.rxBytes, 1000000)
  assert.equal(rated.txBytes, 500000)
  // 앞 읽기가 없거나 · 15분보다 오래됐거나 · 값이 줄었으면(다시 켜짐) 내지 않는다
  assert.equal(status.withRates(read, 5000, null).cpuPercent, null)
  assert.equal(status.withRates(read, 1000 + status.RATE_GAP_MS + 1, before).cpuPercent, null)
  const rebooted = status.withRates(read, 181000, { t: 1000, counters: { busy: 9000, total: 90000, rx: 9e9, tx: 9e9 } })
  assert.equal(rebooted.cpuPercent, null)
  assert.equal(rebooted.rxBytes, null)
  // 기록에 누적 값을 남겨 다음에 이어 쓴다
  const point = status.historyPoint({ name: 'web', host: 'web-1', status: rated, web: null, at: 181000 })
  assert.equal(point.cpu, 30)
  assert.equal(point.load, 2.5)
  assert.equal(point.rx, 1000000)
  const points = status.parseHistory(status.historyText([point, { ...point, t: 182000, counters: null }]), 200000)
  assert.deepEqual(status.lastCounters(points), { t: 181000, counters: read.counters })
  assert.equal(status.lastCounters([]), null)
})

test('기록 그래프: 부하 · 수신 · 송신도 칸마다', () => {
  const now = 10 * 60 * 60 * 1000
  const point = { t: now - 1000, cpu: null, mem: null, swap: null, disk: null, ms: null, fail: 0, load: 1.5, rx: 300, tx: 100 }
  const series = status.bucketHistory([point, { ...point, t: now - 2000, load: 0.5, rx: null }], '1h', now)
  assert.equal(series.load[14], 1)
  assert.equal(series.rx[14], 300)
  assert.equal(series.tx[14], 200) // 수신 · 송신은 칸 안의 합
  assert.equal(status.bucketStart('1h', now, 0), now - 60 * 60 * 1000)
  assert.equal(status.bucketStart('1h', now, 14), now - 4 * 60 * 1000)
  // 옛 기록(load · rx · tx 칸 없음)은 빈 칸
  assert.equal(status.bucketHistory(status.parseHistory(JSON.stringify({ t: now - 1000, cpu: 5, mem: 5, swap: null, disk: 5, ms: null, fail: 0 }), now), '1h', now).load[14], null)
})

test('응답 확인 오류 코드 → 이유 이름', () => {
  assert.equal(status.webFailReason('CERT_HAS_EXPIRED'), 'cert')
  assert.equal(status.webFailReason('DEPTH_ZERO_SELF_SIGNED_CERT'), 'cert')
  assert.equal(status.webFailReason('ERR_TLS_CERT_ALTNAME_INVALID'), 'cert')
  assert.equal(status.webFailReason('ENOTFOUND'), 'unreachable')
  assert.equal(status.webFailReason('ECONNREFUSED'), 'unreachable')
  assert.equal(status.webFailReason('EPIPE'), 'failed')
  assert.equal(status.webFailReason(undefined), 'failed')
})

test('위쪽 카드 줄 — 1열 서버 자원 · 2열 네트워크, 빠지면 그 줄 안에서만 나눈다(D11)', () => {
  const spans = (keys) => status.metricRows(keys).map((row) => row.map((card) => `${card.key}:${card.span}`))
  assert.deepEqual(spans(['cpu', 'load', 'mem', 'disk', 'rx', 'tx', 'ms']), [['cpu:3', 'load:3', 'mem:3', 'disk:3'], ['rx:4', 'tx:4', 'ms:4']])
  // 응답 주소가 없으면 수신 · 송신 반반 — 디스크가 2열로 내려가지 않는다
  assert.deepEqual(spans(['cpu', 'load', 'mem', 'disk', 'rx', 'tx']), [['cpu:3', 'load:3', 'mem:3', 'disk:3'], ['rx:6', 'tx:6']])
  assert.deepEqual(spans(['cpu', 'mem']), [['cpu:6', 'mem:6']])
})

// ── 더한 칸(2026-11-09) — 실제 서버로는 확인하지 못했다. 출력 모양은 아래 원문(소스 · 공식 문서)대로 손으로 만든 것
// podman ps --format 의 .Names · .State · .Status · .Image · .Label — containers/podman docs/source/markdown/podman-ps.1.md.in
//   .State 는 libpod/define/containerstate.go 의 이름(created · initialized · running · stopped · paused · exited · removing · stopping · unknown)
//   .Status 는 cmd/podman/containers/ps.go Status() — 실행 중 "Up <시간>" · exited 와 stopped 는 "Exited (코드) <시간> ago"
//   compose 라벨은 podman-compose 가 붙인다(podman_compose.py 의 com.docker.compose.project)
// podman stats --format 의 .Name · .CPUPerc · .MemUsage · .MemPerc · .NetIO · .BlockIO — podman-stats.1.md.in · 퍼센트 "%.2f%%" · 크기는 go-units HumanSize(1000 단위)
// kubectl get pods -A --no-headers — kubernetes pkg/printers/internalversion/printers.go(NAME · READY "x/y" · STATUS 이유 · RESTARTS "N" 또는 "N (5m ago)" · AGE) · -A 면 NAMESPACE 가 맨 앞
// supervisorctl status — supervisor/supervisorctl.py _show_statuses('%(namespec)-Ns%(state)-10s%(desc)s') · 상태 이름 supervisor/states.py · 오류 글도 stdout
// pm2 ls — pm2 lib/API/UX/pm2-ls.js(머리 id · name · namespace · version · mode · pid · uptime · ↺ · status · cpu · mem · user · watching · 앱 표 다음 "Module(s)" 표)
//   mem 은 lib/API/UX/helpers.js bytesToSize(1024 단위 · "45.2mb ") · cpu 는 "N%" · 표 테두리는 cli-tableau(│ ─ ┌ ┐ └ ┘)
const PM2_LS = [
  '┌────┬──────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐',
  '│ id │ name     │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │',
  '├────┼──────────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤',
  '│ 0  │ api      │ default     │ 1.0.0   │ fork    │ 1234     │ 2D     │ 3    │ \u001b[32monline\u001b[39m    │ 0.5%     │ 45.2mb   │ deploy   │ disabled │',
  '│ 1  │ worker   │ default     │ 1.0.0   │ cluster │ 0        │ 0      │ 15   │ errored   │ 0%       │ 0b       │ deploy   │ disabled │',
  '│ 2  │ cron     │ default     │ N/A     │ fork    │ 0        │ 0      │ 0    │ stopped   │ N/A      │ N/A      │ deploy   │ disabled │',
  '└────┴──────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘',
  'Module',
  '┌────┬──────────────┬─────────┬──────────┬──────────┬──────┬──────────┬──────────┬──────────┐',
  '│ id │ module       │ version │ pid      │ status   │ ↺    │ cpu      │ mem      │ user     │',
  '├────┼──────────────┼─────────┼──────────┼──────────┼──────┼──────────┼──────────┼──────────┤',
  '│ 3  │ pm2-logrotate│ 2.7.0   │ 99       │ online   │ 0    │ 0.1%     │ 60.0mb   │ deploy   │',
  '└────┴──────────────┴─────────┴──────────┴──────────┴──────┴──────────┴──────────┴──────────┘',
]
const MORE = [
  '==load', '0.50 0.40 0.30 1/200 999',
  '==stat', 'cpu  1000 0 500 8000 500 0 0 0 0 0',
  '==stat2', 'cpu  1060 0 520 8100 520 0 0 0 0 0',
  '==podman',
  'web|running|Up 2 hours|docker.io/library/nginx:1.27|shop',
  'job|stopped|Exited (0) 3 days ago|quay.io/acme/job:2|',
  'crash|exited|Exited (1) 5 minutes ago|quay.io/acme/crash:1|',
  '.ok',
  '==podstats', 'web|1.25%|20.5MB / 2.08GB|0.99%|1.2kB / 3.4kB|0B / 4.1MB',
  '==pods',
  'default       api-7d9f8c-x2x1k          1/1   Running            0             3d',
  'default       api-7d9f8c-q8w2z          1/2   Running            4 (5m ago)    3d',
  'kube-system   coredns-5d78c9869d-abcde  0/1   CrashLoopBackOff   12 (1m ago)   9d',
  'jobs          backup-28710000-zz9kp     0/1   Completed          0             2h',
  'default       web-0                     0/1   Init:0/2           0             10s',
  '.ok',
  '==supervisor',
  'nginx                            RUNNING   pid 1234, uptime 2 days, 3:04:05',
  'queue:queue_00                   FATAL     Exited too quickly (process log may have details)',
  'cron                             STOPPED   Not started',
  'mailer                           STARTING  ',
  '==pm2', ...PM2_LS, '.ok',
  '==detect', 'pm2', 'podman', 'kubectl', 'supervisorctl',
  '==end', '',
].join('\n')

test('서버 상태: podman · kubectl 파드 · supervisor · pm2 · 1초 CPU', () => {
  const read = status.parseStatus(MORE)
  // stat → stat2: 바쁜 tick 1500 → 1580(+80) · 전체 10000 → 10200(+200)
  assert.equal(read.cpuPercent, 40)
  assert.deepEqual(read.podman.map((row) => [row.name, row.project, row.state]), [['web', 'shop', 'up'], ['job', null, 'stopped'], ['crash', null, 'down']])
  assert.deepEqual(read.podman[0].stats, { cpu: 1.25, memUsed: 20500000, memLimit: 2080000000, memPercent: 0.99, rx: 1200, tx: 3400, read: 0, write: 4100000 })
  assert.deepEqual(read.pods.map((pod) => [pod.namespace, pod.name, pod.state, pod.restarts]), [
    ['default', 'api-7d9f8c-x2x1k', 'running', 0],
    ['default', 'api-7d9f8c-q8w2z', 'partial', 4],
    ['kube-system', 'coredns-5d78c9869d-abcde', 'error', 12],
    ['jobs', 'backup-28710000-zz9kp', 'stopped', 0],
    ['default', 'web-0', 'partial', 0],
  ])
  assert.deepEqual(read.supervisor, [
    { name: 'nginx', state: 'running', reason: 'RUNNING' },
    { name: 'queue:queue_00', state: 'error', reason: 'FATAL' },
    { name: 'cron', state: 'stopped', reason: 'STOPPED' },
    { name: 'mailer', state: 'partial', reason: 'STARTING' },
  ])
  // 앱 표만(뒤 Module 표는 안 읽는다) · 1024 단위 · N/A 는 null · 색 글자는 걷어 낸다
  assert.deepEqual(read.pm2, [
    { name: 'api', state: 'running', reason: 'online', cpu: 0.5, mem: Math.round(45.2 * 1024 ** 2), restarts: 3 },
    { name: 'worker', state: 'error', reason: 'errored', cpu: 0, mem: 0, restarts: 15 },
    { name: 'cron', state: 'stopped', reason: 'stopped', cpu: null, mem: null, restarts: 0 },
  ])
  assert.deepEqual(read.detected, []) // 다 읽었으면 '못 읽은 도구' 없음
  // 1초 값이 있으면 앞 읽기 차이보다 먼저
  const before = { t: 1000, counters: { busy: 0, total: 1000, rx: null, tx: null } }
  assert.equal(status.withRates(read, 2000, before).cpuPercent, 40)
})

test('서버 상태: 도구가 있어도 못 읽으면(실패 · 권한 · pm2 데몬 없음) 못 읽은 도구로', () => {
  const read = status.parseStatus([
    '==podman', // podman ps 가 0 이 아니게 끝나 .ok 없음
    '==pods', // kubectl 이 권한 없음 · 연결 실패
    '==supervisor', 'Server requires authentication', 'unix:///var/run/supervisor.sock no such file',
    '==pm2', // ~/.pm2/pm2.pid 없음 — 부르지 않는다
    '==detect', 'pm2', 'podman', 'kubectl', 'supervisorctl',
    '==end', '',
  ].join('\n'))
  assert.equal(read.podman, null)
  assert.equal(read.pods, null)
  assert.equal(read.supervisor, null)
  assert.equal(read.pm2, null)
  assert.deepEqual(read.detected, ['pm2', 'podman', 'kubectl', 'supervisorctl'])
  // 읽었지만 비었으면 [] — 못 읽은 도구가 아니다
  const empty = status.parseStatus(['==podman', '.ok', '==pods', '.ok', '==detect', 'podman', 'kubectl', '==end', ''].join('\n'))
  assert.deepEqual([empty.podman, empty.pods, empty.detected], [[], [], []])
  // stat2 가 없는 옛 코어 — 1초 값 없음
  assert.equal(status.parseStatus(['==stat', 'cpu  1 0 1 1 0 0 0 0', '==end', ''].join('\n')).cpuPercent, null)
})

// ssh-run.sh --history 출력 — sysstat 소스(master)로 만든 모양: 머리 줄 common.c print_gal_header("%s %s (%s) \t%s \t_%s_\t(%d CPU)") ·
// 날짜는 S_TIME_FORMAT=ISO 라 "%Y-%m-%d"(set_report_date) · 행 시각 "%H:%M:%S"(sa_common.c set_record_timestamp_string) ·
// 칸 이름 activity.c hdr_line(CPU … %idle · runq-sz … ldavg-1 · kbmemfree … %memused · IFACE … rxkB/s txkB/s) · 재시작 줄 sar.c "  LINUX RESTART\t(%u CPU)"
// 실제 서버 출력은 아직 못 봄(사용자 확인 요청 r-20261109-085004-5640)
const SAR = [
  '==tz', '+0900',
  '==sa',
  'Linux 6.8.0-147-generic (novum) \t2026-11-08 \t_x86_64_\t(4 CPU)',
  '',
  '23:40:01        CPU     %user     %nice   %system   %iowait    %steal     %idle',
  '23:50:01        all     10.00      0.00      5.00      0.00      0.00     85.00',
  '',
  '23:40:01      runq-sz  plist-sz   ldavg-1   ldavg-5  ldavg-15   blocked',
  '23:50:01            1       300      0.80      0.70      0.60         0',
  '',
  '23:40:01    kbmemfree   kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit   %commit  kbactive   kbinact   kbdirty',
  '23:50:01      1000000   6000000   2000000     40.00     10000   3000000   4000000     20.00   2000000   2000000       100',
  '',
  '23:40:01        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil',
  '23:50:01           lo      5.00      5.00    100.00    100.00      0.00      0.00      0.00      0.00',
  '23:50:01         eth0     10.00      8.00      2.00      1.00      0.00      0.00      0.00      0.00',
  '23:50:01      veth1a2      1.00      1.00     50.00     50.00      0.00      0.00      0.00      0.00',
  'Average:         eth0     10.00      8.00      2.00      1.00      0.00      0.00      0.00      0.00',
  '==sa',
  'Linux 6.8.0-147-generic (novum) \t2026-11-09 \t_x86_64_\t(4 CPU)',
  '',
  '00:00:01        CPU     %user     %nice   %system   %iowait    %steal     %idle',
  '00:10:01        all     20,00      0,00     10,00      0,00      0,00     70,00',
  '00:20:01        all     30.00      0.00     10.00      0.00      0.00     60.00',
  '00:25:00       LINUX RESTART\t(4 CPU)',
  '00:30:01        all     30.00      0.00     10.00      0.00      0.00     55.00',
  'Average:        all     25.00      0.00     10.00      0.00      0.00     65.00',
  '==sa',
  '==end', '',
].join('\n')

test('sar 기록: 날짜 · 시간대 · 활동별 칸 · 가상 장치 빼기 · 재시작 · 쉼표 소수', () => {
  const now = Date.UTC(2026, 10, 9, 0, 0, 0) // 11-09 09:00 +0900
  const points = status.parseSar(SAR, now)
  const at = (hour, minute) => Date.UTC(2026, 10, 8, hour, minute, 1) // 서버 시각 −9시간
  // 23:50:01 +0900 = 14:50:01 UTC · 구간은 다음 행이 없어 활동 첫 행 — 앞 · 뒤 행이 없으면 버린다
  assert.equal(points.find((point) => point.t === at(14, 50)), undefined)
  // 11-09 00:10 · 00:20 은 한 흐름(10분) · 00:30 은 재시작 뒤 혼자라 버린다
  const ten = points.find((point) => point.t === at(15, 10))
  const twenty = points.find((point) => point.t === at(15, 20))
  assert.deepEqual(ten, { t: at(15, 10), span: 600_000, cpu: 30, load: null, mem: null, rx: null, tx: null })
  assert.equal(twenty.cpu, 40)
  assert.equal(points.length, 2)
  // 시간대 줄이 없으면 아무것도 쓰지 않는다
  assert.deepEqual(status.parseSar(SAR.replace('==tz\n+0900\n', ''), now), [])
})

test('sar 기록: 네트워크 바이트 · sar 가 있는 칸은 sar 값 · 없는 칸만 이 맥 기록', () => {
  const lines = SAR.split('\n')
  // 23:50 행 앞에 23:40 행을 하나 더 — 구간 10분
  const extra = (head, row) => lines.splice(lines.indexOf(head) + 1, 0, row)
  extra('23:40:01        CPU     %user     %nice   %system   %iowait    %steal     %idle', '23:40:01        all     10.00      0.00      5.00      0.00      0.00     85.00')
  extra('23:40:01        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil', '23:40:01         eth0     10.00      8.00      2.00      1.00      0.00      0.00      0.00      0.00')
  const now = Date.UTC(2026, 10, 8, 15, 0, 1)
  const points = status.parseSar(lines.join('\n'), now)
  const last = points.find((point) => point.t === Date.UTC(2026, 10, 8, 14, 50, 1))
  // eth0 만(lo · veth 빼고) — 2 KiB/s × 600초 = 1,228,800 바이트 · 메모리 = %memused · 부하 = ldavg-1
  assert.deepEqual([last.rx, last.tx, last.mem, last.load, last.cpu], [1228800, 614400, 40, 0.8, 15])
  // 1시간 그래프 — sar 가 덮는 칸은 sar 값(옛 이 맥 기록 77 은 안 씀) · sar 가 아직 없는 마지막 칸만 이 맥 값 · 디스크는 늘 이 맥 기록
  const own = [{ t: now - 60_000, cpu: 99, mem: 10, swap: 0, disk: 50, ms: null, fail: 0, load: 3, rx: 500, tx: 500 }, { t: now - 10 * 60_000, cpu: 77, mem: 10, swap: 0, disk: 40, ms: null, fail: 0, load: 3, rx: null, tx: null }]
  const series = status.bucketHistory(own, '1h', now, points)
  assert.equal(series.cpu[14], 99)
  assert.equal(series.cpu[12], 15)
  assert.equal(series.disk[12], 40)
  // 바이트는 구간이 겹친 비율로 나눠 담는다 — 다 더하면 두 행 합
  const total = series.rx.slice(0, 14).reduce((sum, value) => sum + (value ?? 0), 0)
  assert.equal(total, 1228800 * 2)
  // fill 이 없으면 예전과 같다
  assert.deepEqual(status.bucketHistory(own, '1h', now), status.bucketHistory(own, '1h', now, []))
})

test('sar 기록: 실제 서버 출력 발췌(novum-lab sa08 · 2026-11-09 사용자 승인 r-20261109-085004-5640)', () => {
  // `sar -u -q -n DEV -f /var/log/sysstat/sa08 -s 22:00:00 -e 23:00:00` 출력에서 줄만 골라 옮겼다 — 호스트 이름은 가짜로,
  // 그때는 S_TIME_FORMAT=ISO 없이 돌려 머리 날짜가 "11/08/26" 이었다 → 앱 명령(ISO)의 날짜 모양 "2026-11-08" 로 바꿔 넣음(common.c set_report_date)
  const real = [
    '==tz', '+0900', '==sa',
    'Linux 6.8.0-147-generic (server) \t2026-11-08 \t_x86_64_\t(4 CPU)',
    '',
    '22:00:01        CPU     %user     %nice   %system   %iowait    %steal     %idle',
    '22:10:01        all     10.47      0.01      6.03      0.10      1.98     81.41',
    '22:20:00        all     10.46      0.01      5.97      0.09      1.49     81.97',
    'Average:        all     10.42      0.01      5.96      0.09      1.49     82.03',
    '',
    '22:00:01      runq-sz  plist-sz   ldavg-1   ldavg-5  ldavg-15   blocked',
    '22:10:01            0      1357      0.80      0.77      0.78         0',
    '22:20:00            6      1366      1.03      1.01      0.90         0',
    'Average:            2      1361      0.71      0.79      0.79         0',
    '',
    '22:00:01        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil',
    '22:10:01           lo      2.77      2.77      5.16      5.16      0.00      0.00      0.00      0.00',
    '22:10:01         eth0     60.05     26.98     78.67      2.67      0.00      0.00      0.00      0.00',
    '22:10:01    br-512cbadce8c7      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00',
    '22:10:01      docker0      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00',
    '22:10:01    veth2bd63d1      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00',
    '22:20:00           lo      2.99      2.99      5.64      5.64      0.00      0.00      0.00      0.00',
    '22:20:00         eth0     62.57     29.12     81.19      2.78      0.00      0.00      0.00      0.00',
    '22:20:00    br-512cbadce8c7      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00',
    '22:20:00      docker0      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00',
    '22:20:00    veth2bd63d1      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00',
    'Average:         eth0     62.15     28.18     79.80      2.66      0.00      0.00      0.00      0.00',
    '==end', '',
  ].join('\n')
  const points = status.parseSar(real, Date.UTC(2026, 10, 9, 0, 0, 0))
  assert.equal(points.length, 2)
  const [first, second] = points
  // 22:10:01 은 다음 행까지(599초) · 22:20:00 은 앞 행부터 — 이 맥 /proc/net/dev 읽기와 같은 규칙(lo · br- · docker · veth 빼고 eth0 만)
  assert.deepEqual(second, { t: Date.UTC(2026, 10, 8, 13, 20, 0), span: 599_000, cpu: 18.03, load: 1.03, mem: null, rx: Math.round(81.19 * 1024 * 599), tx: Math.round(2.78 * 1024 * 599) })
  assert.deepEqual([first.t, first.span, first.cpu, first.load, first.rx], [Date.UTC(2026, 10, 8, 13, 10, 1), 599_000, 18.59, 0.8, Math.round(78.67 * 1024 * 599)])
})
