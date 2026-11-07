#!/usr/bin/env node
// @ts-check
// docs/diagrams/index.html(한국어) · index.<en|ja|zh>.html 을 실제 파일 목록에서 만든다 — 앱은 고른 언어 목록을 연다(src/lib/work-model.mts diagramIndexFile).
// 팩 서비스 카드(pack/diagrams/index.json) 아래에 아테나 작업 흐름 카드(코어 docs/diagrams 의 athena-flow · athena-compact)를 붙인다.
//   node scripts/build-diagram-index.mjs
// 원본 스펙은 docs/diagrams/*.json(서비스는 pack/diagrams/*.json)이고 Archify 로 HTML 을 만든다.
// 이 목록은 이 스크립트로만 다시 만든다 — index.html 에 카드를 손으로 늘리지 않는다(다시 만드는 방법 docs/diagrams/README.md).
// 화면 아래 footer 에는 만든 도구만 적는다 — 경로 · 명령 같은 관리자 메모는 여기와 README 에만 둔다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { paths } from './lib/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs/diagrams');

// 팩 경로는 공통 설정 해석기를 따른다. 팩이 없는 코어에서도 아테나 작업 흐름 목록은 만든다.
const packDir = paths(ROOT).packDir;
const serviceDir = packDir ? join(packDir, 'diagrams') : DIR;
const manifest = join(serviceDir, 'index.json');
/** @param {unknown} value */
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
/** @param {string} file */
const link = (file) => {
  // 팩 데이터가 지정한 상대 HTML만 허용한다. 외부 URL·상위 경로는 카드로 만들지 않는다.
  if (typeof file !== 'string' || !file.endsWith('.html') || file.includes('\\') || file.split('/').some((part) => !part || part === '..' || part === '.') || /^[\/]|:/.test(file)) throw new Error('다이어그램 파일은 팩 안 상대 HTML 경로여야 한다');
  const full = resolve(serviceDir, file);
  if (!existsSync(full)) return '';
  return relative(DIR, full).split(sep).map((part) => encodeURIComponent(part)).join('/');
};
const groups = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).groups ?? [] : [];
// 언어마다 목록 문구 — 팩 서비스 카드의 이름 · 설명(pack/diagrams/index.json)은 팩이 쓴 그대로 싣는다.
// 메뉴 이름은 개발 용어로 — 한 장 요약은 시스템 개요, 기능 흐름은 시퀀스 다이어그램(docs/diagrams/AUTHORING.md "점검·목록").
// .domains.html(화면 맵)은 지금 기준에서 만들지 않는 옛 장이다 — 파일이 남은 팩에서만 맨 뒤에 보인다.
const TEXT = {
  ko: {
    title: '아테나 다이어그램', overview: '시스템 개요', sequence: '시퀀스 다이어그램', legacy: '화면 맵', open: '열기', flows: '아테나 작업 흐름',
    lead: '서비스 시스템 개요·시퀀스 다이어그램과 아테나 작업 흐름을 인터랙티브 HTML 로 본다. 서비스 그림은 <code>/diagram</code> 으로 갱신한다.',
    footer: '<code>/diagram</code> 스킬로 만들었습니다 · <a href="https://github.com/tt-a1i/archify">Archify</a> 사용',
    flow: { name: '작업 흐름 · 경량 / 정식', sub: '한 흐름 — 계획서에서 갈라졌다 다시 만난다', desc: '요청 → triage(정식만 결정 콘솔 승인) → 디스패치 → pane 작업 → 완료 보고 → 바로 push · PR 세 갈래(PR 자동 리뷰 / direct merge · Actions handoff / main 직접 push) → auto done · 학습 리뷰(learn review) · cleanup → 남은 일은 이슈로 다시 요청. 사용자 확인(승인 / 재작업)은 UI 변경 · autoMerge 아닌 레포만 옆 갈래로. 카드마다 누가 · 무슨 명령.' },
    compact: { name: '대화 압축(compact) 전후 자동 저장', sub: '긴 작업이 compact 돼도 하던 일을 잃지 않게', desc: '압축점(창 − 33,000 · Codex 는 limit)의 70% 에서 "먼저 적어 두기" 알림 한 번 → compact 직전 훅이 계획서 Checkpoint 에 상태 한 줄(Work ref · 미커밋) → compact(summary 는 그대로) → compact 직후 "계획서부터 다시 읽어라" 안내. Claude · Codex 훅 자리와 훅이 없으면 생기는 일 포함.' },
  },
  en: {
    title: 'Athena diagrams', overview: 'System overview', sequence: 'Sequence diagram', legacy: 'Screen map', open: 'Open', flows: 'Athena workflow',
    lead: 'Service system overviews · sequence diagrams and the Athena workflow as interactive HTML. Update service diagrams with <code>/diagram</code>.',
    footer: 'Made with the <code>/diagram</code> skill · uses <a href="https://github.com/tt-a1i/archify">Archify</a>',
    flow: { name: 'Workflow · lightweight / formal', sub: 'One flow — splits at the plan and joins again', desc: 'Request → triage (formal needs decision console approval) → dispatch → pane work → completion report → push · PR right away, three paths (PR auto review / direct merge · Actions handoff / direct push to main) → auto done · learn review · cleanup → leftovers come back as issues. User check (approve / redo) is a side branch only on UI change · non-autoMerge repos. Each card shows who · which command.' },
    compact: { name: 'Auto save around compact', sub: "Don't lose the task when a long chat is compacted", desc: 'One "write it down first" alert at 70% of the compaction point (window − 33,000 · Codex limit) → right before compact the hook writes one status line (Work ref · uncommitted) to the plan Checkpoint → compact (summary untouched) → right after, a "reread the plan first" hint. Includes the Claude · Codex hook locations and what happens without the hooks.' },
  },
  ja: {
    title: 'アテナ ダイアグラム', overview: 'システム概要', sequence: 'シーケンス図', legacy: '画面マップ', open: '開く', flows: 'アテナ 作業フロー',
    lead: 'サービスのシステム概要 · シーケンス図と アテナ 作業フローをインタラクティブ HTML で見る。サービス図は <code>/diagram</code> で更新する。',
    footer: '<code>/diagram</code> スキルで作成 · <a href="https://github.com/tt-a1i/archify">Archify</a> 使用',
    flow: { name: '作業フロー · 軽量 / 正式', sub: '一つの流れ — 計画書で分かれてまた合流する', desc: '依頼 → triage(正式のみ決定コンソールで承認) → ディスパッチ → pane 作業 → 完了報告 → すぐ push · PR 三つの道(PR 自動レビュー / direct merge · Actions handoff / main 直接 push) → auto done · 学習レビュー(learn review) · cleanup → 残りはイシューとして再依頼。ユーザー確認(承認 / 再作業)は UI 変更 · autoMerge でないレポのみ脇道で。カードごとに誰が · どのコマンドか。' },
    compact: { name: '会話 compact 前後の自動保存', sub: '長い作業が compact されても作業を見失わない', desc: '圧縮点(窓 − 33,000 · Codex は limit)の 70% で「先に書き留める」通知を一度 → compact 直前にフックが計画書 Checkpoint に状態一行(Work ref · 未コミット) → compact(summary はそのまま) → compact 直後に「計画書から読み直せ」案内。Claude · Codex のフック位置とフックがない場合に起きることも含む。' },
  },
  zh: {
    title: 'Athena 图表', overview: '系统概览', sequence: '时序图', legacy: '界面地图', open: '打开', flows: 'Athena 工作流程',
    lead: '以交互式 HTML 查看服务系统概览 · 时序图和 Athena 工作流程。服务图用 <code>/diagram</code> 更新。',
    footer: '用 <code>/diagram</code> 技能制作 · 使用 <a href="https://github.com/tt-a1i/archify">Archify</a>',
    flow: { name: '工作流程 · 轻量 / 正式', sub: '一条流程 — 在计划书分开又汇合', desc: '请求 → triage(仅正式需决策控制台批准) → 派发 → pane 工作 → 完成报告 → 立即 push · PR 三条路(PR 自动评审 / direct merge · Actions handoff / 直接 push 到 main) → auto done · 学习评审(learn review) · cleanup → 剩余工作作为问题再请求。用户确认(批准 / 返工)仅在 UI 变更 · 非 autoMerge 仓库时走旁路。每张卡写明谁 · 什么命令。' },
    compact: { name: '对话 compact 前后自动保存', sub: '长任务被 compact 也不丢失手头工作', desc: '在压缩点(窗口 − 33,000 · Codex 为 limit)的 70% 提醒一次"先记下来" → compact 前钩子在计划书 Checkpoint 写一行状态(Work ref · 未提交) → compact(summary 不变) → compact 后提示"先重读计划书"。包括 Claude · Codex 钩子位置和没有钩子时会发生的事。' },
  },
};
/** @typedef {keyof typeof TEXT} Lang */
const LANGS = /** @type {Lang[]} */ (Object.keys(TEXT));
/** @param {Lang} lang */
const serviceSectionsOf = (lang) => {
const OVERVIEW = TEXT[lang].overview;
const SEQUENCE = TEXT[lang].sequence;
const LEGACY = [{ suffix: '.domains.html', label: TEXT[lang].legacy }];
/** extra 의 기능 흐름(<서비스>.<기능>.sequence.html)은 label(기능 이름) 앞에 '시퀀스 다이어그램 · ' 을 붙인다 */
const extraLabel = (/** @type {{file: string, label: string}} */ entry) => (entry.file.endsWith('.sequence.html') && !entry.label.startsWith(SEQUENCE) ? `${SEQUENCE} · ${entry.label}` : entry.label);
return groups.map((/** @type {{title: string, items: {base: string, name: string, sub?: string, desc?: string, extra?: {file: string, label: string}[]}[]}} */ group) => {
  const cards = group.items.map((item) => {
    const entries = [
      { file: `${item.base}.html`, label: OVERVIEW },
      { file: `${item.base}.sequence.html`, label: SEQUENCE },
      ...(item.extra ?? []).map((entry) => ({ file: entry.file, label: extraLabel(entry) })),
      ...LEGACY.map((type) => ({ file: item.base + type.suffix, label: type.label })),
    ];
    const pills = entries.map((entry) => {
      const href = link(entry.file);
      return href ? `<a class="pill" href="${esc(href)}">${esc(entry.label)}</a>` : '';
    }).filter(Boolean);
    return pills.length ? `<div class="card"><div class="t">${esc(item.name)}</div><div class="s">${esc(item.sub)}</div><div class="d">${esc(item.desc)}</div><div class="pills">${pills.join('')}</div></div>` : '';
  }).filter(Boolean);
  return cards.length ? `<h2>${esc(group.title)}</h2><div class="grid">${cards.join('\n')}</div>` : '';
}).join('\n');
};

