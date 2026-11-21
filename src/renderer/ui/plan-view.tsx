// [작업] 줄을 누르면 뜨는 계획서 화면 몸통(pack-dialog-body) — 머리(상태 · 진행 수 · 버튼) · 진행 칸 · 요약(왜 · 막힌 것 · 정한 것 · 검증 · 다음 · 결과 · 커밋) · 계획서 본문 절.
// 대화상자 껍데기(제목 · ✕ · Esc · 포커스 돌려주기)는 바닐라 packDialog(pack-dialogs.ts) — 여기 버튼은 data-value 로 그 대화상자를 끝낸다(work.ts openWorkDetail 이 값을 받아 연다).
// md 는 lib/plan-doc.mts 가 조각으로 나눈 것만 그린다(HTML 을 만들어 넣지 않는다 · 링크는 http(s) 만 studio.openUrl 로)
import { mountIsland, useSay } from './bridge.ts'
import { inlineParts, planCommits, planSections } from '../../lib/plan-doc.mts'
import type { ReactNode } from 'react'
import type { ListItem, PlanBlock } from '../../lib/plan-doc.mts'

type WorkState = WorkItemView['state']
type Detail = Extract<WorkDetailReply, { ok: true }>
// showConsole: 결정 콘솔(html)이 있는 계획서 · showPane: 살아 있는 담당 pane 이 있다
export type PlanViewProps = { state: WorkState; detail: WorkDetailReply | null; showConsole: boolean; showPane: boolean }

// 요약 칸으로 따로 그리는 절 — 본문 절 목록에서는 뺀다(경량 계획서는 Commits 가 ## 절이다)
const SUMMARY_SECTIONS = ['Checkpoint', 'Commits']

let unmount: (() => void) | null = null

export function open(container: HTMLElement, props: PlanViewProps): void {
  close()
  unmount = mountIsland(container, <PlanView {...props} />)
}

export function close(): void {
  if (!unmount) return
  unmount()
  unmount = null
}

function PlanView({ state, detail, showConsole, showPane }: PlanViewProps) {
  const say = useSay()
  const read = detail && detail.ok ? detail : null
  return (
    <div className="plan-view">
      <div className="plan-head">
        <span className="work-state" data-state={state}>
          {say(`work.state.${state}`)}
        </span>
        {read && read.progress.total > 0 && <span className="plan-count">{`${read.progress.checked}/${read.progress.total}`}</span>}
        <span className="plan-tools">
          <ToolButton value="plan" tip={say('work.detail.openPlan')}>
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M9 13h6" />
            <path d="M9 17h6" />
          </ToolButton>
          {showConsole && (
            <ToolButton value="console" tip={say('work.detail.console')}>
              <path d="M4 7h10" />
              <path d="M18 7h2" />
              <circle cx="16" cy="7" r="2" />
              <path d="M4 17h2" />
              <path d="M10 17h10" />
              <circle cx="8" cy="17" r="2" />
            </ToolButton>
          )}
          {showPane && (
            <ToolButton value="pane" tip={say('work.detail.goPane')} accent>
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 10l3 2-3 2" />
              <path d="M12 14h4" />
            </ToolButton>
          )}
        </span>
      </div>
      {read ? <PlanBody detail={read} /> : <p className="muted">{say('work.detail.unreadable')}</p>}
    </div>
  )
}

