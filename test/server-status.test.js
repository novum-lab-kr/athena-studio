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
  assert.equal(read.cpuPercent, 38) // 1.5 / 4
  assert.equal(read.load1, 1.5)
  assert.equal(read.memPercent, 25) // (8 − 6) / 8
  assert.equal(read.diskPercent, 45)
  assert.deepEqual(read.failed, ['backup'])
  assert.equal(read.running, 23)
  assert.deepEqual(read.docker, { up: 2, total: 3, down: ['worker'] })
})

test('서버 상태: 리눅스가 아니거나 도구가 없으면 빈 칸 · 끝 칸이 없으면 못 읽은 것', () => {
  const read = status.parseStatus('==load\n==cpu\n==mem\n==disk\n==failed\n==running\n0\n==docker\n==end\n')
  assert.equal(read.cpuPercent, null)
  assert.equal(read.memPercent, null)
  assert.equal(read.diskPercent, null)
  assert.deepEqual(read.failed, [])
  assert.equal(read.docker, null)
  assert.equal(status.parseStatus('==load\n1 1 1\n'), null)
  // 부하가 코어 수보다 크면 100 에서 자른다
  assert.equal(status.parseStatus('==load\n9 1 1\n==cpu\n2\n==end\n').cpuPercent, 100)
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
  assert.deepEqual(point, { t: 1000, cpu: 20, mem: 25, swap: 60, disk: 85, ms: 180, fail: 0 })
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

test('응답 확인 오류 코드 → 이유 이름', () => {
  assert.equal(status.webFailReason('CERT_HAS_EXPIRED'), 'cert')
  assert.equal(status.webFailReason('DEPTH_ZERO_SELF_SIGNED_CERT'), 'cert')
  assert.equal(status.webFailReason('ERR_TLS_CERT_ALTNAME_INVALID'), 'cert')
  assert.equal(status.webFailReason('ENOTFOUND'), 'unreachable')
  assert.equal(status.webFailReason('ECONNREFUSED'), 'unreachable')
  assert.equal(status.webFailReason('EPIPE'), 'failed')
  assert.equal(status.webFailReason(undefined), 'failed')
})
