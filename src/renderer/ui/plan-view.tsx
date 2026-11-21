// [작업] 줄을 누르면 뜨는 계획서 화면 몸통(pack-dialog-body) — 폰 계획서 화면(athena-app (work)/plan.tsx)과 같은 느낌(D7):
// 머리(상태 칩 · 경로 · 아이콘 버튼) → 진행 상자("지금" 줄 · 큰 n/m · 칸 막대 · 접힌 단계 체크 목록 D8) → 상자 없는 요약 줄(왜 · 막힌 것 · 정한 것 · 검증 · 다음 · 결과 · 커밋) → 여백 본문 절(가는 선으로만 나눔 · 처음부터 펼침 D4).
// 대화상자 껍데기(제목 · ✕ · Esc · 포커스 돌려주기)는 바닐라 packDialog(pack-dialogs.ts) — 여기 버튼은 data-value 로 그 대화상자를 끝낸다(work.ts openWorkDetail 이 값을 받아 연다).
// md 는 lib/plan-doc.mts 가 조각으로 나눈 것만 그린다(HTML 을 만들어 넣지 않는다 · 링크는 http(s) 만 studio.openUrl 로)
import { mountIsland, useSay } from "./bridge.ts";
import {
  decisionBrief,
  inlineParts,
  planCommits,
  planSections,
  stepBrief,
  stepTitle,
} from "../../lib/plan-doc.mts";
import { useState } from "react";
import type { ReactNode } from "react";
import type { ListItem, PlanBlock } from "../../lib/plan-doc.mts";

type WorkState = WorkItemView["state"];
type Detail = Extract<WorkDetailReply, { ok: true }>;
// showConsole: 결정 콘솔(html)이 있는 계획서 · showPane: 살아 있는 담당 pane 이 있다
export type PlanViewProps = {
  id: string;
  state: WorkState;
  detail: WorkDetailReply | null;
  showConsole: boolean;
  showPane: boolean;
};

// 요약 칸으로 따로 그리는 절 — 본문 절 목록에서는 뺀다(경량 계획서는 Commits 가 ## 절이다)
const SUMMARY_SECTIONS = ["Checkpoint", "Commits"];

// 목록 들여쓰기는 셋까지만(폰 PlanDoc 과 같음)
const DEPTH_MAX = 3;

let unmount: (() => void) | null = null;

export function open(container: HTMLElement, props: PlanViewProps): void {
  close();
  unmount = mountIsland(container, <PlanView {...props} />);
}

export function close(): void {
  if (!unmount) return;
  unmount();
  unmount = null;
}

function PlanView({ id, state, detail, showConsole, showPane }: PlanViewProps) {
  const say = useSay();
  const read = detail && detail.ok ? detail : null;
  return (
    <div className="plan-view">
      <div className="plan-head">
        <span className="plan-chip" data-state={state}>
          {say(`work.state.${state}`)}
        </span>
        <span className="plan-path">{id}</span>
        <span className="plan-tools">
          <ToolButton value="plan" tip={say("work.detail.openPlan")}>
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M9 13h6" />
            <path d="M9 17h6" />
          </ToolButton>
          {showConsole && (
            <ToolButton value="console" tip={say("work.detail.console")}>
              <path d="M4 7h10" />
              <path d="M18 7h2" />
              <circle cx="16" cy="7" r="2" />
              <path d="M4 17h2" />
              <path d="M10 17h10" />
              <circle cx="8" cy="17" r="2" />
            </ToolButton>
          )}
          {showPane && (
            <ToolButton value="pane" tip={say("work.detail.goPane")} accent>
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 10l3 2-3 2" />
              <path d="M12 14h4" />
            </ToolButton>
          )}
        </span>
      </div>
      {read ? (
        <PlanBody detail={read} />
      ) : (
        <p className="muted">{say("work.detail.unreadable")}</p>
      )}
    </div>
  );
}

