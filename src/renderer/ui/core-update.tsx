// 코어 업데이트 뒤 결과 팝업(core-update) 몸통 — 머리(아이콘 · 제목 · 이전 → 새 버전) · 업데이트 내역 · 결과 상자 · [확인]
// 껍데기(보이기 · 숨기기 · 뒤 화면 막기 · Esc · 포커스 돌려주기)는 바닐라 pack-dialogs.ts showCoreUpdate. main 이 켤 때 한 번 보낸다(src/main/core-runner.mts)
import { flushSync } from 'react-dom'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'
import { noteText } from '../../lib/release-notes.mts'
import type { CoreUpdateRow, CoreUpdateView, NoteKind } from '../../lib/release-notes.mts'

type Shown = { view: CoreUpdateView; close: () => void } | null
const shown = createStore<Shown>(null)

// 켤 때 한 번 — 팝업 상자(.pack-box)에 띄운다(내리지 않는다)
export function mount(box: HTMLElement): void {
  mountIsland(box, <CoreUpdateBody />)
}

// 그리기는 바로(flushSync) — 바닐라가 곧이어 상자를 보이고 [확인] 에 포커스를 준다
export function show(view: CoreUpdateView, close: () => void): void {
  flushSync(() => shown.set({ view, close }))
}

export function clear(): void {
  shown.set(null)
}

const ROW_TONE: Record<CoreUpdateRow['kind'], 'good' | 'warn'> = { skipped: 'warn', working: 'good', backedUp: 'good', failed: 'warn', unsupported: 'warn', notMoved: 'warn' }

function RowIcon({ tone }: { tone: 'good' | 'warn' }) {
  return (
    <span className={`cu-row-icon ${tone}`} aria-hidden="true">
      <svg viewBox="0 0 24 24">{tone === 'good' ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <path d="M12 7v6M12 17v.01" />}</svg>
    </span>
  )
}

function CoreUpdateBody() {
  const say = useSay()
  const current = useStore(shown)
  if (!current) return null
  const { view, close } = current
  const notes = view.notes
  return (
    <>
      <div className="cu-head">
        <span className="cu-head-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 19h14" />
          </svg>
        </span>
        <div className="cu-head-text">
          <h2 id="core-update-title">{say(view.changed ? 'coreUpdate.title' : 'coreUpdate.titleKept')}</h2>
          {view.from && view.to ? (
            <p className="cu-versions">
              <span className="cu-chip" title={say('coreUpdate.from')}>
                {view.from}
              </span>
              <span className="cu-arrow" aria-hidden="true">
                →
              </span>
              <span className="cu-chip new" title={say('coreUpdate.to')}>
                {view.to}
              </span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="cu-body">
        {notes ? (
          <section className="cu-notes">
            <h3>{say(notes.recent ? 'coreUpdate.notesRecent' : 'coreUpdate.notes')}</h3>
            <ul>
              {notes.shown.map((note, index) => (
                <li key={index}>
                  <span className={`cu-tag ${note.kind}`}>{say(`coreUpdate.kind.${note.kind}`)}</span>
                  <span className="cu-note-text">{noteText(note, document.documentElement.lang)}</span>
                </li>
              ))}
            </ul>
            {notes.rest ? <MoreButton rest={notes.rest} url={view.releasesUrl} say={say} /> : null}
          </section>
        ) : null}
        <section className="cu-result">
          {view.rows.map((row, index) => (
            <div className="cu-row" key={index}>
              <RowIcon tone={ROW_TONE[row.kind]} />
              <div className="cu-row-main">
                <p>{say(`coreUpdate.row.${row.kind}`, row.params)}</p>
                {row.chips.length ? (
                  <div className="cu-chips">
                    {row.chips.map((chip, chipIndex) => (
                      <span className="cu-chip" key={chipIndex}>
                        {chip}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {row.dir ? (
                <button type="button" className="pack-button" onClick={() => void studio.coreUpdateReveal(row.dir as string)}>
                  {say('coreUpdate.openFolder')}
                </button>
              ) : null}
            </div>
          ))}
        </section>
      </div>
      <div className="pack-actions cu-actions">
        <button type="button" className="primary" data-confirm onClick={close}>
          {say('common.ok')}
        </button>
      </div>
    </>
  )
}

// "외 N개 더 보기 · 새 기능 a · 수정 b" — 홈페이지 릴리스 페이지를 바깥 브라우저로
function MoreButton({ rest, url, say }: { rest: { count: number; kinds: { kind: NoteKind; count: number }[] }; url: string; say: Say }) {
  const parts = rest.kinds.map((entry) => `${say(`coreUpdate.kind.${entry.kind}`)} ${entry.count}`)
  return (
    <button type="button" className="cu-more" onClick={() => void studio.openUrl(url)}>
      {[say('coreUpdate.more', { count: rest.count }), ...parts].join(' · ')}
    </button>
  )
}
