// 개발 앱 ⚙ 업데이트 — 앱이 꺼진 사이 도우미(scripts/dev-app.js restart)가 띄우는 맥 알림의 순수 로직
const test = require('node:test')
const assert = require('node:assert/strict')
const notice = require('../src/lib/update-notice.mts')

test('parseWaitLine: heavy.sh 잠금 대기 줄 → 무엇이 도는지 짧은 이름', () => {
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 0초 — 다른 무거운 명령이 도는 중: athena-studio-fe · /Users/x/athena/scripts/verify/syung.sh'), { kind: 'lock', what: 'syung.sh' })
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 30초 — 다른 무거운 명령이 도는 중: plus-web · pnpm --filter plus-web build'), { kind: 'lock', what: 'pnpm' })
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 0초 — 다른 무거운 명령이 도는 중: repo · npm install --include=dev'), { kind: 'lock', what: 'npm install' })
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 5초 — 다른 무거운 명령이 도는 중: ?'), { kind: 'lock', what: '?' })
})

test('parseWaitLine: 자리가 둘인 heavy.sh — 앞 자리 것의 이름', () => {
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 0초 — 다른 무거운 명령이 도는 중 — 자리1: athena-studio-fe · sleep 50 · 자리2: syung-app · xcodebuild -jobs 4 -workspace app.xcworkspace'), { kind: 'lock', what: 'sleep' })
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 30초 — 다른 무거운 명령이 도는 중 — 자리1: me · npm install --include=dev'), { kind: 'lock', what: 'npm install' })
})

test('parseWaitLine: 부하 대기 줄 · 대기 줄이 아니면 null', () => {
  assert.deepEqual(notice.parseWaitLine('⏳ 대기 0초 — 부하 12.3 > 한도 9.6 (코어 8)'), { kind: 'load', load: '12.3' })
  assert.equal(notice.parseWaitLine('▶ 차례 — 40초 기다림 · 부하 2.1/9.6'), null)
  assert.equal(notice.parseWaitLine('added 3 packages in 2s'), null)
  assert.equal(notice.parseWaitLine(''), null)
})

test('commandName: 실행기 · 환경 변수를 건너뛰고 스크립트 이름', () => {
  assert.equal(notice.commandName('me · ATHENA_VERIFY_DIR=/w bash /a/scripts/verify/athena-studio.sh'), 'athena-studio.sh')
  assert.equal(notice.commandName('me · sleep 90'), 'sleep')
  assert.equal(notice.commandName('me · node build.mjs'), 'build.mjs')
})

test('pickLanguage: 넘긴 언어 → 시스템 언어 → 영어', () => {
  assert.equal(notice.pickLanguage('ja', 'ko-KR'), 'ja')
  assert.equal(notice.pickLanguage('', 'zh-Hans-CN'), 'zh')
  assert.equal(notice.pickLanguage(undefined, 'fr-FR'), 'en')
})

test('noticeText: 네 언어 사전에서 문구 · 제목은 앱 업데이트', () => {
  for (const language of ['ko', 'en', 'ja', 'zh']) {
    const say = notice.translator(language)
    for (const event of [{ kind: 'lock', what: 'syung.sh' }, { kind: 'load', load: '12.3' }, { kind: 'gave-up' }, { kind: 'install-failed' }]) {
      const { title, body } = notice.noticeText(say, event)
      assert.equal(title, say('dialog.appUpdate.message'))
      assert.ok(body && !body.startsWith('notify.') && !/\{\w+\}/.test(body), `${language} ${event.kind}: ${body}`)
    }
  }
  assert.equal(notice.noticeText(notice.translator('ko'), { kind: 'lock', what: 'syung.sh' }).body, '업데이트 설치 대기 — syung.sh 도는 중')
})

test('notifyArgs: 글은 argv 로 — 따옴표가 스크립트에 섞이지 않는다', () => {
  const args = notice.notifyArgs('앱 "업데이트"', 'a\'b"c')
  assert.deepEqual(args.slice(-2), ['앱 "업데이트"', 'a\'b"c'])
  assert.ok(args.filter((arg, index) => args[index - 1] === '-e').every((script) => !script.includes('업데이트')))
})
