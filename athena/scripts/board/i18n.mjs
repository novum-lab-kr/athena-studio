// @ts-check
// 현황판 화면 문구 — 앱 언어를 따른다.
// Athena Studio 는 고른 언어를 본체 .claude/settings.local.json 의 language(korean · english · japanese · chinese)에 적는다
// (앱 src/lib/agent-language.mts · 코어 훅 scripts/hooks/language.py 가 같은 값을 읽는다). 현황판도 그 값을 읽는다.
// 값이 없거나 못 읽으면 한국어 — 문구 원본이 한국어라 사전도 한국어가 기준(빠진 말은 ko.json 으로)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const LANGUAGES = ['ko', 'en', 'ja', 'zh']
export const FALLBACK = 'ko'
const FROM_SETTING = /** @type {Record<string, string>} */ ({ korean: 'ko', english: 'en', japanese: 'ja', chinese: 'zh' })
// 화면 날짜 · 시간 표시
export const LOCALES = /** @type {Record<string, string>} */ ({ ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' })

/** @typedef {Record<string, string>} Dictionary */

/** @param {string} dir 사전 폴더(<언어>.json) @returns {Record<string, Dictionary>} */
export const readDictionaries = (dir) => Object.fromEntries(LANGUAGES.map((lang) => [lang, JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8'))]))

/** 본체의 지금 언어 @param {string} root 본체 폴더 */
export const languageOf = (root) => {
  try {
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
    return FROM_SETTING[String(settings?.language ?? '').trim().toLowerCase()] ?? FALLBACK
  } catch {
    return FALLBACK
  }
}

/** '{이름}' 자리를 값으로 — 값이 없는 자리는 그대로 둔다
 * @param {string} text @param {Record<string, unknown>} [values] */
export const format = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))

/** @param {Record<string, Dictionary>} dictionaries @param {string} lang */
export const translate = (dictionaries, lang) => /** @param {string} key @param {Record<string, unknown>} [values] */ (key, values) =>
  format(dictionaries[lang]?.[key] ?? dictionaries[FALLBACK]?.[key] ?? key, values)
