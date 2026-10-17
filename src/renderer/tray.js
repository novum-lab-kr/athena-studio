// 메뉴 막대 패널(★ Claude 추천) — 확인 필요 배너 → 작업 공간별 에이전트 → 사용량 링 → 칸반 숫자.
// 많으면: 배너 3줄 + 'n개 더' · 에이전트 칸 안 스크롤 · 패널 최대 높이 넘으면 스크롤. 없으면: ✓ 한 줄 · 안내 문구.
// 글자는 모두 textContent(HTML 로 넣지 않는다)
/* global trayPanel */
const $ = (id) => document.getElementById(id)
const BANNER_ROWS = 3
const STATUS = { working: '작업 중', blocked: '입력 대기', idle: '대기' }
const COLUMNS = [
  ['issue', '이슈'],
  ['plan', '계획'],
  ['doing', '진행'],
  ['review', '리뷰'],
  ['done', '완료'],
]
// 접은 칸 — 앱을 다시 켜도 기억
const folded = new Set(JSON.parse(localStorage.getItem('tray.folded') || '[]'))
let last = null

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

// 머리줄 그래프 — 최근 30분 일하는 에이전트 수
function drawSpark(history) {
  const values = history && history.length ? history : [0]
  const peak = Math.max(1, ...values)
  const step = values.length > 1 ? 100 / (values.length - 1) : 100
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(14 - (value / peak) * 12).toFixed(2)}`)
  $('spark-path').setAttribute('d', `M0,14 L${points.join(' L')} L100,14 Z`)
}

// 칸 제목(누르면 접기)
function section(key, title, summaryText) {
  const button = el('button', `sec${folded.has(key) ? ' folded' : ''}`)
  button.append(el('span', 'chev', '▾'), el('span', '', title))
  if (summaryText) button.append(el('span', 'sum', summaryText))
  button.addEventListener('click', () => {
    if (folded.has(key)) folded.delete(key)
    else folded.add(key)
    localStorage.setItem('tray.folded', JSON.stringify([...folded]))
    if (last) render(last)
  })
  return button
}

function banner(summary) {
  const items = summary.attention
  if (!items.length) return el('div', 'clear', '✓ 확인할 일 없음')
  const box = el('div', 'banner')
  for (const item of items.slice(0, BANNER_ROWS)) {
    const row = el('button', 'it')
    row.title = item.text
    row.append(el('span', `mark ${item.mark === '!' ? 'b' : 'r'}`, item.mark), el('span', 'tx', item.text), el('span', 'go', '↗'))
    row.addEventListener('click', () => (item.kind === 'pane' ? trayPanel.action('focus-pane', item.id) : trayPanel.action('open-card', item.html)))
    box.append(row)
  }
  if (items.length > BANNER_ROWS) {
    const more = el('button', 'it')
    more.append(el('span', 'mark', '…'), el('span', 'tx', `${items.length - BANNER_ROWS}개 더 — 현황판에서`))
    more.addEventListener('click', () => trayPanel.action('show', 'board'))
    box.append(more)
  }
  return box
}

// 작업 공간별 묶음 — 막힌 쪽이 있는 묶음 먼저, 그 안은 막힘 · 작업 중 · 대기 순(요약이 이미 그 순서)
function agentGroups(agents) {
  const groups = new Map()
  for (const agent of agents) {
    const key = agent.workspace || '작업 공간 없음'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(agent)
  }
  const rank = (list) => {
    if (list.some((agent) => agent.status === 'blocked')) return 0
    if (list.some((agent) => agent.status === 'working')) return 1
    return 2
  }
  return [...groups.entries()].sort((left, right) => rank(left[1]) - rank(right[1]))
}

function agentsBlock(summary) {
  const agents = summary.agents
  const wrap = el('div', 'agents')
  if (!agents.length) {
    const empty = el('div', 'empty', '돌고 있는 에이전트가 없어요')
    const open = el('button', '', 'Athena 열기')
    open.addEventListener('click', () => trayPanel.action('show', 'work'))
    empty.append(open)
    wrap.append(empty)
    return wrap
  }
  for (const [workspace, list] of agentGroups(agents)) {
    wrap.append(el('div', 'grp', workspace))
    for (const agent of list) {
      const row = el('button', 'row')
      row.title = `${agent.name} · ${workspace} — 누르면 그 pane 으로`
      row.append(el('span', `dot ${agent.status}`), el('span', 'tx', agent.name), el('span', 'st', STATUS[agent.status] || agent.status))
      row.addEventListener('click', () => trayPanel.action('focus-pane', agent.id))
      wrap.append(row)
    }
  }
  return wrap
}

// 도구마다 링 하나(가장 높은 창) + 창별 작은 글씨
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
    const top = windows.reduce((best, item) => (item.percent > best.percent ? item : best))
    const ring = el('div', `ring${top.percent >= 80 ? ' hi' : ''}`)
    ring.style.setProperty('--p', String(top.percent))
    ring.append(el('span', '', String(top.percent)))
    const text = el('div', '', tool)
    for (const item of windows) text.append(el('small', '', `${item.window} ${item.percent}%${item.reset ? ` · ${item.reset}` : ''}`))
    const unit = el('div', 'u')
    unit.append(ring, text)
    box.append(unit)
  }
  return box
}

function kanbanBlock(summary) {
  const box = el('div', 'nums')
  for (const [key, label] of COLUMNS) {
    const cell = el('button')
    cell.title = '현황판에서 보기'
    cell.append(el('b', '', String(summary.columns[key] || 0)), el('small', '', label))
    cell.addEventListener('click', () => trayPanel.action('show', 'board'))
    box.append(cell)
  }
  return box
}

function render(data) {
  last = data
  const { summary } = data
  drawSpark(data.history)
  const conn = $('conn')
  conn.textContent = summary.boardUp ? '● 연결됨' : '● 연결 안 됨'
  conn.classList.toggle('off', !summary.boardUp)
  conn.title = `현황판 마지막 확인 ${clock(data.boardAt)}`

  const parts = [banner(summary)]
  const working = summary.counts.working
  parts.push(section('agents', '에이전트', `작업 중 ${working} · 대기 ${summary.idleAgents}${summary.blockedAgents ? ` · 막힘 ${summary.blockedAgents}` : ''}`))
  if (!folded.has('agents')) parts.push(agentsBlock(summary))
  parts.push(section('usage', '사용량'))
  if (!folded.has('usage')) parts.push(usageBlock(summary))
  // 현황판이 꺼져 있으면 칸반은 숨긴다(0 으로 보이지 않게)
  if (summary.boardUp) {
    parts.push(section('kanban', '칸반', `진행 ${summary.columns.doing || 0} · 리뷰 ${summary.columns.review || 0}`))
    if (!folded.has('kanban')) parts.push(kanbanBlock(summary))
  }
  $('body').replaceChildren(...parts)

  // 알림을 일시 중지했을 때만 머리줄에 🔕(언제까지는 마우스를 올리면)
  const paused = data.pausedUntil > Date.now()
  $('bell').hidden = !paused
  $('bell').title = paused ? `${clock(data.pausedUntil)}까지 알림 끔 — ☰ 에서 다시 켜기` : ''
  // 내용 높이에 맞춰 창을(최대는 main 이 화면 높이로 자른다)
  // 머리줄 + 본문의 실제 높이 그대로(어림 여백을 더하지 않는다 — 남는 자리가 띠로 보인다)
  requestAnimationFrame(() => trayPanel.reportHeight(Math.ceil($('hd').getBoundingClientRect().height + $('body').scrollHeight)))
}

$('menu').addEventListener('click', () => trayPanel.action('menu'))
trayPanel.onUpdate(render)