// 아테나 작업 흐름 — 코어가 함께 싣는 그림이라 서비스 그림이 없어도 목록이 비지 않는다(앱 다이어그램 버튼이 이 목록을 연다).
// 그림은 언어마다 <base>.<언어>.html(한국어는 <base>.html) — 그 언어 파일이 없으면 한국어 그림으로 잇는다.
const FLOWS = [
  { base: 'athena-flow', key: /** @type {const} */ ('flow') },
  { base: 'athena-compact', key: /** @type {const} */ ('compact') },
];
/** @param {Lang} lang */
const flowSectionOf = (lang) => {
  const cards = FLOWS.filter((flow) => existsSync(join(DIR, `${flow.base}.html`))).map((flow) => {
    const localized = `${flow.base}.${lang}.html`;
    const href = lang !== 'ko' && existsSync(join(DIR, localized)) ? localized : `${flow.base}.html`;
    const text = TEXT[lang][flow.key];
    return `<div class="card"><div class="t">${esc(text.name)}</div><div class="s">${esc(text.sub)}</div><div class="d">${esc(text.desc)}</div><div class="pills"><a class="pill" href="${esc(href)}">${esc(TEXT[lang].open)}</a></div></div>`;
  });
  return { count: cards.length, html: cards.length ? `<h2>${esc(TEXT[lang].flows)}</h2><div class="grid">${cards.join('\n')}</div>` : '' };
};

/** @param {Lang} lang */
const page = (lang) => `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(TEXT[lang].title)}</title>
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
    <h1>${esc(TEXT[lang].title)}</h1>
    <p class="lead">${TEXT[lang].lead}</p>
    ${serviceSectionsOf(lang)}
    ${flowSectionOf(lang).html}
    <footer>${TEXT[lang].footer}</footer>
  </div>
</body>
</html>
`;
for (const lang of LANGS) writeFileSync(join(DIR, lang === 'ko' ? 'index.html' : `index.${lang}.html`), page(lang));
console.log(`✅ index.html · index.{${LANGS.filter((lang) => lang !== 'ko').join(',')}}.html — 팩 서비스 + 아테나 흐름 ${flowSectionOf('ko').count}`);
