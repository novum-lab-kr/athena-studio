// pane [상세] 몸통(pane-detail-body) — 계획서에 묶인 pane 의 상세(에이전트 pane) · 맡긴 일 목록(아테나 pane)
// 껍데기(아이콘 · 열기 · 닫기 · Esc · 바깥 누르기 · 머리줄 · [← 맡긴 일] · 위치 · 미끄러지기 · 포커스)는 바닐라 detail.ts, 몸통만 여기서 그린다.
// 열려 있는 동안 3초마다 다시 읽는다(main ctx.paneDetail — 현황판 카드 · 계획서 · pane 화면 글, 모델 호출 없음)
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'
import { WorkRow } from './work-pop.tsx'
import { rowTarget } from '../../lib/pane-detail.mts'

// 바닐라가 넘기는 것 — 다른 pane 상세 열기 · pane 으로 가기 · 요청 열기는 바닐라 화면(탭 · pane · 대화상자)에 닿는다
export type PaneDetailActions = {
  openPane: (paneId: string, from: { paneId: string; scroll: number }) => void
  openPlan: (plan: PlanRef, from: { paneId: string; scroll: number }) => void // 담당 pane 이 없는 줄 — 같은 칸에서 그 계획서
  goToPane: (paneId: string) => void // 상세를 닫고 그 pane 으로
  paneLive: (paneId: string) => boolean
  openRequest: (id: string) => void
  setLabel: (text: string) => void // 머리줄 pane 이름
}

// 맡긴 일 줄에서 연 계획서 — id 는 plans/**.md 또는 archive/<이름>
export type PlanRef = { id: string; title: string }

const PANE_DETAIL_REFRESH_MS = 3000
// 긴 글은 이만큼만 보이고 [더 보기]
const DETAIL_CLIP: Record<string, number> = { report: 6, request: 3, progress: 5, validation: 4 }
// 지금 상태 점 — 멈춤은 사람 몫이라 금색(답 대기와 같은 색), 에이전트 없음은 회색
const DETAIL_DOT: Record<string, string> = { work: 'work', idle: 'idle', stop: 'wait', gone: 'done' }
const ROW_STATE = { wait: 'wait', now: 'work', done: 'done' } as const

// 무엇을 보이나 — seq 는 열 때마다 1 씩(같은 pane 을 다시 열어도 바로 다시 읽게) · live 가 false 면 닫히는 중(다시 읽지 않고 그린 글만 남긴다)
type Target = { paneId: string; restore: number | null; seq: number; live: boolean; plan: PlanRef | null }
const target = createStore<Target | null>(null)
// [더 보기] 한 글 — `${paneId}:${key}`. 3초 갱신 · 다른 pane 으로 옮겨 가도 그대로 둔다(창이 열려 있는 동안)
const expanded = createStore<ReadonlySet<string>>(new Set())
const expand = (key: string) => expanded.set(new Set([...expanded.get(), key]))

const noActions: PaneDetailActions = { openPane: () => {}, openPlan: () => {}, goToPane: () => {}, paneLive: () => false, openRequest: () => {}, setLabel: () => {} }
let actions = noActions
let unmount: (() => void) | null = null

function unmountNow(): void {
  if (unmount) unmount()
  unmount = null
}

// 상세를 연다 — 처음 열거나 닫히는 중이면 새로 띄우고(읽는 중부터), 열려 있으면 그 pane 으로 바꾼다(다른 pane 이면 읽는 중부터)
// restore: 뒤로 가기로 돌아올 때 맞출 스크롤 — 그 pane 을 처음 그릴 때 한 번 · plan: 맡긴 일 줄에서 연 계획서(paneId 는 그 아테나 pane)
export function open(container: HTMLElement, paneId: string, restore: number | null, next: PaneDetailActions, plan: PlanRef | null = null): void {
  actions = next
  const current = target.get()
  if (!unmount || !current || !current.live) {
    unmountNow()
    expanded.set(new Set())
    target.set({ paneId, restore, seq: 1, live: true, plan })
    unmount = mountIsland(container, <PaneDetail container={container} />)
    return
  }
  flushSync(() => target.set({ paneId, restore, seq: current.seq + 1, live: true, plan }))
}

