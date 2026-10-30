// @ts-check
// TC 하나 돌리기 — BE 는 HTTP 요청, FE 는 Playwright. 결과는 { status, error } 로만 돌려준다(실패 원문은 가려서).
// 형식 정본: docs/knowledge/common/qa-flows.md
import { isDeepStrictEqual } from 'node:util'
import { maskText } from '../lib/mask.mjs'

const STEP_TIMEOUT_MS = 10_000
const ERROR_LIMIT = 2000

/** @param {unknown} value */
const typeName = (value) => {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

/**
 * 응답 모양 비교 — shape 의 글자는 타입 이름. 틀린 곳 목록을 돌려준다
 * @param {any} shape @param {any} value @param {string} [path]
 * @returns {string[]}
 */
export function shapeErrors(shape, value, path = '$') {
  if (typeof shape === 'string') return typeName(value) === shape ? [] : [`${path}: ${shape} 여야 하는데 ${typeName(value)}`]
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${path}: array 여야 하는데 ${typeName(value)}`]
    return shape[0] === undefined ? [] : value.flatMap((entry, index) => shapeErrors(shape[0], entry, `${path}[${index}]`))
  }
  if (typeName(value) !== 'object') return [`${path}: object 여야 하는데 ${typeName(value)}`]
  return Object.entries(shape).flatMap(([key, inner]) => shapeErrors(inner, value[key], `${path}.${key}`))
}

/**
 * 부분 일치 — expected 에 적은 값만 본다
 * @param {any} expected @param {any} value @param {string} [path]
 * @returns {string[]}
 */
export function bodyErrors(expected, value, path = '$') {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (typeName(value) !== 'object') return [`${path}: object 여야 하는데 ${typeName(value)}`]
    return Object.entries(expected).flatMap(([key, inner]) => bodyErrors(inner, value[key], `${path}.${key}`))
  }
  return isDeepStrictEqual(expected, value) ? [] : [`${path}: ${JSON.stringify(expected)} 여야 하는데 ${JSON.stringify(value)}`]
}

/** @param {unknown} error */
export const errorText = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  // Playwright 오류의 터미널 색 코드는 화면 · run.json 에 그대로 찍히니 뺀다
  return maskText(message.replace(/\u001b\[[0-9;]*m/g, '')).slice(0, ERROR_LIMIT)
}

/**
 * BE TC 하나 — 요청 → 상태 코드 · 응답 모양 · 값
 * @param {any} item @param {string} baseUrl
 */
export async function runBeCase(item, baseUrl) {
  const { method = 'GET', path, headers = {}, json } = item.request
  const init = { method, headers: { ...headers }, redirect: /** @type {const} */ ('manual'), signal: AbortSignal.timeout(STEP_TIMEOUT_MS) }
  if (json !== undefined) {
    Object.assign(init, { body: JSON.stringify(json) })
    init.headers['content-type'] ??= 'application/json'
  }
  try {
    const response = await fetch(new URL(path, baseUrl), init)
    const text = await response.text()
    const errors = response.status === item.expect.status ? [] : [`상태 코드 ${item.expect.status} 여야 하는데 ${response.status}`]
    if (item.expect.shape !== undefined || item.expect.body !== undefined) {
      let parsed
      try { parsed = JSON.parse(text) } catch { errors.push('응답이 JSON 이 아니에요') }
      if (parsed !== undefined) {
        if (item.expect.shape !== undefined) errors.push(...shapeErrors(item.expect.shape, parsed))
        if (item.expect.body !== undefined) errors.push(...bodyErrors(item.expect.body, parsed))
      }
    }
    if (!errors.length) return { status: 'pass', error: '' }
    return { status: 'fail', error: maskText(`${errors.join('\n')}\n응답: ${text.slice(0, 500)}`).slice(0, ERROR_LIMIT) }
  } catch (error) {
    return { status: 'fail', error: errorText(error) }
  }
}

/**
 * FE 단계 하나
 * @param {any} page @param {any} step @param {string} baseUrl
 */
async function runStep(page, step, baseUrl) {
  const timeout = STEP_TIMEOUT_MS
  if (step.goto !== undefined) return page.goto(new URL(step.goto, baseUrl).href, { timeout })
  if (step.click !== undefined) return page.locator(step.click).first().click({ timeout })
  if (step.fill !== undefined) return page.locator(step.fill).first().fill(step.value, { timeout })
  if (step.press !== undefined) return page.keyboard.press(step.press)
  if (step.expectVisible !== undefined) return page.locator(step.expectVisible).first().waitFor({ state: 'visible', timeout })
  if (step.expectHidden !== undefined) return page.locator(step.expectHidden).first().waitFor({ state: 'hidden', timeout })
  if (step.expectText !== undefined) return page.getByText(step.expectText).first().waitFor({ state: 'visible', timeout })
  if (step.expectUrl !== undefined) return page.waitForURL(`**${step.expectUrl}`, { timeout })
  if (step.mock !== undefined) {
    return page.route(step.mock, (/** @type {any} */ route) => route.fulfill({ status: step.status, contentType: 'application/json', body: JSON.stringify(step.json ?? {}) }))
  }
  throw new Error(`모르는 단계 ${JSON.stringify(step)}`)
}

/**
 * FE TC 하나 — 새 창에서 단계를 차례로. 끝나고 콘솔 오류가 있으면 실패(allowConsole 정규식에 맞는 것은 뺀다)
 * @param {any} item @param {any} browser @param {string} baseUrl
 */
export async function runFeCase(item, browser, baseUrl) {
  const context = await browser.newContext(item.viewport === 'mobile' ? { viewport: { width: 390, height: 844 } } : {})
  const page = await context.newPage()
  /** @type {string[]} */
  const consoleErrors = []
  const allowed = (item.allowConsole ?? []).map((/** @type {string} */ pattern) => new RegExp(pattern))
  const note = (/** @type {string} */ text) => { if (!allowed.some((/** @type {RegExp} */ pattern) => pattern.test(text))) consoleErrors.push(text) }
  page.on('console', (/** @type {any} */ message) => { if (message.type() === 'error') note(message.text()) })
  page.on('pageerror', (/** @type {Error} */ error) => note(error.message))
  try {
    for (const [index, step] of item.steps.entries()) {
      try {
        await runStep(page, step, baseUrl)
      } catch (error) {
        return { status: 'fail', error: `${index + 1}번째 단계 ${JSON.stringify(step)}\n${errorText(error)}` }
      }
    }
    if (consoleErrors.length) return { status: 'fail', error: maskText(`콘솔 오류:\n${consoleErrors.slice(0, 5).join('\n')}`).slice(0, ERROR_LIMIT) }
    return { status: 'pass', error: '' }
  } finally {
    await context.close()
  }
}
