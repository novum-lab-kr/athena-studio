#!/usr/bin/env node
// docs/diagrams/index.html 을 실제 파일 목록에서 만든다.
// 아테나 자체 그림(작업 흐름 · 압축 전후) 카드뿐이다 — 서비스 흐름은 각 레포 docs/flows/ 가 맡는다.
//   node scripts/build-diagram-index.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs/diagrams');

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>아테나 다이어그램</title>
<style>
  /* 색 · 글꼴 · 간격은 Athena Studio 앱(src/renderer/style.css :root)을 따른다 — 앱이 다크 하나뿐이라 다크만 */
  :root {
    color-scheme: dark;
    --bg: #16171a; --bar: #1f2125; --line: #2e3137;
    --text: #e8e6e1; --muted: #9a968e; --title: #f3ead6; --accent: #c9ad78; --accent-text: #e9d2a0;
    --gold-line: rgb(201 173 120 / 38%); --gold-bg: rgb(201 173 120 / 7%);
    --font-ui: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif;
    --font-mono: "D2Coding", "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 36px 28px 56px;
    background: var(--bg); color: var(--text);
    font: 13px/1.6 var(--font-ui);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; color: var(--title); }
  .lead { color: var(--muted); font-size: 13px; margin: 0 0 6px; }
  .note { color: var(--muted); font-size: 12px; margin: 0 0 28px; }
  code { background: var(--bar); padding: 1px 6px; border-radius: 4px; color: var(--accent-text); font: 12px var(--font-mono); }
  h2 {
    font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: .04em;
    margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line);
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .card {
    background: rgb(255 255 255 / 2.5%); border: 1px solid rgb(255 255 255 / 8%); border-radius: 8px;
    padding: 12px 14px; transition: border-color .14s, background-color .14s;
  }
  .card:hover { border-color: var(--gold-line); background: var(--gold-bg); }
  .t { font-size: 13px; font-weight: 600; color: var(--title); margin-bottom: 2px; }
  .s { font-size: 11.5px; color: var(--accent); margin-bottom: 6px; }
  .d { font-size: 12px; color: var(--muted); }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .pill {
    text-decoration: none; font-size: 12px; font-weight: 500;
    color: var(--text); background: var(--bar); border: 1px solid var(--line);
    padding: 3px 10px; border-radius: 6px;
    transition: border-color .14s, background-color .14s, color .14s;
  }
  .pill:hover, .pill:focus-visible { outline: none; border-color: var(--gold-line); background: var(--gold-bg); color: var(--accent-text); }
  a { color: var(--accent-text); }
  footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>아테나 다이어그램</h1>
    <p class="lead">아테나 작업 흐름을 인터랙티브 HTML 로 본다. 서비스 흐름은 각 레포 <code>docs/flows/</code> 에 있다.</p>
    <h2>작업 흐름</h2>
    <div class="grid">
      <div class="card">
        <div class="t">작업 흐름 · 경량</div>
        <div class="s">대부분의 작업 — 레포 하나</div>
        <div class="d">요청 → 판단(📋 경량) → 계획서 자동 기록 → 에이전트 pane → 작업·커밋 → 리뷰 → PR. 승인 단계 없이 pane 에서 끝까지 간다.</div>
        <div class="pills"><a class="pill" href="athena-flow-light.html">열기</a></div>
      </div>
      <div class="card">
        <div class="t">작업 흐름 · 정식</div>
        <div class="s">여러 레포 · API · 구조 변경</div>
        <div class="d">요청 → 판단(📋 정식) → 정식 계획서 → 결정 콘솔 [이대로 진행] 승인 → 순차 디스패치 → 아테나 교차 리뷰·PR → 보고. 공통 규칙·재개·정리 카드 포함.</div>
        <div class="pills"><a class="pill" href="athena-flow-formal.html">열기</a></div>
      </div>
      <div class="card">
        <div class="t">대화 압축 전후 자동 저장</div>
        <div class="s">긴 작업이 압축돼도 하던 일을 잃지 않게</div>
        <div class="d">압축 직전 훅이 계획서 Checkpoint 에 상태 한 줄 → Claude Code 압축(요약은 그대로) → 압축 직후 "계획서부터 다시 읽어라" 안내. 훅이 없으면 생기는 일 포함.</div>
        <div class="pills"><a class="pill" href="athena-compact.html">열기</a></div>
      </div>
    </div>
    <footer>
      원본 스펙은 <code>docs/diagrams/*.json</code> 이고 <a href="https://github.com/tt-a1i/archify">Archify</a> 로 생성한다.
      이 목록은 <code>node scripts/build-diagram-index.mjs</code> 로 다시 만든다 — 카드를 손으로 늘리지 않는다.
      다시 만드는 방법은 <code>docs/diagrams/README.md</code> 에 있다.
    </footer>
  </div>
</body>
</html>
`;
writeFileSync(join(DIR, 'index.html'), html);
console.log('✅ index.html — 아테나 흐름 3(경량·정식·압축 전후)');