// 닫기 시작 — 다시 읽기를 멈춘다. 그린 글은 미끄러져 나가는 동안 그대로 둔다
export function stop(): void {
  const current = target.get()
  if (current && current.live) flushSync(() => target.set({ ...current, live: false }))
}

// 숨긴 뒤 — 몸통을 내린다(펼친 글 기억도 버린다)
export function close(): void {
  unmountNow()
  target.set(null)
  expanded.set(new Set())
  actions = noActions
}

function PaneDetail({ container }: { container: HTMLElement }) {
  const current = useStore(target)
  if (!current) return null
  // 다른 pane · 다른 계획서면 처음부터(읽는 중) — key 로 상태를 버린다
  if (current.plan) return <PlanView key={`${current.paneId}:${current.plan.id}`} plan={current.plan} live={current.live} seq={current.seq} />
  return <PaneView key={current.paneId} container={container} target={current} />
}

function PaneView({ container, target: { paneId, restore, seq, live } }: { container: HTMLElement; target: Target }) {
  const say = useSay()
  // null — 읽는 중
  const [detail, setDetail] = useState<PaneDetailView | null>(null)
  const restoreRef = useRef<number | null>(null)

  // 열 때마다 맞출 스크롤을 새로 받는다(그리기 전에)
  useLayoutEffect(() => {
    restoreRef.current = restore
  }, [seq, restore])

  useEffect(() => {
    if (!live) return undefined
    let alive = true
    const load = async () => {
      const next = await studio.paneDetail(paneId)
      if (alive) setDetail(next || { ok: false })
    }
    const timer = setInterval(load, PANE_DETAIL_REFRESH_MS)
    void load()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [paneId, seq, live])

  // 그린 뒤 — 머리줄 pane 이름 · 뒤로 가기 스크롤. 뒤로 간 첫 응답이 오류면 맞출 스크롤도 버린다(나중 갱신에서 그새 옮긴 스크롤을 되돌리지 않게)
  useLayoutEffect(() => {
    if (!detail) return
    actions.setLabel((detail.ok && detail.label) || paneId)
    if (!detail.ok) {
      restoreRef.current = null
      return
    }
    if (restoreRef.current !== null) {
      container.scrollTop = restoreRef.current
      restoreRef.current = null
    }
  }, [detail, paneId, container])

  if (!detail) return <p className="work-empty">{say('work.loading')}</p>
  if (!detail.ok) {
    const known = detail.error === 'board-down' || detail.error === 'no-pane' ? detail.error : 'default'
    return <p className="work-empty">{say(`pane.detail.error.${known}`)}</p>
  }
  if (detail.mode === 'lead') return <LeadSections paneId={paneId} detail={detail} container={container} say={say} />
  return <AgentSections paneId={paneId} detail={detail} say={say} />
}

// 걸린 시간 — 1시간 안은 분, 그 뒤는 시간 · 분
function spanLabel(say: Say, ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60000))
  if (minutes < 60) return say('time.minutes', { n: minutes })
  return `${say('time.hours', { n: Math.floor(minutes / 60) })} ${minutes % 60 ? say('time.minutes', { n: minutes % 60 }) : ''}`.trim()
}

// 바닐라와 같은 언어 — applyStaticTexts 가 <html lang> 에 지금 언어를 둔다
const language = () => document.documentElement.lang

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="work-sec pd-sec">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function MoreButton({ text, moreKey }: { text: string; moreKey: string }) {
  return <button className="pd-more" type="button" onClick={() => expand(moreKey)}>{text}</button>
}

