// 시작 화면 몸통(#pack-welcome 안 .pack-welcome-inner) — 로고 · 제목 · 새 팩 만들기 · 팩 가져오기 · '내 팩'(최근 팩)
// PR-R7. 껍데기(#pack-welcome 보이기 · 숨기기 · 모니터 접기 · 현황판 · 브라우저 아이콘 끄기 · 양쪽 접기)는 바닐라 pack-switch.ts renderPackWelcome,
// 몸통만 여기서 그린다. 무엇을 띄울지(팩이 없으면 '내 팩' 없음 · 켤 때 시작 화면) 규칙은 main(pack.mts)과 pack-switch.ts 가 정하고 목록만 넘긴다
// 로고는 Vite 가 묶는다(옛 index.html 의 <img src> 와 같은 결과 파일)
import logo from '../assets/logo/athena-logo-white.png'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

// main 의 packs.recent(src/lib/pack.mts recentPacks) — 지금 팩 맨 위 · 최근 순 · 최대 5개
export type WelcomePack = { id: string; name: unknown; repos: unknown; updatedAt: unknown; current: boolean }
// 누르면 하는 일 — pack-switch.ts 의 팩 흐름(runPackCommand · enterPack)을 그대로 부른다
export type WelcomeActions = { command: (name: 'new' | 'import' | 'picker') => void; enter: (id: string) => void }

const recentStore = createStore<WelcomePack[]>([])
let actions: WelcomeActions = { command: () => {}, enter: () => {} }
let unmount: (() => void) | null = null

// 시작 화면이 떠 있는 동안 renderPackWelcome 이 부를 때마다 — 처음이면 띄우고, 떠 있으면 목록만 바꾼다(포커스가 남는다)
export function open(container: HTMLElement, recent: WelcomePack[], next: WelcomeActions): void {
  actions = next
  recentStore.set(recent)
  if (!unmount) unmount = mountIsland(container, <WelcomeBody />)
}

// 시작 화면이 닫힐 때 — 몸통을 내린다(다시 뜨면 처음부터)
export function close(): void {
  if (!unmount) return
  unmount()
  unmount = null
}

// textContent 에 넣던 값과 같게 — null · undefined 는 빈 글
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

function WelcomeBody() {
  const say = useSay()
  const recent = useStore(recentStore)
  return (
    <>
      <img className="pack-welcome-logo" src={logo} alt="" draggable={false} />
      <h1>Athena</h1>
      <button className="pack-welcome-action" onClick={() => actions.command('new')}>
        <span className="icon" aria-hidden="true">
          <CartridgeIcon />
        </span>
        <span>
          <b>{say('pack.welcome.new')}</b>
          <small>{say('pack.welcome.newNote')}</small>
        </span>
      </button>
      <button className="pack-welcome-action" onClick={() => actions.command('import')}>
        <span className="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v10" />
            <path d="M8 9.5 12 13.5 16 9.5" />
            <path d="M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14" />
          </svg>
        </span>
        <span>
          <b>{say('pack.welcome.import')}</b>
          <small>{say('pack.welcome.importNote')}</small>
        </span>
      </button>
      {/* 내 팩 — 목록이 비면(팩이 없을 때 포함) 숨긴다 */}
      <div id="pack-welcome-recent" className="pack-welcome-recent" hidden={!recent.length}>
        <div className="pack-welcome-recent-head">
          <span>{say('pack.welcome.recentTitle')}</span>
          <button className="link" onClick={() => actions.command('picker')}>
            {say('pack.welcome.recentAll')}
          </button>
        </div>
        <div id="pack-welcome-recent-list">
          {recent.map((item) => <RecentRow key={item.id} item={item} say={say} />)}
        </div>
      </div>
    </>
  )
}

// 팩 줄 — 지금 팩이면 '지금' · 레포 수 · (지금 팩이 아니면) 마지막 작업 날짜 M/D
function RecentRow({ item, say }: { item: WelcomePack; say: Say }) {
  const date = item.updatedAt ? new Date(item.updatedAt as string) : null
  const when = date && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}/${date.getDate()}` : ''
  const meta = [item.current ? say('pack.meta.current') : '', Number.isFinite(item.repos) ? say('pack.meta.repos', { count: item.repos as number }) : '', item.current ? '' : when].filter(Boolean).join(' · ')
  return (
    <button className="pack-welcome-recent-row" data-pack-id={item.id} aria-current={item.current ? 'true' : undefined} onClick={() => actions.enter(item.id)}>
      <span className="icon" aria-hidden="true">
        <CartridgeIcon />
      </span>
      <span className="name">{text(item.name)}</span>
      <span className="meta">{meta}</span>
    </button>
  )
}

// 팩 카트리지 그림 — 새 팩 만들기 · '내 팩' 줄이 같이 쓴다(옛 index.html 의 <template id="cartridge-icon">)
function CartridgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
      <path d="M6 3h12a1 1 0 0 1 1 1v12.5l-2 2V21H7v-2.5l-2-2V4a1 1 0 0 1 1-1z" />
      <path d="M8.5 7h7v5h-7z" />
      <path d="M9 18.5v2M12 18.5v2M15 18.5v2" />
    </svg>
  )
}
