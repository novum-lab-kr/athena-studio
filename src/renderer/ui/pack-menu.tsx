// 팩 목록(팩 메뉴 · ⌘⇧P · 시작 화면 [모두 보기…]) 대화상자의 줄 목록 — 아이콘 · 이름 · 한 줄 정보(지금 · 레포 수 · git · 빈 팩 · 작업 기록) · 지금 팩 ✓
// PR-R10. 대화상자 껍데기(packDialog — 제목 · ✕ · Esc · 위아래 화살표 · 고르면 data-value 로 끝내기 · 포커스)와 아래 줄(새로 만들기 · 가져오기 · 내보내기 — packLinks)은
// renderer.js 그대로. 바닐라가 만든 목록 칸(.pack-list)에 열 때 띄우고, 대화상자가 끝나면 내린다
import type { CSSProperties } from 'react'
import { mountIsland, useSay } from './bridge.ts'
import type { Say } from './bridge.ts'
import { PackFace, lookOptions, packLabel } from './pack-rail.tsx'
import type { PackItem } from './pack-rail.tsx'

let unmount: (() => void) | null = null

// rows — 지금 팩이 목록에 없으면 앞에 더한 줄(renderer.js packRows)
export function open(list: HTMLElement, rows: PackItem[], current: PackItem | null): void {
  close()
  unmount = mountIsland(list, <PackList rows={rows} current={current} />)
}

export function close(): void {
  if (!unmount) return
  unmount()
  unmount = null
}

function rowMeta(say: Say, item: PackItem, isCurrent: boolean): string {
  return [
    isCurrent ? say('pack.meta.current') : '',
    item.repos !== undefined ? say('pack.meta.repos', { count: item.repos }) : '',
    item.source === 'git' ? 'git' : '',
    item.empty ? say('pack.meta.empty') : '',
    item.hasWork ? say('pack.meta.hasWork') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function PackList({ rows, current }: { rows: PackItem[]; current: PackItem | null }) {
  const say = useSay()
  return (
    <>
      {rows.map((item) => {
        const isCurrent = Boolean(current) && current?.id === item.id
        return (
          <button key={item.id} className="pack-row" aria-current={isCurrent ? 'true' : 'false'} data-value={`pack:${item.id}`}>
            <span
              className="space-icon pack-icon pack-avatar"
              aria-hidden="true"
              style={
                {
                  '--space-color': lookOptions().spaceColor(item.id),
                } as CSSProperties
              }
            >
              <PackFace item={item} />
            </span>
            <span className="name">{packLabel(item)}</span>
            <span className="meta">{rowMeta(say, item, isCurrent)}</span>
            <span className="pack-current" aria-hidden="true">
              {isCurrent ? '✓' : ''}
            </span>
          </button>
        )
      })}
    </>
  )
}
