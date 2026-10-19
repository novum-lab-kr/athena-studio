#!/usr/bin/env node
// docs/diagrams/index.html 을 실제 파일 목록에서 만든다.
// 다이어그램을 추가하면 이 스크립트를 다시 돌린다 — 손으로 카드를 늘리지 않는다.
//   node scripts/build-diagram-index.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs/diagrams');

// 타입별 표시 이름. architecture 만 파일명에 타입이 안 붙는다(먼저 만든 9장의 관례).
// lifecycle(화면 상태)·data-sources(가로지르는 장)는 목록에서 뺐다. 파일은 docs/diagrams/ 에 남아 있다
const TYPES = [
  { key: 'architecture', label: '구조', suffix: '.html' },
  { key: 'domains', label: '화면 맵', suffix: '.domains.html' },
  { key: 'sequence', label: '요청 흐름', suffix: '.sequence.html' },
];

// 서비스 카드 — 팩 docs/diagrams/index.json(groups · deepNote · missingNote). 없으면 작업 흐름만
const PACK_INDEX = existsSync(join(DIR, "index.json")) ? JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) : {};
const GROUPS = PACK_INDEX.groups ?? [];;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let total = 0;
const section = (group) => {
  const cards = group.items
    .map((item) => {
      const pills = TYPES.filter((type) => existsSync(join(DIR, item.base + type.suffix))).map((type) => {
        total++;
        return `<a class="pill" href="${item.base}${type.suffix}">${type.label}</a>`;
      });
      for (const extra of item.extra ?? []) {
        if (!existsSync(join(DIR, extra.file))) continue;
        total++;
        pills.push(`<a class="pill" href="${extra.file}">${esc(extra.label)}</a>`);
      }
      if (!pills.length) return '';
      return `      <div class="card">
        <div class="t">${esc(item.name)}</div>
        <div class="s">${esc(item.sub)}</div>
        <div class="d">${esc(item.desc)}</div>
        <div class="pills">${pills.join('')}</div>
      </div>`;
    })
    .filter(Boolean);
  return `    <h2>${esc(group.title)}</h2>\n    <div class="grid">\n${cards.join('\n')}\n    </div>`;
};
const body = [...GROUPS.map(section)].filter(Boolean).join('\n');

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>아테나 다이어그램</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 28px 64px;
    background: #070b14; color: #e6edf6;
    font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', sans-serif;
    line-height: 1.6;
  }
  .wrap { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -.01em; }
  .lead { color: #8fa3bf; font-size: 14px; margin: 0 0 8px; }
  .note { color: #6d819c; font-size: 12.5px; margin: 0 0 36px; }
  .note code { background: #111a2b; padding: 2px 6px; border-radius: 5px; color: #9ec5ff; }
  h2 {
    font-size: 13px; color: #7f94b4; font-weight: 600;
    margin: 34px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #1b2740;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .card {
    background: #0d1422; border: 1px solid #1b2740; border-radius: 12px;
    padding: 16px 18px; transition: border-color .15s, background .15s;
  }
  .card:hover { border-color: #26365a; }
  .t { font-size: 15px; font-weight: 700; margin-bottom: 3px; }
  .s { font-size: 12px; color: #6fd3c4; font-family: 'SF Mono', Menlo, monospace; margin-bottom: 8px; }
  .d { font-size: 13px; color: #93a6c2; }
  .pills { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 13px; }
  .pill {
    text-decoration: none; font-size: 12.5px; font-weight: 600;
    color: #cfe0f8; background: #111c2f; border: 1px solid #22314f;
    padding: 5px 11px; border-radius: 999px;
    transition: border-color .15s, background .15s, color .15s;
  }
  .pill:hover { border-color: #2f6df6; background: #16243c; color: #fff; }
  footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid #1b2740; color: #5f738f; font-size: 12.5px; }
  footer code { background: #111a2b; padding: 2px 6px; border-radius: 5px; color: #9ec5ff; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>아테나 다이어그램</h1>
    <p class="lead">작업 흐름과 담당 레포를 인터랙티브 HTML 로 본다. 서비스마다 보는 각도를 나눠 두었다.</p>
    <p class="note"><b>구조</b>는 어떤 부품으로 이루어져 있는가, <b>화면 맵</b>은 실제로 어떤 화면이 몇 개씩 있는가, <b>요청 흐름</b>은 한 화면이 뜰 때 무엇이 오가는가를 본다. ${PACK_INDEX.deepNote ?? ""}노드를 클릭하면 상세가 뜨고 <code>SRC</code> 배지는 실제 파일을 가리킨다.</p>
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
${body}
    <footer>
      원본 스펙은 <code>docs/diagrams/*.json</code> 이고 <a href="https://github.com/tt-a1i/archify" style="color:#9ec5ff">Archify</a> 로 생성한다.
      이 목록은 <code>node scripts/build-diagram-index.mjs</code> 로 다시 만든다 — 카드를 손으로 늘리지 않는다.
      다시 만드는 방법과 스키마 함정은 <code>docs/diagrams/README.md</code> 에 있다.${PACK_INDEX.missingNote ? `\n      ${PACK_INDEX.missingNote}` : ""}
    </footer>
  </div>
</body>
</html>
`;
writeFileSync(join(DIR, 'index.html'), html);
console.log(
  `✅ index.html — 서비스 ${GROUPS.reduce((n, g) => n + g.items.length, 0)}개 · 다이어그램 링크 ${total}개 + 아테나 흐름 3(경량·정식·압축 전후)`,
);
