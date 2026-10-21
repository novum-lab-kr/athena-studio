// 에이전트 답 언어 — 앱 언어(보기 → 언어)를 본체 .claude/settings.local.json 의 language 에 적는다.
// Claude Code 는 이 값(설정 language)으로 답 언어를 정하고, 코어 훅(athena/scripts/hooks/language.py)이 메시지마다 다시 읽어
// Codex · 워크트리 위임 에이전트 · 켜 둔 세션에도 넣는다. 파일의 다른 설정은 그대로 둔다.
const path = require('node:path')

const AGENT_LANGUAGES = { ko: 'korean', en: 'english', ja: 'japanese', zh: 'chinese' }

function settingsFile(bodyDir) {
  return path.join(bodyDir, '.claude', 'settings.local.json')
}

// 지금 파일 내용(없으면 null) → 새로 쓸 내용. 바꿀 것이 없으면 null.
// 내용이 JSON 객체가 아니면(사용자가 고치다 깨뜨린 파일 등) 덮어쓰지 않고 null — 설정을 날리지 않는다
function withLanguage(text, lang) {
  const value = AGENT_LANGUAGES[lang]
  if (!value) return null
  let settings = {}
  if (text !== null && text.trim() !== '') {
    try {
      settings = JSON.parse(text)
    } catch {
      return null
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  }
  if (settings.language === value) return null
  return `${JSON.stringify({ ...settings, language: value }, null, 2)}\n`
}

module.exports = { AGENT_LANGUAGES, settingsFile, withLanguage }