// 아이콘 버튼 — 글자 없이 아이콘 + 툴팁(tips.ts data-tip) · 누르면 대화상자가 data-value 로 끝난다
function ToolButton({
  value,
  tip,
  accent = false,
  children,
}: {
  value: string;
  tip: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={accent ? "plan-tool accent" : "plan-tool"}
      type="button"
      data-value={value}
      data-tip={tip}
      aria-label={tip}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function PlanBody({ detail }: { detail: Detail }) {
  const say = useSay();
  const commits = planCommits(detail.text);
  const sections = planSections(detail.text, SUMMARY_SECTIONS);
  const nowIndex = detail.steps.findIndex((step) => !step.done);
  // 단계 줄은 하나만 펼친다 — 다른 줄을 누르면 전에 연 줄은 닫힌다(-1 = 모두 접힘)
  const [openStep, setOpenStep] = useState(-1);
  const stepClass = (done: boolean, index: number): string => {
    if (done) return "done";
    return index === nowIndex ? "now" : "";
  };
  return (
    <>
      {detail.progress.total > 0 && (
        <section
          className="plan-progress"
          aria-label={say("work.detail.progress")}
        >
          <NowLines detail={detail} />
          <div className="plan-count">
            <b>{detail.progress.checked}</b>
            <span>{`/ ${detail.progress.total}`}</span>
          </div>
          {/* 칸 하나 = 단계 하나 · 끝 초록 · 지금 금색 · 남음 흐림(단계 점과 같은 색) */}
          <span className="plan-cells" aria-hidden="true">
            {Array.from({ length: detail.progress.total }, (_, index) => (
              <i
                key={index}
                className={cellClass(index, detail.progress.checked)}
              />
            ))}
          </span>
          <ol className="plan-steps">
            {detail.steps.map((step, index) => (
              <li key={index} className={stepClass(step.done, index)}>
                <span className="plan-step-mark" aria-hidden="true" />
                <StepText
                  text={step.text}
                  open={openStep === index}
                  onToggle={() => setOpenStep(openStep === index ? -1 : index)}
                />
              </li>
            ))}
            {/* 맥이 센 줄을 md 에서 못 찾으면(옛 형식) 지금 할 일 한 줄만 */}
            {detail.steps.length === 0 && detail.progress.now && (
              <li>{detail.progress.now}</li>
            )}
          </ol>
        </section>
      )}
      <section className="plan-fields">
        <Field name={say("work.detail.why")} lines={[detail.why]} />
        <Field
          name={say("work.detail.blocked")}
          lines={[detail.blocked]}
          tone="blocked"
        />
        <Decisions name={say("work.detail.decided")} lines={detail.decided} />
        <Field
          name={say("work.detail.validation")}
          lines={[detail.validation]}
        />
        <Field name={say("work.detail.next")} lines={[detail.next]} />
        <Field name={say("work.detail.results")} lines={detail.results} />
        <Field name={say("work.detail.commits")} lines={commits} />
      </section>
      {/* 제목 없는 절(첫 ## 앞 글)은 누를 머리가 없어 펼친 채 둔다 */}
      {sections
        .filter((section) => section.title === "")
        .map((section, index) => (
          <div key={index} className="plan-md">
            <Blocks blocks={section.blocks} />
          </div>
        ))}
      <div className="plan-secs">
        {sections.map(
          (section, index) =>
            section.title !== "" && (
              // 본문 절은 처음부터 펼쳐 둔다(D4 · 2026-11-21 사용자 화면 확인) — 머리를 누르면 접을 수는 있다
              <details key={index} className="plan-sec" open>
                <summary>
                  <span>{section.title}</span>
                  <svg
                    className="plan-chevron"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
                    <path d="M3.5 2l3 3-3 3" />
                  </svg>
                </summary>
                <div className="plan-md">
                  <Blocks blocks={section.blocks} />
                </div>
              </details>
            ),
        )}
      </div>
    </>
  );
}

// 진행 상자 맨 위 "지금" 줄(D8) — 지금 단계 짧은 제목 + 다음 첫 항목 한 줄 · 막힌 것이 있으면 그 첫 줄을 "막힘" 으로.
// 맥이 이미 센 now · next · blocked 만 쓴다(새 칸 없음) · 값이 없으면 그 줄을 숨긴다
function NowLines({ detail }: { detail: Detail }) {
  const say = useSay();
  const title = stepTitle(detail.progress.now);
  return (
    <>
      {(title || detail.next) && (
        <div className="plan-now">
          <span className="plan-now-key">{say("work.detail.now")}</span>
          {title && <b>{title}</b>}
          {detail.next && (
            <span className="plan-now-next">
              <Inline text={detail.next} />
            </span>
          )}
        </div>
      )}
      {detail.blocked && (
        <div className="plan-now blocked">
          <span className="plan-now-key">{say("work.state.blocked")}</span>
          <span className="plan-now-next">
            <Inline text={detail.blocked.split("\n")[0] ?? ""} />
          </span>
        </div>
      )}
    </>
  );
}

// 접힌 글 하나 — 짧은 말만 보이다가 누르면 전체 글(짧은 말이 전체와 같으면 누를 것이 없다).
// 펼침 상태는 목록이 가진다(같은 목록에서 하나만 펼치기)
function Fold({
  brief,
  full,
  open,
  onToggle,
}: {
  brief: ReactNode;
  full: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="plan-fold"
      type="button"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? <Inline text={full} /> : brief}
    </button>
  );
}

// 칸 막대 한 칸 — 끝낸 칸 · 그다음 칸(지금) · 나머지
function cellClass(index: number, checked: number): string {
  if (index < checked) return "done";
  return index === checked ? "now" : "";
}

// 단계 한 줄(D8) — " — " 앞(단계 번호 · 담당)과 그 뒤 첫 구간만 · 누르면 전체
function StepText({
  text,
  open,
  onToggle,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { title, gist } = stepBrief(text);
  const short = gist ? `${title} — ${gist}` : title;
  if (short === text) return <span>{text}</span>;
  return (
    <Fold
      full={text}
      open={open}
      onToggle={onToggle}
      brief={
        <>
          <span className="plan-step-title">{title}</span>
          {gist && ` — ${gist}`}
        </>
      }
    />
  );
}

// 요약 "결정"(D8 · D9) — 한 줄에 상자 하나 · 결정 제목만(번호는 쓰지 않는다 · lib/plan-doc.mts decisionBrief).
// 상자를 누르면 제목 아래에 번호만 뗀 전체 글을 보인다 · 한 번에 하나만 펼친다
function Decisions({ name, lines }: { name: string; lines: string[] }) {
  const [open, setOpen] = useState(-1);
  const filled = lines.filter(Boolean);
  if (!filled.length) return null;
  return (
    <div className="work-field">
      <span className="work-field-key">{name}</span>
      <div className="work-field-value plan-decs">
        {filled.map((line, index) => {
          const brief = decisionBrief(line);
          const expanded = open === index;
          return (
            <button
              key={index}
              type="button"
              className="plan-dec"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? -1 : index)}
            >
              <span className="plan-dec-title">
                <span>
                  <Inline text={brief.title} />
                </span>
                <svg
                  className="plan-chevron"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path d="M3.5 2l3 3-3 3" />
                </svg>
              </span>
              {expanded && (
                <span className="plan-dec-full">
                  <Inline text={brief.full} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 요약 한 칸 — 값이 없으면 그리지 않는다
function Field({
  name,
  lines,
  tone = "",
}: {
  name: string;
  lines: string[];
  tone?: string;
}) {
  const filled = lines.filter(Boolean);
  if (!filled.length) return null;
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
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) => {
        if (part.kind === "code") return <code key={index}>{part.text}</code>;
        if (part.kind === "bold") return <b key={index}>{part.text}</b>;
        if (part.kind === "link") {
          const href = part.href;
          return (
            <button
              key={index}
              className="plan-link"
              type="button"
              onClick={() => void studio.openUrl(href)}
            >
              {part.text.replace(/^https:\/\/github\.com\//, "")}
            </button>
          );
        }
        return part.text;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: PlanBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  );
}

function Block({ block }: { block: PlanBlock }) {
  if (block.kind === "heading") return <h4>{block.text}</h4>;
  if (block.kind === "code") return <pre>{block.text}</pre>;
  if (block.kind === "para" || block.kind === "quote") {
    return (
      <p className={block.kind === "quote" ? "plan-quote" : undefined}>
        <Inline text={block.text} />
      </p>
    );
  }
  if (block.kind === "list") {
    return (
      <ul className="plan-list">
        {block.items.map((item, index) => (
          <li
            key={index}
            className={itemClass(item)}
            style={{ marginLeft: `${Math.min(item.depth, DEPTH_MAX) * 16}px` }}
          >
            {item.ordered && item.check === null ? (
              <span className="plan-item-number">{`${orderOf(block.items, index)}.`}</span>
            ) : (
              <span className="plan-item-mark" aria-hidden="true" />
            )}
            <span>
              <Inline text={item.text} />
            </span>
          </li>
        ))}
      </ul>
    );
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
  );
}

// 번호 목록의 번호 — 같은 깊이에서 몇 번째인지(더 얕은 줄이 오면 다시 1부터 · 폰 PlanDoc 과 같은 규칙)
function orderOf(items: ListItem[], index: number): number {
  const depth = items[index]?.depth ?? 0;
  let count = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const item = items[cursor];
    if (!item || item.depth < depth) break;
    if (item.depth === depth) count += 1;
  }
  return count;
}

// 목록 줄 — 체크 칸(끝남 · 남음) · 그냥 점
function itemClass(item: ListItem): string {
  if (item.check === null) return "dot";
  return item.check ? "checked" : "unchecked";
}
