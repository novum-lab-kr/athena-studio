#!/usr/bin/env bash
# PR 자동 리뷰 시험 — 큰 diff(생성물 빼기 · 나누기 · 잘린 승인은 머지 승인 아님 · scripts/pr-auto.mjs buildPrompt)
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)

# ── 큰 diff — 생성물은 빼고 코드 파일부터 · 잘린 승인은 머지 승인 아님(이슈 20261025 · syung#12 · syung#23) ──
node --input-type=module - <<'EOF' || FAIL=1
import { packDiff, packDiffParts, partForPrompt, mergePartResults, splitDiff, generatedReason, globToRegExp, linguistGeneratedRules, linguistGenerated, missedFiles, dataLikeLine, repoGeneratedPatterns, omittedSection, partialApproval, partialCount, PARTIAL_APPROVAL, reviewComment, aggregate, validReview } from './scripts/lib/pr-auto.mjs'
import { buildPrompt } from './scripts/pr-auto.mjs'
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✔ ${name}`) } else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`) } }
// 한 사례의 잘게 쪼갠 검사를 하나로 센다 — 실패하면 어느 소검사인지 이름 · 자세히를 보인다
const group = (name, items) => { const bad = items.filter(([, ok]) => !ok); check(name, !bad.length, bad.map(([sub, , detail = '']) => `${sub}${detail ? ` — ${detail}` : ''}`).join('\n      ')) }
const fileDiff = (path, added, { status = 'modify' } = {}) => {
  const minus = status === 'add' ? '/dev/null' : `a/${path}`
  const plus = status === 'delete' ? '/dev/null' : `b/${path}`
  const sign = status === 'delete' ? '-' : '+'
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- ${minus}\n+++ ${plus}\n@@ -1,1 +1,${added.length} @@\n${added.map((line) => `${sign}${line}`).join('\n')}\n`
}
const LIMIT = 60_000
console.log('\n큰 diff 나누기')
// syung#23 재현 — 맨 앞 생성물 data/fare/bus_km.json(1.2 MB · 한 줄짜리 큰 JSON)이 diff 앞을 다 차지
const busKm = fileDiff('data/fare/bus_km.json', [`{${'"100100":12.3,'.repeat(90_000)}"x":0}`], { status: 'add' })
const code = fileDiff('src/fare.mjs', ['export const fare = (km) => Math.round(km * 100)', 'export const min = 1400'])
const test = fileDiff('test/fare.test.mjs', ['import { fare } from "../src/fare.mjs"', 'assert.equal(fare(1), 100)'])
const syung23 = busKm + code + test
const files = splitDiff(syung23)
group('splitDiff — 경로 · +/−줄 수 · 지운 파일은 a 경로 · 빈 글은 [] (syung#23 재현: 앞 6만 자엔 코드 파일이 없다)', [
  ['(재현 · 고치기 전) 앞에서 6만 자로 자르면 코드 파일이 하나도 안 들어간다', !syung23.slice(0, LIMIT).includes('src/fare.mjs') && syung23.length > 1_000_000],
  ['splitDiff — 파일 셋 · 경로 · +줄 수(새 파일 /dev/null 은 b 경로)', files.length === 3 && files.map((item) => item.path).join(',') === 'data/fare/bus_km.json,src/fare.mjs,test/fare.test.mjs' && files[1].added === 2 && files[0].added === 1, JSON.stringify(files.map(({ path, added, removed, longest }) => ({ path, added, removed, longest })))],
  ['splitDiff — 지운 파일은 a 경로 · −줄 · 빈 글은 []', splitDiff(fileDiff('old/x.js', ['a', 'b'], { status: 'delete' }))[0].path === 'old/x.js' && splitDiff(fileDiff('old/x.js', ['a', 'b'], { status: 'delete' }))[0].removed === 2 && splitDiff('').length === 0]
])
const packed = packDiff(syung23, { limit: LIMIT })
const omitted = omittedSection(packed)
group('syung#23 — 생성물(큰 JSON)은 본문 없이 목록에 · 코드 · 시험 파일은 들어감 · 프롬프트 목록 \'경로 · +N/−M줄 · 생성물이라 생략\'', [
  ['syung#23 — 생성물(큰 JSON)은 본문 없이 목록에 · 코드 · 시험 파일은 들어감 · 다 넣음(complete)', packed.complete && packed.text.includes('src/fare.mjs') && packed.text.includes('test/fare.test.mjs') && !packed.text.includes('100100') && packed.generated.length === 1 && packed.generated[0].path === 'data/fare/bus_km.json' && packed.generated[0].added === 1, JSON.stringify({ ...packed, text: packed.text.length })],
  ['프롬프트 목록 — "경로 · +N/−M줄 · 생성물이라 생략"', omitted.includes('`data/fare/bus_km.json` · +1/−0줄 · 생성물이라 생략(데이터 파일 · 아주 긴 줄') && !omitted.includes('⚠️'), omitted]
])
// syung#12 재현 — 코드 파일(web/index.html) 안에 한 줄로 박힌 큰 역 데이터
const html = fileDiff('web/index.html', ['<div aria-live="polite" id="sheet"></div>', `<script>const stationData=${'[1,2],'.repeat(20_000)}</script>`])
const account = fileDiff('server/account.mjs', ['export const login = () => true'])
const syung12 = packDiff(html + account, { limit: LIMIT })
// 코드로 보이는 긴 줄(압축 코드)은 앞부분만 넣으면 못 본 코드 — 잘린 것과 같이 불완전(PR #62 R1 확정 "데이터 모양 줄만 완전으로" · 라운드 1 · 2 지적 3)
const minified = fileDiff('web/app.js', ['// 짧은 줄', 'function a(b){return b.map(c=>c*2)};'.repeat(60)])
const codeLong = packDiff(minified + account, { limit: LIMIT })
const codeLongText = omittedSection(codeLong)
group('아주 긴 줄 — 데이터 모양 줄(syung#12)은 앞부분만 넣고 다 본 것 · 코드로 보이는 줄(R1)은 불완전 · 못 본 파일 · ⚠️ 목록', [
  ['syung#12 — 코드 파일 안의 아주 긴 줄은 앞부분만 · 같은 파일의 다른 줄과 뒤 파일은 그대로', syung12.complete && syung12.text.includes('aria-live="polite"') && syung12.text.includes('server/account.mjs') && syung12.text.includes('…(이 줄 ') && syung12.shortened[0]?.path === 'web/index.html' && syung12.text.length < 5000, JSON.stringify({ ...syung12, text: syung12.text.length })],
  ['R1 — 데이터 모양 판별: 숫자 · 따옴표 · 괄호 리터럴(문자열 내용은 비우고 셈)은 데이터 · 압축 코드는 아님', dataLikeLine(`+<script>const stationData=${'[1,2],'.repeat(500)}</script>`) && dataLikeLine(`+const names=[${'"서울역",'.repeat(300)}]`) && dataLikeLine(`+${'"100100":12.3,'.repeat(200)}`) && !dataLikeLine(`+${'function a(b){return b.map(c=>c*2)};'.repeat(40)}`)],
  ['R1 — 코드로 보이는 긴 줄을 줄인 파일은 불완전 · 못 본 파일 목록 · 개수에 들어감 · 데이터 줄만 줄인 파일(syung#12)은 다 본 것', !codeLong.complete && JSON.stringify(missedFiles(codeLong)) === '["web/app.js"]' && partialCount(codeLong) === 1 && codeLong.shortened[0].code === 1 && syung12.complete && syung12.shortened[0].code === 0, JSON.stringify({ ...codeLong, text: codeLong.text.length })],
  ['R1 — 프롬프트 ⚠️ 목록에 "코드로 보이는 아주 긴 줄 1개를 앞 200자만" · 데이터 줄 목록은 따로', codeLongText.includes('⚠️ 길어서 다 넣지 못한 코드 파일') && codeLongText.includes('`web/app.js` · 코드로 보이는 아주 긴 줄 1개를 앞 200자만') && omittedSection(syung12).includes('데이터 모양의 아주 긴 줄을 앞부분만 넣은 파일') && !omittedSection(syung12).includes('⚠️'), codeLongText]
])

console.log('\n생성물 판별 기준(docs/pr-auto.md "큰 diff")')
const one = (path, extra = {}) => ({ path, text: 'x', longest: 10, ...extra })
const attrs = linguistGeneratedRules('# 주석\nweb/stations.js linguist-generated\n*.pb.go linguist-generated=true\nvendor/** -linguist-generated\nx.js linguist-generated=false\ny.js !linguist-generated\nREADME.md text\n')
const wide = linguistGeneratedRules('* linguist-generated\nsrc/** -linguist-generated\nsrc/gen/** linguist-generated\n')
group('생성물 판별 — .gitattributes linguist-generated 켬 · 끔을 순서대로 · 뒤 규칙이 덮는다', [
  ['.gitattributes linguist-generated — 켬 · 끔 규칙을 순서대로(속성 없는 줄은 뺌) · 켠 경로는 생성물', JSON.stringify(attrs.map((rule) => `${rule.pattern}:${rule.on}`)) === '["web/stations.js:true","*.pb.go:true","vendor/**:false","x.js:false","y.js:false"]' && generatedReason(one('web/stations.js'), { attributes: attrs }) === 'linguist-generated' && generatedReason(one('api/a.pb.go'), { attributes: attrs }) === 'linguist-generated' && generatedReason(one('x.js'), { attributes: attrs }) === '', JSON.stringify(attrs)],
  ['.gitattributes — 뒤 규칙이 덮는다: "*" 켬 뒤 "src/**" 끔이면 src 코드는 리뷰 · 그 뒤 "src/gen/**" 켬은 다시 생성물', linguistGenerated('dist/a.js', wide) && !linguistGenerated('src/app.mjs', wide) && linguistGenerated('src/gen/api.ts', wide) && generatedReason(one('src/app.mjs'), { attributes: wide }) === '' && !linguistGenerated('a.js', [])]
])
group('생성물 판별 — lockfile · 압축본 · 소스맵 · 데이터 확장자는 크거나 아주 긴 줄일 때만', [
  ['lockfile · 압축본 · 소스맵', generatedReason(one('package-lock.json')) === 'lockfile' && generatedReason(one('apps/web/pnpm-lock.yaml')) === 'lockfile' && generatedReason(one('dist/app.min.js')) === '압축본 · 소스맵' && generatedReason(one('dist/app.js.map')) === '압축본 · 소스맵'],
  ['데이터 확장자는 크거나(2만 자 넘음) 아주 긴 줄일 때만 — 작은 설정 JSON 은 코드처럼 리뷰', generatedReason(one('package.json')) === '' && generatedReason(one('data/x.csv', { text: 'x'.repeat(20_001) })).startsWith('큰 데이터 파일') && generatedReason(one('a.json', { longest: 1001 })).startsWith('데이터 파일 · 아주 긴 줄')]
])
group('생성물 판별 — 팩 \'generated\' 패턴이 먼저 · 레포 항목의 문자열만 · glob 규칙', [
  ['팩 레포 "generated" 패턴이 먼저(작은 파일도) — data/** · *.gen.ts', generatedReason(one('data/a/b.txt'), { patterns: ['data/**'] }) === '팩 설정 생성물' && generatedReason(one('src/api/x.gen.ts'), { patterns: ['*.gen.ts'] }) === '팩 설정 생성물' && generatedReason(one('src/data/b.txt'), { patterns: ['data/**'] }) === ''],
  ['repoGeneratedPatterns — 그 레포 항목의 문자열 배열만(없으면 [])', JSON.stringify(repoGeneratedPatterns({ repos: [{ name: 'syung', generated: ['data/fare/**', 3, ''] }, { name: 'x', generated: 'data' }] }, 'syung')) === '["data/fare/**"]' && repoGeneratedPatterns({ repos: [{ name: 'x', generated: 'data' }] }, 'x').length === 0 && repoGeneratedPatterns({}, 'y').length === 0],
  ['glob — / 없는 패턴은 어느 폴더든 · 끝 / 는 폴더 아래 · 앞 / 는 맨 위만', globToRegExp('*.lock').test('a/b/c.lock') && globToRegExp('gen/').test('gen/a/b.ts') && globToRegExp('/gen/*.ts').test('gen/a.ts') && !globToRegExp('/gen/*.ts').test('x/gen/a.ts') && globToRegExp('**/fixtures/**').test('a/fixtures/b.json')]
])
console.log('\n넘칠 때 — 잘린 · 빠진 파일 목록 · 잘린 승인은 머지 승인 아님')
const big = (path) => fileDiff(path, Array.from({ length: 600 }, (_, index) => `const value${index} = ${index} // ${'x'.repeat(30)}`))
const over = packDiff(big('src/a.mjs') + big('src/b.mjs') + big('src/c.mjs') + fileDiff('src/d.mjs', ['export const d = 1']), { limit: LIMIT })
const twice = packDiff(big('src/a.mjs') + big('src/b.mjs') + fileDiff('src/b2.mjs', Array.from({ length: 600 }, () => 'function a(b){return b.map(c=>c*2)};'.repeat(40))), { limit: LIMIT })
// 검수 묶음 5 #22 재현 — PR 239: 사전(i18n json · 각각 2만 자 아래 · 짧은 줄이라 생성물 아님) 4개가 경로 순서로 코드보다 앞에 와 자리를 먹고 코드 파일이 빠졌다
const dict = (lang) => fileDiff(`src/i18n/${lang}.json`, Array.from({ length: 260 }, (_, index) => `  "monitor.key${index}": "문구 ${lang} ${index} ${'가'.repeat(20)}",`))
const codeAfter = (path) => fileDiff(path, Array.from({ length: 150 }, (_, index) => `export const line${index} = ${index} // ${'y'.repeat(30)}`))
const pr239 = packDiff(['ko', 'en', 'ja', 'zh'].map(dict).join('') + codeAfter('src/lib/token-usage.mts') + codeAfter('src/main/monitor-logs.mts'), { limit: LIMIT })
const pr239Missed = missedFiles(pr239)
const pr239Text = omittedSection(pr239)
group('#22 — 사전이 앞에 와도 코드 파일 먼저 · 모자란 사전은 줄 수만 · 못 본 파일로 남김 · 프롬프트 목록', [
  ['#22 — 사전이 앞에 와도 코드 파일이 먼저 통째로 들어간다(코드는 못 본 파일 목록에 없음)', pr239.text.includes('src/lib/token-usage.mts') && pr239.text.includes('src/main/monitor-logs.mts') && !pr239Missed.some((path) => !path.endsWith('.json')), JSON.stringify({ missed: pr239Missed, truncated: pr239.truncated, dropped: pr239.dropped })],
  ['#22 — 자리가 남는 사전은 통째로 · 모자란 사전은 자르지 않고 요약(경로 · +N/−M줄)만 · 그 사전은 못 본 파일로 남긴다(지금처럼 기록) · 상한은 그대로', pr239.truncated.length === 0 && pr239.dropped.length >= 1 && pr239.dropped.every((item) => item.path.endsWith('.json') && item.data && item.added === 260) && !pr239.complete && pr239.text.length <= LIMIT && pr239Missed.length === pr239.dropped.length, JSON.stringify({ missed: pr239Missed, truncated: pr239.truncated, dropped: pr239.dropped, length: pr239.text.length })],
  ['#22 — 프롬프트 목록에 "사전 · 데이터라 뒤로 · 자리가 없어 줄 수만"', pr239.dropped.every((item) => pr239Text.includes(`\`${item.path}\` · +${item.added}/−${item.removed}줄 · 사전 · 데이터라 뒤로 미뤘고 자리가 없어 줄 수만`)), pr239Text]
])
const overText = omittedSection(over)
const ok = (name, review) => ({ name, status: 'ok', review: validReview(review) })
const approve = { verdict: 'approve', summary: '좋다', findings: [], decisions: [] }
const changes = { verdict: 'changes', summary: '고칠 것', findings: [{ file: 'a.js', line: 3, problem: 'p', fix: 'f', severity: 'blocking' }], decisions: [] }
const both = aggregate([ok('claude', approve), ok('codex', approve)], 2)
group('넘칠 때 — 통째로 들어가는 코드 파일 먼저 · 하나 잘라 넣고 나머지는 목록 · 못 본 파일 목록(중복 없음) · 프롬프트 ⚠️ 목록', [
  ['코드 파일을 순서대로 — 통째로 들어가는 것 먼저(뒤의 작은 파일 d 도) · 남은 자리로 하나를 잘라 넣고 · 나머지는 목록에만 · 순서는 원래대로', !over.complete && over.text.includes('src/a.mjs') && over.text.includes('src/d.mjs') && over.text.indexOf('src/b.mjs') < over.text.indexOf('src/d.mjs') && over.truncated.length === 1 && over.truncated[0].path === 'src/b.mjs' && over.dropped.map((item) => item.path).join() === 'src/c.mjs' && over.text.length <= LIMIT + 200, JSON.stringify({ ...over, text: over.text.length })],
  ['R1 — 줄도 줄이고 잘리기도 한 파일은 못 본 파일 목록에 한 번만(중복 없음)', new Set(missedFiles(twice)).size === missedFiles(twice).length && partialCount(twice) === missedFiles(twice).length && missedFiles(twice).includes('src/b2.mjs'), JSON.stringify(missedFiles(twice))],
  ['프롬프트에 잘린 · 빠진 파일 목록과 "전체 diff 를 달라는 지적은 내지 않는다"', overText.includes('⚠️ 길어서 다 넣지 못한 코드 파일') && overText.includes('전체 diff 를 달라') && [...over.truncated, ...over.dropped].every((item) => overText.includes(item.path)), overText],
  ['못 본 파일 목록(missedFiles) — 잘린 · 빠진 파일 경로(history 에 남겨 다음 라운드가 전체 diff 를 다시 본다)', JSON.stringify(missedFiles(over)) === JSON.stringify([...over.truncated, ...over.dropped].map((item) => item.path)) && missedFiles(packed).length === 0]
])
const split = packDiffParts(big('src/a.mjs') + big('src/b.mjs') + big('src/c.mjs') + fileDiff('src/d.mjs', ['export const d = 1']), { limit: LIMIT })
const huge = packDiffParts(fileDiff('src/h.mjs', Array.from({ length: 1400 }, (_, index) => `const value${index} = ${index} // ${'x'.repeat(30)}`)), { limit: LIMIT })
const capped = packDiffParts(['a', 'b', 'c', 'e', 'f', 'g'].map((name) => big(`src/${name}.mjs`)).join(''), { limit: LIMIT }, 2)
const mergedParts = mergePartResults([[{ ...ok('codex', approve), tokens: 10 }], [{ ...ok('codex', changes), tokens: 5 }]])
const failedPart = mergePartResults([[ok('codex', approve)], [{ name: 'codex', status: 'failed', reason: 'x' }]])
group('조각 리뷰(#267) — 못 넣은 것만 뒤 조각 · 파일 하나가 크면 못 본 파일 · 조각 상한 · 결과 합치기', [
  ['조각 리뷰(#267) — 첫 조각에 못 넣은 b · c 만 뒤 조각으로 · 합친 결과는 다 봄 · 앞 조각 프롬프트엔 "못 넣은 것" 없음', split.parts.length >= 2 && split.packed.complete && !split.parts[0].complete && partForPrompt(split.parts, 0).complete && !split.parts.slice(1).some((part) => part.text.includes('src/a.mjs')) && split.parts.slice(1).some((part) => part.text.includes('src/c.mjs')), JSON.stringify(split.parts.map((part) => ({ ...part, text: part.text.length })))],
  ['조각 리뷰 — 파일 하나가 조각보다 크면 더 나누지 않고 못 본 파일로 남김(잘린 승인 그대로)', huge.parts.length === 1 && !huge.packed.complete && JSON.stringify(missedFiles(huge.packed)) === '["src/h.mjs"]'],
  ['조각 리뷰 — 조각 상한을 넘으면 마지막 조각의 못 본 파일이 남음', capped.parts.length === 2 && !capped.packed.complete],
  ['조각 결과 합치기 — 한 조각이라도 수정 필요면 수정 필요 · 지적 모두 · 토큰 합 · 한 조각 실패면 실패', mergedParts[0].review.verdict === 'changes' && mergedParts[0].review.findings.length === changes.findings.length && mergedParts[0].tokens === 15 && failedPart[0].status === 'failed' && aggregate(mergedParts, 1).verdict === 'changes' && aggregate(mergePartResults([[ok('codex', approve)], [ok('codex', approve)]]), 1).verdict === 'approve', JSON.stringify(mergedParts)]
])
const partialComment = reviewComment({ sha: 'abcdef1', round: 1, results: [ok('claude', approve), ok('codex', approve)], summary: both, partial: partialCount(over) })
group('잘린 승인 — 둘 다 승인이어도 머지 승인 아님 · PR 댓글에 다 넣지 못한 파일 수', [
  ['잘린 diff + 둘 다 승인 → 잘린 승인(머지 승인 아님) · 다 넣었으면 그대로 승인 · 수정 필요는 그대로 보낸다', partialApproval(both, over) && !partialApproval(both, packed) && !partialApproval(aggregate([ok('claude', approve), ok('codex', changes)], 2), over) && partialCount(over) === over.truncated.length + over.dropped.length && PARTIAL_APPROVAL === '잘린 diff 승인'],
  ['PR 댓글 — 다 넣지 못한 파일 수 · 이 승인은 머지 승인으로 세지 않는다 · 다 넣었으면 그 줄 없음', partialComment.includes(`코드 파일 ${partialCount(over)}개를 다 넣지 못했다`) && partialComment.includes('머지 승인으로 세지 않고') && !reviewComment({ sha: 'a', round: 1, results: [ok('claude', approve), ok('codex', approve)], summary: both }).includes('다 넣지 못했다'), partialComment]
])
const pr = { baseRefName: 'dev', title: '시험', body: '본문' }
const prompt = buildPrompt({ repo: 'syung', number: '23', pr, planFile: 'plans/task/x.md', planText: '계획', packed })
const overPrompt = buildPrompt({ repo: 'syung', number: '23', pr, planFile: 'plans/task/x.md', planText: '계획', packed: over })
const onlyGen = buildPrompt({ repo: 'syung', number: '23', pr, planFile: 'p', planText: '', packed: packDiff(busKm, { limit: LIMIT }) })
group('buildPrompt — PR 대상 브랜치는 지적 안 함(#328) · 생성물 목록 절 · 넘치면 \'길어서 일부만\' · 코드 변경 없음 표시', [
  ['프롬프트 — PR 대상 브랜치(dev · 레포 규칙의 prBase 와 다름)는 올린 사람이 정한 것 · 지적하지 않는다고 알린다(#328)', prompt.includes('→ dev —') && prompt.includes('PR 대상 브랜치') && prompt.includes('올린 사람이 정한 것'), prompt.slice(0, 2500)],
  ['프롬프트 — 코드 diff · "리뷰에 넣지 못한 것" 절에 생성물 목록 · 생성물 본문 없음', prompt.includes('src/fare.mjs') && prompt.includes('## 리뷰에 넣지 못한 것') && prompt.includes('bus_km.json` · +1/−0줄 · 생성물이라 생략') && !prompt.includes('100100') && !prompt.includes('길어서 일부만'), prompt.slice(-1500)],
  ['프롬프트 — 넘치면 제목에 "길어서 일부만" · 잘린 파일 목록', overPrompt.includes('길어서 일부만') && overPrompt.includes('⚠️ 길어서 다 넣지 못한 코드 파일')],
  ['프롬프트 — 생성물만 바뀌면 "(생성물 밖의 코드 변경 없음)" · 빈 diff 는 "(코드 변경 없음)" · 목록 절 없음', onlyGen.includes('(생성물 밖의 코드 변경 없음)') && buildPrompt({ repo: 's', number: '1', pr, planFile: 'p', planText: '', packed: packDiff('', { limit: LIMIT }) }).includes('(코드 변경 없음)') && !buildPrompt({ repo: 's', number: '1', pr, planFile: 'p', planText: '', packed: packDiff('', { limit: LIMIT }) }).includes('리뷰에 넣지 못한 것')]
])
console.log(`\n${pass + fail}개 중 실패 ${fail}`)
process.exit(fail ? 1 : 0)
EOF

[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
