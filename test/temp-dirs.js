// @ts-check
// 시험이 만드는 임시 폴더 — 그 시험 파일이 다 끝나면 지운다(npm test 가 tmpdir 에 폴더를 남기지 않게).
// node --test 는 시험 파일마다 프로세스가 따로라 after 는 불러온 파일의 시험이 모두 끝난 뒤 한 번 돈다
const { after } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** @type {string[]} */
const made = []

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * os.tmpdir() 아래 <prefix>XXXXXX 를 만들고 지울 목록에 올린다
 * @param {string} prefix
 * @returns {string}
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

module.exports = { tempDir }
