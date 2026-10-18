// 언어팩 — 사전(src/i18n/<언어>.json)에서 문구를 고르고 자리를 채운다. main · 화면 · 트레이가 같이 쓴다.
// 화면(renderer)은 Node 도 번들러도 없어서 <script> 로 싣는다 — module 이 있으면 module.exports, 없으면 전역 StudioI18n.
//
// 사전: 평평한 키 → 문구 { "menu.file": "파일", "time.minutesAgo": "{n}분 전" }
//   자리 채우기는 {이름} 하나뿐이다(복수형·성별 규칙 없음). 값에 없는 자리는 {이름} 그대로 남긴다.
// 없는 키는 한국어 사전 → 키 이름 순으로 대신한다(화면이 비지 않게).
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.StudioI18n = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LANGUAGES = ['ko', 'en', 'ja', 'zh']
  const FALLBACK_LANGUAGE = 'ko' // 없는 키를 대신할 사전
  const UNKNOWN_LANGUAGE = 'en' // 네 언어 밖의 시스템 언어
  const PLACEHOLDER = /\{(\w+)\}/g

  // 'ko-KR' · 'zh_Hans_CN' · 'JA' → 'ko' · 'zh' · 'ja'. 네 언어가 아니면 null
  function normalize(locale) {
    if (typeof locale !== 'string') return null
    const base = locale.trim().toLowerCase().split(/[-_]/)[0]
    return LANGUAGES.includes(base) ? base : null
  }

  // 설정에 고른 언어가 있으면 그것, 없으면 시스템 언어(app.getLocale()), 둘 다 네 언어 밖이면 영어
  function pickLanguage(setting, systemLocale) {
    return normalize(setting) || normalize(systemLocale) || UNKNOWN_LANGUAGE
  }

  function fill(text, values) {
    if (!values || typeof values !== 'object') return text
    return text.replace(PLACEHOLDER, (whole, name) => {
      if (!Object.prototype.hasOwnProperty.call(values, name)) return whole
      const value = values[name]
      return value === undefined || value === null ? '' : String(value)
    })
  }

  function lookup(dictionary, key) {
    if (!dictionary || typeof dictionary !== 'object') return null
    const text = dictionary[key]
    return typeof text === 'string' ? text : null
  }

  // t(사전, 키, 값) — fallback 은 한국어 사전(main 은 ko.json 을, 화면은 preload 로 받은 것을 넘긴다)
  function t(dictionary, key, values, fallback) {
    const text = lookup(dictionary, key) ?? lookup(fallback, key) ?? key
    return fill(text, values)
  }

  // 사전 하나에 묶은 t — const say = translator(en, ko); say('menu.file')
  function translator(dictionary, fallback) {
    return (key, values) => t(dictionary, key, values, fallback)
  }

  // 기준 사전(한국어)과 키가 다른 곳 — 테스트 · 검사 스크립트용
  function keyDiff(base, other) {
    const baseKeys = Object.keys(base || {})
    const otherKeys = new Set(Object.keys(other || {}))
    const baseSet = new Set(baseKeys)
    return {
      missing: baseKeys.filter((key) => !otherKeys.has(key)),
      extra: [...otherKeys].filter((key) => !baseSet.has(key)),
    }
  }

  // 문구 안의 자리 이름 — 번역이 자리를 빠뜨렸는지 견줄 때
  function placeholders(text) {
    return [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]).sort()
  }

  return { LANGUAGES, FALLBACK_LANGUAGE, UNKNOWN_LANGUAGE, normalize, pickLanguage, t, translator, keyDiff, placeholders }
})
