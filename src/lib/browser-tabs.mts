// 옆 브라우저 탭 판단 — 어느 탭에 열고 무엇을 앞에 보일지(뷰를 만지는 일은 src/main/side-browser.mts)
// 결정 콘솔은 탭 하나씩 차지해 다른 페이지 때문에 사라지지 않고, 콘솔 아닌 페이지는 탭 하나를 같이 쓴다

export type BrowserTab = { id: number; url: string }

export type OpenRequest = {
  tabs: BrowserTab[]
  activeId: number | null
  url: string
  fromUser: boolean // 사용자가 직접 연 것(링크 · 계획서 누르기) — 에이전트가 연 것은 보던 화면을 뺏지 않는다
  showing: boolean // 지금 페이지가 화면에 붙어 있는지(서랍이 닫혀 있으면 false)
}

// tabId null 이면 새 탭 · navigate false 면 이미 그 페이지라 고르던 것을 지키려고 다시 읽지 않는다
export type OpenPlan = { tabId: number | null; navigate: boolean; activate: boolean }

export function isConsoleUrl(url: string): boolean {
  try {
    const page = new URL(url)
    return (page.protocol === 'http:' || page.protocol === 'https:') && /^\/plans\/.+\.html$/.test(page.pathname)
  } catch {
    return false
  }
}

function samePage(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left)
    const rightUrl = new URL(right)
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname
  } catch {
    return false
  }
}

export function planOpen({ tabs, activeId, url, fromUser, showing }: OpenRequest): OpenPlan {
  const active = tabs.find((tab) => tab.id === activeId)
  const activeIsConsole = Boolean(active) && isConsoleUrl(active!.url)
  const opensConsole = isConsoleUrl(url)
  const nothingToKeep = !active || !active.url
  const activate = fromUser || nothingToKeep || (!activeIsConsole && !(opensConsole && showing))
  if (opensConsole) {
    const same = tabs.find((tab) => samePage(tab.url, url))
    if (same) return { tabId: same.id, navigate: false, activate }
    const blank = tabs.find((tab) => !tab.url)
    return { tabId: blank ? blank.id : null, navigate: true, activate }
  }
  const pageTab = tabs.find((tab) => !isConsoleUrl(tab.url))
  return { tabId: pageTab ? pageTab.id : null, navigate: true, activate }
}

// 탭을 닫은 뒤 — 보던 탭이 닫혔으면 옆 탭(오른쪽 먼저)으로. 콘솔을 보내 닫았으면 다음 콘솔을 먼저 고르고, 남은 콘솔이 없으면 서랍도 닫는다
export function afterClose({ tabs, closedId, activeId, sent }: { tabs: BrowserTab[]; closedId: number; activeId: number | null; sent: boolean }): { activeId: number | null; closeDrawer: boolean } {
  const index = tabs.findIndex((tab) => tab.id === closedId)
  const rest = tabs.filter((tab) => tab.id !== closedId)
  if (closedId !== activeId) return { activeId, closeDrawer: false }
  const consoles = rest.filter((tab) => isConsoleUrl(tab.url))
  const pool = sent && consoles.length ? consoles : rest
  const right = pool.find((tab) => rest.indexOf(tab) >= index)
  const next = right || pool[pool.length - 1]
  return { activeId: next ? next.id : null, closeDrawer: !next || (sent && !consoles.length) }
}
