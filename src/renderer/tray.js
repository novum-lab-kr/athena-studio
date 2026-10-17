// 메뉴 막대 패널(★ Codex 추천 · 상태 목록형) — 확인 필요 → 에이전트(두 줄 행) → 사용량(창마다 얇은 막대) → 칸반 숫자 → 최근 24시간 완료 막대그래프.
// 많으면: 확인 필요 3줄 + 'n개 더' · 에이전트 칸 안 스크롤 · 패널 최대 높이 넘으면 스크롤. 없으면: 한 줄 안내.
// 글자는 모두 textContent(HTML 로 넣지 않는다)
/* global trayPanel */
const $ = (id) => document.getElementById(id)
const ATTENTION_ROWS = 3
const STATUS = { working: '작업 중', blocked: '입력 대기', idle: '대기' }
const COLUMNS = [
  ['issue', '이슈'],
  ['plan', '계획'],
  ['doing', '진행'],
  ['review', '리뷰'],
  ['done', '완료'],
]
const USAGE_HIGH = 80 // 이 % 넘으면 % 글자를 빨갛게(막대는 도구 색 그대로)

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function clock(ms) {
  if (!ms) return '-'
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// 칸 제목 — 위에 가는 선 · 오른쪽에 짧은 요약
function title(text, summaryText) {
  const row = el('div', 't', text)
  if (summaryText) row.append(el('span', 'sum', summaryText))
  return row
}

// 확인 필요 — 제목에 수, 아래 한 줄씩(누르면 그 pane · 결정 콘솔)
function attention(summary) {
  const items = summary.attention
  if (!items.length) return el('div', 'att clear', '확인할 일 없음')
  const box = el('div', 'att')
  box.append(el('b', '', `확인 필요 ${items.length}`))
  for (const item of items.slice(0, ATTENTION_ROWS)) {
    const row = el('button', `it ${item.mark === '!' ? 'b' : 'r'}`)
    row.title = item.text
    row.append(el('span', 'tx', item.text), el('span', 'go', '›'))
    if (item.mark === '?') row.append(el('em', '', '리뷰'))
    row.addEventListener('click', () => (item.kind === 'pane' ? trayPanel.action('focus-pane', item.id) : trayPanel.action('open-card', item.html)))
    box.append(row)
  }
  if (items.length > ATTENTION_ROWS) {
    const more = el('button', 'it')
    more.append(el('span', 'tx', `${items.length - ATTENTION_ROWS}개 더 — 현황판에서`), el('span', 'go', '›'))
    more.addEventListener('click', () => trayPanel.action('show', 'board'))
    box.append(more)
  }
  return box
}

// 에이전트 — 두 줄 행(이름 / 작업 공간) · 오른쪽 상태 · 누르면 그 pane
function agentsBlock(summary) {
  const wrap = el('div', 'agents')
  if (!summary.agents.length) {
    const empty = el('div', 'empty', '돌고 있는 에이전트가 없어요')
    const open = el('button', '', 'Athena 열기')
    open.addEventListener('click', () => trayPanel.action('show', 'work'))
    empty.append(open)
    wrap.append(empty)
    return wrap
  }
  for (const agent of summary.agents) {
    const row = el('button', 'ag')
    row.title = `${agent.name}${agent.workspace ? ` · ${agent.workspace}` : ''} — 누르면 그 pane 으로`
    const name = el('div', 'nm', agent.name)
    name.append(el('small', '', agent.workspace || '작업 공간 없음'))
    row.append(el('span', `dot ${agent.status}`), name, el('i', '', STATUS[agent.status] || agent.status))
    row.addEventListener('click', () => trayPanel.action('focus-pane', agent.id))
    wrap.append(row)
  }
  return wrap
}

// 사용량 — 도구마다 묶고, 창마다 '<창> <%> ▬ · <리셋>' · 막대는 도구 색(Claude 주황 · Codex 파랑)
function usageBlock(summary) {
  const box = el('div', 'usage')
  const tools = new Map()
  for (const item of summary.usageItems || []) {
    if (!tools.has(item.tool)) tools.set(item.tool, [])
    tools.get(item.tool).push(item)
  }
  if (!tools.size) {
    box.append(el('div', 'empty', summary.boardUp ? '사용량 정보가 없어요' : '현황판이 꺼져 있어 못 봐요'))
    return box
  }
  for (const [tool, windows] of tools) {
    const prov = el('div', 'prov')
    prov.dataset.tool = windows[0].toolId || ''
    prov.append(el('b', '', tool))
    for (const item of windows) {
      const line = el('div', `win${item.percent >= USAGE_HIGH ? ' hi' : ''}`)
      const bar = el('span', 'bar')
      const fill = el('span')
      fill.style.width = `${item.percent}%`
      bar.append(fill)
      line.append(el('span', 'wl', `${item.window} ${item.percent}%`), bar)
      if (item.reset) line.append(el('span', 'rs', `· ${item.reset}`))
      prov.append(line)
    }
    box.append(prov)
  }
  return box
}

function kanbanBlock(summary) {
  const box = el('div', 'kb')
  for (const [key, label] of COLUMNS) {
    const cell = el('button')
    cell.title = '현황판에서 보기'
    cell.append(el('b', '', String(summary.columns[key] || 0)), el('small', '', label))
    cell.addEventListener('click', () => trayPanel.action('show', 'board'))
    box.append(cell)
  }
  return box
}

// 최근 24시간 완료 — 한 시간씩 24칸 막대(마지막 칸이 지금)
function historyBlock(summary) {
  const done = summary.done24 || { hours: [], total: 0 }
  const box = el('div', 'hist', `최근 24시간 · 완료 작업 ${done.total}`)
  const bars = el('div', 'bars')
  const peak = Math.max(1, ...done.hours)
  done.hours.forEach((count, index) => {
    const bar = el('span', count ? '' : 'zero')
    bar.style.height = `${Math.round((count / peak) * 100)}%`
    bar.title = `${24 - index}시간 전 ~ ${23 - index ? `${23 - index}시간 전` : '지금'} · ${count}개`
    bars.append(bar)
  })
  const axis = el('small')
  axis.append(el('span', '', '24시간 전'), el('span', '', '지금'))
  box.append(bars, axis)
  return box
}

function render(data) {
  const { summary } = data
  const conn = $('conn')
  conn.textContent = summary.boardUp ? '● 연결됨' : '● 연결 안 됨'
  conn.classList.toggle('off', !summary.boardUp)
  conn.title = `현황판 마지막 확인 ${clock(data.boardAt)}`

  const parts = [attention(summary)]
  parts.push(title('에이전트', `작업 중 ${summary.counts.working} · 대기 ${summary.idleAgents}${summary.blockedAgents ? ` · 막힘 ${summary.blockedAgents}` : ''}`))
  parts.push(agentsBlock(summary))
  parts.push(title('사용량'))
  parts.push(usageBlock(summary))
  // 현황판이 꺼져 있으면 칸반 · 완료 그래프는 숨긴다(0 으로 보이지 않게)
  if (summary.boardUp) parts.push(kanbanBlock(summary), historyBlock(summary))
  $('body').replaceChildren(...parts)

  // 알림을 일시 중지했을 때만 머리줄에 🔕(언제까지는 마우스를 올리면)
  const paused = data.pausedUntil > Date.now()
  $('bell').hidden = !paused
  $('bell').title = paused ? `${clock(data.pausedUntil)}까지 알림 끔 — ☰ 에서 다시 켜기` : ''
  // 머리줄 + 본문의 실제 높이 그대로(어림 여백을 더하지 않는다 — 남는 자리가 띠로 보인다 · 최대는 main 이 화면 높이로 자른다)
  requestAnimationFrame(() => trayPanel.reportHeight(Math.ceil($('hd').getBoundingClientRect().height + $('body').scrollHeight)))
}

$('menu').addEventListener('click', () => trayPanel.action('menu'))
trayPanel.onUpdate(render)
