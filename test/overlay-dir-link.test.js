// 폴더를 가리키는 팩 링크 지우기(athena/scripts/lib/overlay.mjs removeLink) — Node 24.5.0 은 rmSync 로 폴더 링크를 지우면
// ERR_FS_EISDIR 이라 업데이트(linkOverlay)가 되돌아갔다(gh194). 링크는 지워지고 팩 원본 폴더는 남아야 한다.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const overlayUrl = () => import(path.join(__dirname, '..', 'athena', 'scripts', 'lib', 'overlay.mjs'))

// 옛 구조 본체: docs/diagrams/guides 가 팩 폴더를 가리키는 폴더 링크
function fakeBody(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-dir-link-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const dir of ['packs/co/diagrams/guides', 'packs/co/docs/guides', 'packs/other/docs/guides', 'docs/diagrams']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, 'athena.config.json'), JSON.stringify({ pack: 'packs/co' }))
  fs.writeFileSync(path.join(root, 'packs/co/diagrams/guides/keep.txt'), 'x')
  fs.symlinkSync('../../packs/co/diagrams/guides', path.join(root, 'docs/diagrams/guides'))
  return root
}
const isLink = (file) => { try { return fs.lstatSync(file).isSymbolicLink() } catch { return false } }

test('removeLink — 폴더 링크는 링크만 지우고 원본은 남긴다', async (t) => {
  const { removeLink } = await overlayUrl()
  const root = fakeBody(t)
  removeLink(path.join(root, 'docs/diagrams/guides'))
  assert.equal(isLink(path.join(root, 'docs/diagrams/guides')), false)
  assert.ok(fs.existsSync(path.join(root, 'packs/co/diagrams/guides/keep.txt')))
})

test('removeLink — 없는 경로는 넘어가고 일반 파일은 지운다', async (t) => {
  const { removeLink } = await overlayUrl()
  const root = fakeBody(t)
  removeLink(path.join(root, 'nothing'))
  const file = path.join(root, 'plain.txt')
  fs.writeFileSync(file, 'x')
  removeLink(file)
  assert.equal(fs.existsSync(file), false)
})

test('linkOverlay — 이번 목록에 없는 옛 폴더 링크를 정리하고 팩 원본은 남긴다', async (t) => {
  const { linkOverlay } = await overlayUrl()
  const root = fakeBody(t)
  const result = linkOverlay(root)
  assert.ok(result.stale.includes('docs/diagrams/guides'))
  assert.equal(isLink(path.join(root, 'docs/diagrams/guides')), false)
  assert.ok(fs.existsSync(path.join(root, 'packs/co/diagrams/guides/keep.txt')))
})

test('linkOverlay — 다른 곳을 가리키는 폴더 링크를 교체한다', async (t) => {
  const { linkOverlay } = await overlayUrl()
  const root = fakeBody(t)
  fs.symlinkSync('../packs/other/docs/guides', path.join(root, 'docs/guides'))
  linkOverlay(root)
  assert.ok(fs.existsSync(path.join(root, 'packs/other/docs/guides')))
  assert.ok(fs.existsSync(path.join(root, 'packs/co/docs/guides')))
  assert.ok(!isLink(path.join(root, 'docs/guides')) || fs.readlinkSync(path.join(root, 'docs/guides')).includes('packs/co'))
})

test('unlinkOverlay — 폴더 링크를 걷고 팩 원본은 남긴다', async (t) => {
  const { unlinkOverlay } = await overlayUrl()
  const root = fakeBody(t)
  unlinkOverlay(root)
  assert.equal(isLink(path.join(root, 'docs/diagrams/guides')), false)
  assert.ok(fs.existsSync(path.join(root, 'packs/co/diagrams/guides/keep.txt')))
})
