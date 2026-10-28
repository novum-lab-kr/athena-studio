// [작업] 팝업 몸통(work-pop-body) — 나를 기다리는 것(사람에게 묻는 요청) · 진행 중 · 최근 끝난 것
// PR-R6. 팝업 껍데기(열기 · 닫기 · 머리줄 팩 이름 · Esc · 바깥 누르기 · 첫 버튼 포커스)와 데이터 읽기(workGet · onWorkRequests)는 바닐라 work.ts.
// 바닐라가 목록을 읽거나 요청이 바뀌면 setWork 로 넣고, 여기서는 그리기만 한다. 줄을 누르면 바닐라의 요청 답하기 · 작업 상세를 부른다
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { ReactNode } from 'react'
import type { Say } from './bridge.ts'

// main 의 requestsState · workState(src/main/work.mts) — 모양은 studio-api.d.ts(WorkRequestView · WorkItemView). 줄을 누르면 바닐라(work.ts · detail.ts)가 같은 값을 받아 더 많은 칸을 읽는다
type WorkRequest = WorkRequestView
type WorkState = 'wait' | 'work' | 'blocked' | 'idle' | 'done'
type WorkItem = WorkItemView
type WorkData = { boardUp: boolean; doing: WorkItem[]; done: WorkItem[] }

// 줄을 누르면 — 바닐라가 넘긴다(요청 답하기 대화상자 detail.ts · 작업 상세 대화상자 work.ts)
export type WorkActions = { openRequest: (request: WorkRequest) => void; openWorkDetail: (item: WorkItem) => void }

// data: 마지막으로 읽은 목록(workGet — 아직 없으면 null · 읽는 중) · requests: 요청 목록(목록을 읽었으면 그 요청, 아니면 onWorkRequests 의 것)
const workStore = createStore<{ data: WorkData | null; requests: WorkRequest[] }>({ data: null, requests: [] })

export function setWork(data: WorkData | null, requests: WorkRequest[]): void {
  workStore.set({ data, requests })
}

let unmount: (() => void) | null = null

// 팝업이 열릴 때 — 열 때마다 새로 띄운다(내용은 바닐라가 마지막으로 넣은 값부터)
export function open(container: HTMLElement, actions: WorkActions): void {
  close()
  unmount = mountIsland(container, <WorkBody actions={actions} />)
}

export function close(): void {
  if (!unmount) return
  unmount()
  unmount = null
}

function WorkBody({ actions }: { actions: WorkActions }) {
  const say = useSay()
  const { data, requests } = useStore(workStore)
  const waiting = requests.filter((request) => request.state === 'open').length
  return (
    <>
      {requests.length > 0 && (
        <Section title={say('work.section.waiting')} count={waiting}>
          {requests.map((request) => (
            <WorkRow
              key={request.id}
              className="ask"
              kindLabel={say(`work.kind.${request.kind}`)}
              title={request.title}
              meta={requestMeta(say, request)}
              onClick={() => actions.openRequest(request)}
            />
          ))}
        </Section>
      )}
      {data ? <WorkLists data={data} say={say} actions={actions} /> : <p className="work-empty">{say('work.loading')}</p>}
    </>
  )
}

function requestMeta(say: Say, request: WorkRequest): string {
  return [request.state === 'answered' ? say('work.notDelivered') : '', request.waited ? say('work.waited', { time: request.waited }) : ''].filter(Boolean).join(' · ')
}

// 일감이 꺼져 있으면 알림 한 줄 · 진행 중(비었으면 일감이 떠 있을 때만 "없어요") · 최근 끝난 것(있을 때만)
function WorkLists({ data, say, actions }: { data: WorkData; say: Say; actions: WorkActions }) {
  return (
    <>
      {!data.boardUp && <p className="work-empty">{say('work.boardDown')}</p>}
      <Section title={say('work.section.doing')} count={0} empty={data.boardUp ? say('work.empty') : ''}>
        {data.doing.map((item, index) => (
          <WorkRow key={item.id ?? index} title={item.title} meta={item.line} state={item.state} onClick={() => actions.openWorkDetail(item)} />
        ))}
      </Section>
      {data.done.length > 0 && (
        <Section title={say('work.section.done')} count={0}>
          {data.done.map((item, index) => (
            <WorkRow key={item.id ?? index} title={item.title} meta={item.line} state="done" onClick={() => actions.openWorkDetail(item)} />
          ))}
        </Section>
      )}
    </>
  )
}

// 묶음 — 제목 옆 숫자는 0 이면 숨긴다 · 줄이 없으면 빈 글(빈 글도 없으면 제목만)
function Section({ title, count, empty = '', children }: { title: string; count: number; empty?: string; children: ReactNode[] }) {
  return (
    <section className="work-sec">
      <h3>
        {title}
        {count > 0 && <span className="work-sec-count">{String(count)}</span>}
      </h3>
      {children.length > 0 && children}
      {children.length === 0 && empty !== '' && <p className="work-empty">{empty}</p>}
    </section>
  )
}

// 작업 한 줄 — [작업] 팝업과 pane [상세](ui/pane-detail.tsx — 내가 할 일 · 맡긴 일)가 같이 쓴다
export function WorkRow({ className = '', title, meta = '', state, kindLabel = '', onClick }: { className?: string; title: string; meta?: string; state?: WorkState; kindLabel?: string; onClick: () => void }) {
  const say = useSay()
  return (
    <button className={`work-row ${className}`.trim()} type="button" onClick={onClick}>
      <span className="work-row-main">
        <span className="work-row-title">
          {kindLabel !== '' && <span className="work-kind">{kindLabel}</span>}
          {title}
        </span>
        {meta !== '' && <span className="work-row-meta">{meta}</span>}
      </span>
      {state && (
        <span className="work-state" data-state={state}>
          {say(`work.state.${state}`)}
        </span>
      )}
    </button>
  )
}