// 긴 줄 목록 — 앞 max 줄만, 나머지는 [더 보기]
function useClipped(paneId: string, key: string, lines: string[], max: number | undefined, say: Say): { shown: string[]; more: ReactNode } {
  const open = useStore(expanded)
  const moreKey = `${paneId}:${key}`
  if (max === undefined || lines.length <= max || open.has(moreKey)) return { shown: lines, more: null }
  return { shown: lines.slice(0, max), more: <MoreButton text={say('pane.detail.more', { n: lines.length - max })} moreKey={moreKey} /> }
}

// 한 줄 글 — 두 줄까지만 보이게 접고, 넘치면 그려진 뒤 [더 보기]. 펼친 것은 expanded 로 기억한다
// 화면에 붙은 뒤에야 넘치는지 안다 — 그릴 때마다 재고 넘친 줄 밑에만 [더 보기]
function ClampLine({ paneId, moreKey, children, say }: { paneId: string; moreKey: string; children: ReactNode; say: Say }) {
  const open = useStore(expanded).has(`${paneId}:${moreKey}`)
  const ref = useRef<HTMLParagraphElement>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    setOver(Boolean(node && !open && node.scrollHeight > node.clientHeight + 1))
  })
  if (open) return <p className="pd-line">{children}</p>
  return (
    <>
      <p ref={ref} className="pd-line pd-clamp" data-more-key={moreKey}>{children}</p>
      {over && <MoreButton text={say('pane.detail.moreText')} moreKey={`${paneId}:${moreKey}`} />}
    </>
  )
}

function DetailField({ paneId, field, lines, say }: { paneId: string; field: string; lines: string[]; say: Say }) {
  const list = lines.filter(Boolean)
  const { shown, more } = useClipped(paneId, field, list, DETAIL_CLIP[field], say)
  if (!list.length) return null
  return (
    <div className="work-field">
      <span className="work-field-key">{say(`pane.detail.record.${field}`)}</span>
      <span className="work-field-value">
        {shown.map((line, index) => <span key={index} className="work-field-line">{line}</span>)}
        {more}
      </span>
    </div>
  )
}

// 토큰 — 입력+출력을 크게, 캐시는 옆에 작게(main 이 숫자를 42k · 3.1M 로 줄여 보낸다). 기록을 못 찾으면 null → 그리지 않는다
function TokenLine({ tokens, say }: { tokens: PaneDetailTokens; say: Say }) {
  return (
    <span className="pd-tokens" title={say('pane.detail.tokensTitle', { io: tokens.io.toLocaleString(language()), cache: tokens.cache.toLocaleString(language()) })}>
      {say('pane.detail.tokens', { n: tokens.ioText })}
      {tokens.cache ? <span className="pd-tokens-cache">{`(${say('pane.detail.tokensCache', { n: tokens.cacheText })})`}</span> : null}
    </span>
  )
}

