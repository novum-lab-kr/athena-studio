// renderer.js 에서 옮김(R3c · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만
import { $ } from './core.ts'

// 툴팁 — data-tip 버튼 위에 잠깐 머물면 버튼 아래 가운데에 띄운다(화면 밖으로 나가면 안쪽으로 당기고, 아래가 모자라면 위로 · 세로 아이콘 줄은 오른쪽)
// 아이콘 버튼(글자가 거의 없는 button)의 title 도 여기로 옮겨 같은 툴팁으로 — 기본 title 툴팁은 탭 줄 등에서 안 뜬다
const TIP_SELECTOR = '[data-tip], button[title], .studio-tab .close[title]' // 탭의 ✕ 는 button 이 아니라 span
const ICON_TEXT_MAX = 2 // ＋ · ✕ · 접힌 작업 공간 머리글자(두 글자)까지
function tipTarget(element: EventTarget | null): HTMLElement | null {
  const node = element instanceof Element ? element.closest<HTMLElement>(TIP_SELECTOR) : null
  if (!node) return null
  if (node.hasAttribute('title')) {
    if (!node.dataset.tip && node.textContent.trim().length > ICON_TEXT_MAX) return null // 글자 버튼은 기본 title 그대로
    // 옆 브라우저 바는 기본 title 그대로 — 아래로 띄우면 페이지 자리의 네이티브 뷰에 가려진다
    if (node.closest('#browser')) return null
    // 코드가 title 을 다시 넣었을 수도 있어(언어 바꿈 · 상태 바뀜) 볼 때마다 옮긴다
    node.dataset.tip = node.title
    if (!node.hasAttribute('aria-label')) node.setAttribute('aria-label', node.title)
    node.removeAttribute('title')
  }
  return node.dataset.tip ? node : null
}
const TIP_DELAY_MS = 350
const TIP_GAP = 6
export function initTips(): void {
  const tip = $('tip')
  let target: HTMLElement | null = null
  let timer: number | null = null
  const hide = () => {
    clearTimeout(timer as number | undefined)
    tip.hidden = true
    target = null
  }
  const show = (node: HTMLElement) => {
    tip.textContent = node.dataset.tip as string
    tip.hidden = false
    const rect = node.getBoundingClientRect()
    const box = tip.getBoundingClientRect()
    // 세로 아이콘 줄(팩 줄 · 접힌 spaces)은 아래로 띄우면 다음 아이콘을 가려서 오른쪽에
    if (node.closest('.pack-rail, .spaces.collapsed')) {
      tip.style.left = `${rect.right + TIP_GAP}px`
      tip.style.top = `${Math.max(4, Math.min(rect.top + rect.height / 2 - box.height / 2, innerHeight - box.height - 4))}px`
      return
    }
    const left = rect.left + rect.width / 2 - box.width / 2
    tip.style.left = `${Math.max(4, Math.min(left, innerWidth - box.width - 4))}px`
    // 아래 자리가 모자라면(맨 아래 접힌 에이전트 모니터 등) 버튼 위로
    const below = rect.bottom + TIP_GAP
    tip.style.top = `${below + box.height > innerHeight - 4 ? rect.top - TIP_GAP - box.height : below}px`
  }
  // 띄울 때는 그 자리의 버튼을 다시 찾는다 — 왼쪽 spaces 는 데몬 상태마다 다시 그려져 기다리는 사이 버튼이 바뀐다
  const tipAt = (point: { x: number; y: number }) => tipTarget(document.elementFromPoint(point.x, point.y))
  document.addEventListener('mouseover', (event) => {
    const node = tipTarget(event.target)
    if (node === target) return
    // 다시 그려져 같은 버튼이 새 요소로 바뀐 것뿐이면(탭 줄 · spaces) 툴팁을 그대로 둔다
    if (node && target && node.dataset.tip === target.dataset.tip) {
      target = node
      return
    }
    hide()
    if (!node) return
    target = node
    const point = { x: event.clientX, y: event.clientY }
    timer = setTimeout(() => {
      const now = node.isConnected ? node : tipAt(point)
      if (!now) return
      target = now
      show(now)
    }, TIP_DELAY_MS)
  })
  document.addEventListener('mousedown', hide)
  window.addEventListener('blur', hide)
  // 창 밖이나 옆 브라우저 화면(네이티브 뷰) 위로 바로 나가면 mouseover 가 안 온다 — 남지 않게
  document.documentElement.addEventListener('mouseleave', hide)
}
