// 에이전트 답 언어 — 앱 언어(보기 → 언어)를 본체 .claude/settings.local.json 의 language 에 적는다.
// Claude Code 는 이 값(설정 language)으로 답 언어를 정하고, 코어 훅(athena/scripts/hooks/language.py)이 메시지마다 다시 읽어
// Codex · 워크트리 위임 에이전트 · 켜 둔 세션에도 넣는다. 파일의 다른 설정은 그대로 둔다.
import path from 'node:path'

export const AGENT_LANGUAGES: Readonly<Record<string, string>> = { ko: 'korean', en: 'english', ja: 'japanese', zh: 'chinese' }

export function settingsFile(bodyDir: string): string {
  return path.join(bodyDir, '.claude', 'settings.local.json')
}

// JSON 객체(배열 · null 이 아닌)인가
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 지금 파일 내용(없으면 null) → 새로 쓸 내용. 바꿀 것이 없으면 null.
// 내용이 JSON 객체가 아니면(사용자가 고치다 깨뜨린 파일 등) 덮어쓰지 않고 null — 설정을 날리지 않는다
export function withLanguage(text: string | null, lang: string): string | null {
  const value = AGENT_LANGUAGES[lang]
  if (!value) return null
  let settings: Record<string, unknown> = {}
  if (text !== null && text.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!isObject(parsed)) return null
    settings = parsed
  }
  if (settings.language === value) return null
  return `${JSON.stringify({ ...settings, language: value }, null, 2)}\n`
}