function PrLink({ url }: { url: string }) {
  return <button className="pd-link" type="button" onClick={() => void studio.openUrl(url)}>{url.replace(/^https:\/\/github\.com\//, '')}</button>
}

// 에이전트 pane — 맨 위 사람 몫(내가 할 일 · 막힘), 그다음 한눈 요약(상태 · 몇 분째 · 지금 한 줄 · 다음 · PR),
// 그 아래 결과 · PR · 리뷰 · 계획서를 펼쳐 둔다(접지 않는다 — 사용자 2026-10-27). 긴 글만 [더 보기]
function AgentSections({ paneId, detail, say }: { paneId: string; detail: PaneDetailAgent; say: Say }) {
  const { now, plan } = detail
  const report = useClipped(paneId, 'report', detail.report, DETAIL_CLIP.report, say)
  const question = now.reason === 'question'
  const created = plan.created ? new Date(plan.created).toLocaleString(language(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
  const nextFirst = plan.next[0]
  return (
    <>
      {/* 내가 할 일 — 있으면 맨 위 */}
      {detail.todo.length || question ? (
        <Section title={say('pane.detail.section.todo')}>
          {detail.todo.map((request) => <WorkRow key={request.id} className="ask" kindLabel={say(`work.kind.${request.kind}`)} title={request.title} onClick={() => actions.openRequest(request.id)} />)}
          {question ? <WorkRow className="ask" title={say(`pane.detail.todo.${now.reason}`)} onClick={() => actions.goToPane(paneId)} /> : null}
        </Section>
      ) : null}
      {/* 막힘 — 사람이 풀어야 해서 요약보다 위에 눈에 띄게 */}
      <BlockedAlert plan={plan} say={say} />
      {/* 한눈 요약 — 상태 · 까닭 · 걸린 시간 · 지금 하는 일 한 줄 · 다음 할 일 · PR */}
      <section className="pd-glance">
        <div className="pd-now">
          <span className="work-state" data-state={DETAIL_DOT[now.state] || 'idle'}>{say(`pane.detail.state.${now.state}`)}</span>
          {now.sinceMs && now.state !== 'gone' ? <span className="pd-muted">{say('pane.detail.since', { time: spanLabel(say, now.sinceMs) })}</span> : null}
          {created ? <span className="pd-muted">{say('pane.detail.started', { time: created })}</span> : null}
          {detail.tokens ? <TokenLine tokens={detail.tokens} say={say} /> : null}
        </div>
        {now.reason ? <p className="pd-reason">{say(`pane.detail.reason.${now.reason}`)}</p> : null}
        {now.line ? <ClampLine paneId={paneId} moreKey="now" say={say}>{now.line}</ClampLine> : null}
        {nextFirst !== undefined ? (
          <ClampLine paneId={paneId} moreKey="next-first" say={say}>
            <span className="pd-key">{say('pane.detail.record.next')}</span>
            {nextFirst}
          </ClampLine>
        ) : null}
        {plan.prs.length ? <div className="pd-glance-prs">{plan.prs.map((url) => <PrLink key={url} url={url} />)}</div> : null}
      </section>
      {/* 찾은 것 · 결과 — 에이전트의 마지막 보고(화면 글 그대로) · 몇 줄만 보이고 [더 보기] */}
      {detail.report.length ? (
        <Section title={say('pane.detail.section.report')}>
          <div className="pd-report">{report.shown.join('\n')}</div>
          {report.more}
        </Section>
      ) : null}
      <PlanRecordSections paneId={paneId} plan={plan} openable say={say} />
    </>
  )
}

// 막힘 — 있으면 눈에 띄게(에이전트 pane 은 요약 위 · 계획서 보기는 맨 위)
function BlockedAlert({ plan, say }: { plan: PaneDetailPlan; say: Say }) {
  if (!plan.blocked.length) return null
  return (
    <div className="pd-alert">
      <span className="pd-alert-key">{say('pane.detail.record.blocked')}</span>
      {plan.blocked.map((line, index) => <span key={index} className="pd-alert-line">{line}</span>)}
    </div>
  )
}

// PR · 자동 리뷰, 그리고 계획서 기록(요청 · 진행 · 다음 · 검증 — 막힘은 BlockedAlert) — 에이전트 pane 상세와 맡긴 일 줄의 계획서 보기가 같이 쓴다
// openable: 제목을 눌러 원본을 연다(plans/ 밖의 보관본은 열 원본이 없다)
function PlanRecordSections({ paneId, plan, openable, say }: { paneId: string; plan: PaneDetailPlan; openable: boolean; say: Say }) {
  const title = plan.title || plan.id
  return (
    <>
      {/* PR · 자동 리뷰 */}
      <Section title={say('pane.detail.section.pr')}>
        {plan.prs.map((url) => <PrLink key={url} url={url} />)}
        {plan.autoReview.map((line, index) => <p key={index} className="pd-line">{line}</p>)}
        {plan.reviewResult ? <p className="pd-line">{`${say('pane.detail.review')} · ${plan.reviewResult}`}</p> : null}
        {!plan.prs.length && !plan.autoReview.length && !plan.reviewResult ? <p className="pd-muted">{say('pane.detail.prNone')}</p> : null}
      </Section>
      {/* 계획서 기록 */}
      <Section title={say('pane.detail.section.record')}>
        {openable
          ? <button className="pd-link pd-plan" type="button" title={say('pane.detail.openPlan')} onClick={() => void studio.workOpenPlan(plan.id, plan.html)}>{title}</button>
          : <p className="pd-line pd-plan">{title}</p>}
        {!plan.readable ? <p className="pd-muted">{say('work.detail.unreadable')}</p> : null}
        <DetailField paneId={paneId} field="request" lines={plan.request} say={say} />
        <DetailField paneId={paneId} field="progress" lines={plan.progress.map((item) => `${item.done ? '✓' : '○'} ${item.text}`)} say={say} />
        <DetailField paneId={paneId} field="next" lines={plan.next} say={say} />
        <DetailField paneId={paneId} field="validation" lines={plan.validation} say={say} />
      </Section>
    </>
  )
}

// 맡긴 일 줄의 계획서 — 담당 pane 이 없는 줄(진행 중 · 끝남 · 보관)을 같은 칸에서 읽기 전용으로. 열려 있는 동안 3초마다 다시 읽는다
function PlanView({ plan, live, seq }: { plan: PlanRef; live: boolean; seq: number }) {
  const say = useSay()
  // null — 읽는 중
  const [view, setView] = useState<Awaited<ReturnType<typeof studio.planDetail>> | null>(null)
  useEffect(() => {
    if (!live) return undefined
    let alive = true
    const load = async () => {
      const next = await studio.planDetail(plan.id, plan.title)
      if (alive) setView(next || { ok: false })
    }
    const timer = setInterval(load, PANE_DETAIL_REFRESH_MS)
    void load()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [plan.id, plan.title, seq, live])
  if (!view) return <p className="work-empty">{say('work.loading')}</p>
  if (!view.ok) return <p className="work-empty">{say('pane.detail.error.default')}</p>
  const key = `plan:${plan.id}`
  return (
    <>
      <BlockedAlert plan={view.plan} say={say} />
      <PlanRecordSections paneId={key} plan={view.plan} openable={plan.id.startsWith('plans/')} say={say} />
    </>
  )
}

// 아테나 pane — 맡긴 일 목록. 줄을 누르면 그 에이전트 pane 상세로(pane 이 없으면 같은 칸에서 그 계획서) · 그 상세 머리에 [← 맡긴 일]
function LeadSections({ paneId, detail, container, say }: { paneId: string; detail: PaneDetailLead; container: HTMLElement; say: Say }) {
  const openRow = (row: PaneDetailLeadRow) => {
    const from = { paneId, scroll: container.scrollTop }
    const next = rowTarget(row, actions.paneLive)
    if (next && next.to === 'pane') return actions.openPane(next.paneId, from)
    if (next) return actions.openPlan({ id: next.id, title: row.title }, from)
    return undefined
  }
  return (
    <>
      {/* 이 아테나 대화 하나의 토큰(맡긴 일 토큰은 더하지 않는다) */}
      {detail.tokens ? <div className="pd-now pd-lead-tokens"><TokenLine tokens={detail.tokens} say={say} /></div> : null}
      {!detail.rows.length ? <p className="work-empty">{say('pane.detail.lead.empty')}</p> : null}
      {(['wait', 'now', 'done'] as const).map((group) => {
        const rows = detail.rows.filter((row) => row.state === group)
        if (!rows.length) return null
        return (
          <Section key={group} title={say(`pane.detail.lead.${group}`)}>
            {rows.map((row, index) => (
              <WorkRow
                key={row.id || index}
                className={group === 'wait' ? 'ask' : ''}
                title={row.title}
                meta={[row.who, row.what, row.sinceMs ? say('pane.detail.since', { time: spanLabel(say, row.sinceMs) }) : '', row.archived ? say('pane.detail.lead.archived') : ''].filter(Boolean).join(' · ')}
                state={ROW_STATE[group]}
                onClick={() => openRow(row)}
              />
            ))}
          </Section>
        )
      })}
    </>
  )
}