// 아이콘 버튼 — 글자 없이 아이콘 + 툴팁(tips.ts data-tip) · 누르면 대화상자가 data-value 로 끝난다
function ToolButton({ value, tip, accent = false, children }: { value: string; tip: string; accent?: boolean; children: ReactNode }) {
  return (
    <button className={accent ? 'plan-tool accent' : 'plan-tool'} type="button" data-value={value} data-tip={tip} aria-label={tip}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}

function PlanBody({ detail }: { detail: Detail }) {
  const say = useSay()
  const commits = planCommits(detail.text)
  const sections = planSections(detail.text, SUMMARY_SECTIONS)
  const nowIndex = detail.steps.findIndex((step) => !step.done)
  const stepClass = (done: boolean, index: number): string => {
    if (done) return 'done'
    return index === nowIndex ? 'now' : ''
  }
  return (
    <>
      {detail.steps.length > 0 && (
        <section className="plan-card">
          <h3>{say('work.detail.progress')}</h3>
          <span className="work-steps">
            {detail.steps.map((step, index) => (
              <i key={index} className={stepClass(step.done, index)} />
            ))}
          </span>
          <ol className="plan-steps">
            {detail.steps.map((step, index) => (
              <li key={index} className={stepClass(step.done, index)}>
                <span className="plan-step-mark" aria-hidden="true" />
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="plan-card plan-fields">
        <Field name={say('work.detail.why')} lines={[detail.why]} />
        <Field name={say('work.detail.blocked')} lines={[detail.blocked]} tone="blocked" />
        <Field name={say('work.detail.decided')} lines={detail.decided} />
        <Field name={say('work.detail.validation')} lines={[detail.validation]} />
        <Field name={say('work.detail.next')} lines={[detail.next]} />
        <Field name={say('work.detail.results')} lines={detail.results} />
        <Field name={say('work.detail.commits')} lines={commits} />
      </section>
      {sections.map((section, index) =>
        section.title === '' ? (
          <div key={index} className="plan-md">
            <Blocks blocks={section.blocks} />
          </div>
        ) : (
          // 본문 절은 처음부터 펼쳐 둔다(2026-11-21 사용자 화면 확인) — 머리를 누르면 접을 수는 있다
          <details key={index} className="plan-sec" open>
            <summary>{section.title}</summary>
            <div className="plan-md">
              <Blocks blocks={section.blocks} />
            </div>
          </details>
        ),
      )}
    </>
  )
}

// 요약 한 칸 — 값이 없으면 그리지 않는다
function Field({ name, lines, tone = '' }: { name: string; lines: string[]; tone?: string }) {
  const filled = lines.filter(Boolean)
  if (!filled.length) return null
  return (
    <div className="work-field" data-tone={tone || undefined}>
      <span className="work-field-key">{name}</span>
      <span className="work-field-value">
        {filled.map((line, index) => (
          <span key={index} className="work-field-line">
            <Inline text={line} />
          </span>
        ))}
      </span>
    </div>
  )
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) => {
        if (part.kind === 'code') return <code key={index}>{part.text}</code>
        if (part.kind === 'bold') return <b key={index}>{part.text}</b>
        if (part.kind === 'link') {
          const href = part.href
          return (
            <button key={index} className="plan-link" type="button" onClick={() => void studio.openUrl(href)}>
              {part.text.replace(/^https:\/\/github\.com\//, '')}
            </button>
          )
        }
        return part.text
      })}
    </>
  )
}

function Blocks({ blocks }: { blocks: PlanBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

function Block({ block }: { block: PlanBlock }) {
  if (block.kind === 'heading') return <h4>{block.text}</h4>
  if (block.kind === 'code') return <pre>{block.text}</pre>
  if (block.kind === 'para' || block.kind === 'quote') {
    return (
      <p className={block.kind === 'quote' ? 'plan-quote' : undefined}>
        <Inline text={block.text} />
      </p>
    )
  }
  if (block.kind === 'list') {
    return (
      <ul className="plan-list">
        {block.items.map((item, index) => (
          <li key={index} className={itemClass(item)} style={{ marginLeft: `${item.depth * 16}px` }}>
            <span className="plan-item-mark" aria-hidden="true" />
            <span>
              <Inline text={item.text} />
            </span>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="plan-table">
      <table>
        <thead>
          <tr>
            {block.head.map((cell, index) => (
              <th key={index}>
                <Inline text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index}>
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 목록 줄 — 체크 칸(끝남 · 남음) · 그냥 점
function itemClass(item: ListItem): string {
  if (item.check === null) return 'dot'
  return item.check ? 'checked' : 'unchecked'
}
