// 제3자 고지(scripts/third-party-notices.js) — 가짜 package-lock · node_modules 로 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const notices = require('../scripts/third-party-notices')

/** 가짜 레포: 운영 의존성 alpha(LICENSE) · beta(LICENSE.md + NOTICE · 하위 자리에 같은 버전 한 번 더) · gamma(라이선스 파일 없음) · 깔리지 않은 선택 의존성 · dev 의존성 */
function fakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notices-test-'))
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  const manifest = (rel, body) => write(`${rel}/package.json`, JSON.stringify(body))
  write('package-lock.json', JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/alpha': { version: '1.0.0' },
      'node_modules/beta': { version: '2.0.0' },
      'node_modules/alpha/node_modules/beta': { version: '2.0.0' },
      'node_modules/gamma': { version: '3.0.0', optional: true },
      'node_modules/missing-optional': { version: '1.0.0', optional: true },
      'node_modules/devtool': { version: '9.0.0', dev: true },
      'node_modules/electron': { version: '44.0.0', dev: true },
    },
  }))
  manifest('node_modules/alpha', { name: 'alpha', version: '1.0.0', license: 'MIT', repository: { url: 'git+https://github.com/x/alpha.git' } })
  write('node_modules/alpha/LICENSE', 'MIT License\r\nCopyright (c) Alpha\r\n')
  manifest('node_modules/beta', { name: 'beta', version: '2.0.0', license: 'Apache-2.0', repository: 'https://github.com/x/beta' })
  write('node_modules/beta/LICENSE.md', 'Apache text')
  write('node_modules/beta/NOTICE', 'Beta notice')
  write('node_modules/beta/licensed-users.txt', '고지가 아니다')
  manifest('node_modules/alpha/node_modules/beta', { name: 'beta', version: '2.0.0', license: 'Apache-2.0' })
  manifest('node_modules/gamma', { name: 'gamma', version: '3.0.0', license: 'ISC' })
  manifest('node_modules/devtool', { name: 'devtool', version: '9.0.0', license: 'MIT' })
  write('node_modules/devtool/LICENSE', 'dev only')
  manifest('node_modules/electron', { name: 'electron', version: '44.0.0', license: 'MIT', repository: 'https://github.com/electron/electron' })
  write('node_modules/electron/LICENSE', 'Electron MIT')
  return root
}

test('운영 의존성만(dev · devOptional 빼고) · 하위 자리 포함', () => {
  const lock = { packages: { '': {}, 'node_modules/b': {}, 'node_modules/a': {}, 'node_modules/a/node_modules/c': {}, 'node_modules/d': { dev: true }, 'node_modules/e': { devOptional: true } } }
  assert.deepEqual(notices.listProductionPackages(lock), ['node_modules/a', 'node_modules/a/node_modules/c', 'node_modules/b'])
  assert.throws(() => notices.listProductionPackages({}), /packages/)
})

test('라이선스 파일 이름 — LICENSE · LICENCE · COPYING · NOTICE 와 그 확장자만', () => {
  for (const name of ['LICENSE', 'license.md', 'LICENCE.txt', 'LICENSE-MIT', 'COPYING', 'NOTICE']) assert.ok(notices.LICENSE_FILE_RE.test(name), name)
  for (const name of ['licensed-users.txt', 'README.md', 'package.json']) assert.ok(!notices.LICENSE_FILE_RE.test(name), name)
})

test('고지 파일 — 깔린 운영 의존성 원문 · 같은 이름 버전은 한 번 · Electron 은 Chromium 고지 자리를 가리킨다', () => {
  const root = fakeRepo()
  try {
    const out = path.join(root, 'dist', notices.FILE_NAME)
    const result = notices.writeNotices({ root, out, appVersion: '0.15.9' })
    assert.equal(result.count, 4) // electron + alpha · beta · gamma
    assert.deepEqual(result.withoutFile, ['gamma@3.0.0'])
    const text = fs.readFileSync(out, 'utf8')
    assert.match(text, /^Athena Studio 0\.15\.9 — Third-Party Notices/)
    assert.match(text, /electron 44\.0\.0\nLicense: MIT\nSource: https:\/\/github\.com\/electron\/electron/)
    assert.match(text, /Contents\/Resources\/LICENSES\.chromium\.html/)
    assert.match(text, /Electron MIT/)
    assert.match(text, /alpha 1\.0\.0\nLicense: MIT\nSource: https:\/\/github\.com\/x\/alpha\n/)
    assert.match(text, /MIT License\nCopyright \(c\) Alpha/) // 줄바꿈은 \n 으로
    assert.match(text, /LICENSE\.md\n-+\nApache text/)
    assert.match(text, /NOTICE\n-+\nBeta notice/)
    assert.equal(text.match(/^beta 2\.0\.0$/gm)?.length, 1)
    assert.match(text, /gamma 3\.0\.0\nLicense: ISC\n=+\n\n\(This package does not include a license file/)
    for (const absent of ['devtool', 'dev only', 'missing-optional', '고지가 아니다']) assert.ok(!text.includes(absent), absent)
    // 순서: Electron 다음 이름순
    assert.ok(text.indexOf('electron 44') < text.indexOf('alpha 1') && text.indexOf('alpha 1') < text.indexOf('beta 2') && text.indexOf('beta 2') < text.indexOf('gamma 3'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('node_modules/electron 이 없으면 만들지 않는다', () => {
  const root = fakeRepo()
  try {
    fs.rmSync(path.join(root, 'node_modules', 'electron'), { recursive: true })
    assert.throws(() => notices.collectPackages({ root }), /electron/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
