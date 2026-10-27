// 팩 세로 줄(pack-rail) — 팩마다 이름 두 글자(또는 팩 이미지) + 이름 색 · 지금 팩 강조 · 다른 창에 열린 팩 점 · 맨 아래 ＋
// PR-R10. 줄 껍데기(보이기 · 숨기기 — 팩을 지원 · 본체가 정해짐 · 팩이 있을 때)와 누른 뒤의 팩 흐름(바꾸기 · 이름 · 이미지 · 우클릭 메뉴 · 만들기 · 가져오기 ·
// 내보내기 · 진행 중 막기 runPackFlow)은 renderer.js 그대로. 받은 팩 목록 · 고른 팩 표시 · 팩 이미지 받기(캐시)와 그리기는 여기서 한다.
// 다른 팝업과 달리 열고 닫지 않는다 — 켤 때 한 번 띄워 두고 계속 쓴다(모니터 칸과 같다)
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

// 팩 목록 한 줄 — main 이 넘기는 pack:state 의 packs[] · current(코어 athena/scripts/lib/packs.mjs packInfo · currentOf + pack-look.mjs packLook)
export type PackItem = {
  id: string
  name?: string
  displayName?: string | null
  iconPath?: string | null
  iconUpdatedAt?: string | null
  repos?: number
  source?: string
  empty?: boolean
  hasWork?: boolean
}

// 바닐라가 넘긴다 — 작업 공간 아이콘과 같은 이름 색 · 두 글자(space-actions.ts spaceColor · spaceInitials)
export type PackLookOptions = {
  spaceColor: (label: string) => string
  spaceInitials: (label: string) => string
}

// 누르면 바닐라 팩 흐름으로 — open: 한 번 누름(이 창에서 그 팩으로) · edit: 더블클릭(이름 · 이미지) · menu: 우클릭 · add: ＋
export type PackRailActions = {
  open: (id: string) => void
  edit: (id: string) => void
  menu: (id: string, x: number, y: number) => void
  add: () => void
}

// rows — 지금 팩이 목록에 없으면 앞에 더한 줄(renderer.js packRows) · selectedId — 바꾸는 중인 팩이 있으면 그 팩, 없으면 지금 팩
export type PackRailView = {
  rows: PackItem[]
  current: PackItem | null
  openIds: string[]
  selectedId: string | null
}

const DOUBLE_CLICK_MS = 260 // 팩 아이콘 — 이 안에 다시 누르면 더블클릭(열기 대신 이름 · 이미지 바꾸기)

// 아직 그리기 전(첫 render 전)이면 비워 둔다 — 바닐라가 처음 그리기 전과 같은 빈 줄
const view = createStore<PackRailView | null>(null)

let options: PackLookOptions = {
  spaceColor: () => '',
  spaceInitials: (label) => label,
}
let actions: PackRailActions = {
  open: () => {},
  edit: () => {},
  menu: () => {},
  add: () => {},
}

export const lookOptions = (): PackLookOptions => options

// 켤 때 한 번(내리지 않는다)
export function mount(rail: HTMLElement, nextActions: PackRailActions, nextOptions: PackLookOptions): void {
  actions = nextActions
  options = nextOptions
  mountIsland(rail, <PackRail />)
}

// 바닐라가 replaceChildren 하던 때처럼 바로(flushSync) — 그린 다음 줄의 코드가 새 버튼을 본다
export function render(next: PackRailView): void {
  flushSync(() => view.set(next))
}

// 고른 팩 표시만 — 버튼은 그대로 두고 aria-current 만 바뀐다(진행 팝업이 닫힐 때 · 바꾸기가 끝날 때)
export function select(selectedId: string | null): void {
  const state = view.get()
  if (state) flushSync(() => view.set({ ...state, selectedId }))
}

// 화면에 보일 팩 이름 — 표시 이름(팩 안에 저장 · 팀과 같이) → 이름 → id
export const packLabel = (pack: PackItem | null | undefined): string => (pack && (pack.displayName || pack.name || pack.id)) || ''

// 지금 팩 이름 — pack new 로 만든 빈 자리(5.4 current.empty)는 /setup 중
function currentLabel(say: Say, current: PackItem | null): string {
  if (!current) return say('pack.none')
  if (current.empty) return say('pack.newSetup')
  return packLabel(current)
}

