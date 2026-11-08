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