// 팩 이미지 — main 이 iconPath 를 읽어 data URL 로 준다. iconUpdatedAt 이 바뀌면 다시 받는다(캐시 깨기). 팩 목록 대화상자(pack-menu.tsx)도 같이 쓴다
type IconEntry = { stamp: string; dataUrl: string | null }
const icons = createStore<ReadonlyMap<string, IconEntry>>(new Map())
const iconPending = new Set<string>()

function putIcon(id: string, entry: IconEntry): void {
  icons.set(new Map(icons.get()).set(id, entry))
}

function requestIcon(id: string, stamp: string): void {
  if (iconPending.has(id)) return
  iconPending.add(id)
  // 받는 중 표시를 먼저 지우고 캐시에 넣는다 — 그사이 이미지가 바뀌었으면(stamp 다름) 다시 그릴 때 새로 받는다
  const settle = (dataUrl: string | null) => {
    iconPending.delete(id)
    putIcon(id, { stamp, dataUrl })
  }
  studio
    .packIcon(id)
    .then((result) => settle((result && result.dataUrl) || null))
    .catch(() => settle(null)) // 실패도 적어 둔다 — 안 그러면 다시 그릴 때마다 또 요청한다
}

// 받은 이미지 data URL — 없거나 받는 동안은 null(두 글자)
function usePackIcon(item: PackItem): string | null {
  const cache = useStore(icons)
  const stamp = item.iconPath ? `${item.iconPath}|${item.iconUpdatedAt || ''}` : null
  const cached = cache.get(item.id)
  const fresh = Boolean(stamp) && cached !== undefined && cached.stamp === stamp
  useEffect(() => {
    if (stamp && !fresh) requestIcon(item.id, stamp)
  }, [item.id, stamp, fresh])
  return fresh && cached ? cached.dataUrl : null
}

// 아이콘 안 — 팩 이미지가 있으면 그림, 없으면 이름 두 글자
export function PackFace({ item }: { item: PackItem }) {
  const image = usePackIcon(item)
  if (image) return <img className="pack-icon-image" src={image} alt="" draggable={false} />
  return <>{options.spaceInitials(packLabel(item))}</>
}

function PackRail() {
  const state = useStore(view)
  const say = useSay()
  if (!state) return null
  const add = say('pack.rail.add')
  return (
    <>
      {state.rows.map((item) => {
        const isCurrent = Boolean(state.current) && state.current?.id === item.id
        return (
          <PackButton
            key={item.id}
            item={item}
            isCurrent={isCurrent}
            name={isCurrent ? currentLabel(say, state.current) : packLabel(item)}
            openElsewhere={!isCurrent && state.openIds.includes(item.id)}
            selected={item.id === state.selectedId}
          />
        )
      })}
      <button className="space-icon add pack-add" data-tip={add} aria-label={add} onClick={() => actions.add()}>
        ＋
      </button>
    </>
  )
}

type PackButtonProps = {
  item: PackItem
  isCurrent: boolean
  name: string
  openElsewhere: boolean
  selected: boolean
}

function PackButton({ item, isCurrent, name, openElsewhere, selected }: PackButtonProps) {
  // 한 번 누르면 이 창에서 그 팩으로 바꾼다(조금 기다렸다 — 더블클릭이면 이름 · 이미지 바꾸기로)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onClick = () => {
    clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => actions.open(item.id), DOUBLE_CLICK_MS)
  }
  return (
    <button
      // 다른 창에 열려 있는 팩 — 작은 점(누르면 그 창이 앞으로)
      className={`space-icon pack-icon${openElsewhere ? ' open-elsewhere' : ''}`}
      style={{ '--space-color': options.spaceColor(item.id) } as CSSProperties} // 색은 id 로 — 이름을 바꿔도 그대로
      data-pack-id={item.id}
      aria-current={selected ? 'true' : 'false'}
      aria-label={name}
      data-tip={name} // 툴팁은 팩 이름만
      onClick={isCurrent ? undefined : onClick}
      onDoubleClick={(event) => {
        event.preventDefault()
        clearTimeout(clickTimer.current)
        actions.edit(item.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        actions.menu(item.id, Math.round(event.clientX), Math.round(event.clientY))
      }}
    >
      <PackFace item={item} />
    </button>
  )
}
