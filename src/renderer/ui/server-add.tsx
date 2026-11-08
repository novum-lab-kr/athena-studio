// 서버 추가 팝업(#server-add) 몸통 — 기존 Host 고르기 · 새로 입력(별칭 · 사용자 · 호스트 · 포트 · 키 파일) · [접속 확인] · config 블록 미리보기 · [추가]
// 껍데기(보이기 · 숨기기 · 뒤 화면 막기 · Esc · 포커스 돌려주기)는 바닐라 pack-dialogs.ts showServerAdd.
// 비밀번호 칸은 없다 — 키 파일 경로만 받고 내용은 읽지 않는다. [추가] 는 지금 칸 값으로 [접속 확인] 이 통과했을 때만(칸을 고치면 다시)
// 처음 보는 호스트 키면 지문(SHA256)을 보이고 [이 서버 믿기] → main 이 받아 둔 그 키만 known_hosts 에(화면은 지문만 보낸다) → 다시 [접속 확인]
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, showToast, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

type HostRow = { host: string; registered: boolean }
type SshKey = { path: string; kind: string }
// 팝업이 끝나며 돌려주는 것 — 기존 Host 를 골랐으면 그 별칭(더하기는 바닐라가) · 새로 더했으면 결과 · 닫았으면 null
export type ServerAddDone = { kind: 'host'; host: string } | { kind: 'created'; reply: ServerAddReply } | null
type Shown = { hosts: HostRow[]; keys: SshKey[]; close: (done: ServerAddDone) => void; at: number } | null
const shown = createStore<Shown>(null)

export function mount(box: HTMLElement): void {
  mountIsland(box, <ServerAddBody />)
}

// 그리기는 바로(flushSync) — 바닐라가 곧이어 상자를 보이고 첫 칸에 포커스를 준다
export function show(hosts: HostRow[], keys: SshKey[], close: (done: ServerAddDone) => void): void {
  flushSync(() => shown.set({ hosts, keys, close, at: Date.now() }))
}

export function clear(): void {
  shown.set(null)
}

const FIELDS = ['alias', 'user', 'host', 'port', 'key'] as const
type Field = (typeof FIELDS)[number]
type Tested = { input: string; reply: ServerTestReply } | null

// 칸 아래 한 줄 — 별칭 · 사용자는 같은 글자 규칙
function problemText(say: Say, field: Field, problem: string): string {
  if (problem === 'bad') return say(field === 'host' ? 'serverAdd.problem.badHost' : field === 'key' ? 'serverAdd.problem.badKey' : 'serverAdd.problem.badName')
  return say(`serverAdd.problem.${problem}`)
}

function ServerIcon() {
  return (
    <span className="popup-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M4 4h16v6H4z" />
        <path d="M4 14h16v6H4z" />
        <path d="M8 7h.01" />
        <path d="M8 17h.01" />
      </svg>
    </span>
  )
}

function ServerAddBody() {
  const say = useSay()
  const current = useStore(shown)
  if (!current) return null
  // 열 때마다 칸을 처음으로(key 가 바뀌면 React 가 새로 만든다)
  return <ServerAddForm key={current.at} hosts={current.hosts} keys={current.keys} close={current.close} say={say} />
}

function ServerAddForm({ hosts, keys, close, say }: { hosts: HostRow[]; keys: SshKey[]; close: (done: ServerAddDone) => void; say: Say }) {
  const [values, setValues] = useState<HostInput>({ alias: '', user: '', host: '', port: '22', key: keys[0]?.path ?? '' })
  const [extraKeys, setExtraKeys] = useState<SshKey[]>([])
  const [problems, setProblems] = useState<HostProblems>({})
  const [tested, setTested] = useState<Tested>(null)
  const [busy, setBusy] = useState<'test' | 'save' | 'trust' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const keyBox = useRef<HTMLDivElement>(null)
  const menuBox = useRef<HTMLDivElement>(null)
  const inputText = JSON.stringify(values)
  const passed = tested && tested.input === inputText && tested.reply.ok ? tested.reply : null

  // 키 목록 바깥을 누르면 닫는다
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: PointerEvent) => {
      if (keyBox.current && !keyBox.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menuOpen])

  // 키 목록은 팝업 몸통 끝에 걸쳐 열린다 — 열면 보이는 자리까지 몸통을 굴린다
  useEffect(() => {
    if (menuOpen) menuBox.current?.scrollIntoView({ block: 'nearest' })
  }, [menuOpen])

  // 칸을 고치면 확인 결과 · 그 칸 문제는 지운다(다시 [접속 확인])
  const change = (field: Field, value: string) => {
    setValues((before) => ({ ...before, [field]: value }))
    setProblems((before) => ({ ...before, [field]: undefined }))
    setTested(null)
  }

  const runTest = async () => {
    if (busy) return
    setBusy('test')
    setTested(null)
    try {
      const reply = await studio.serverTest(values)
      setProblems(!reply.ok && reply.problems ? reply.problems : {})
      setTested(!reply.ok && reply.problems ? null : { input: inputText, reply })
    } catch {
      setTested({ input: inputText, reply: { ok: false, reason: 'failed' } })
    } finally {
      setBusy(null)
    }
  }

  const runCreate = async () => {
    if (busy || !passed) return
    setBusy('save')
    try {
      const reply = await studio.serverCreate(values)
      if (reply.ok) return close({ kind: 'created', reply })
      if ('problems' in reply && reply.problems) {
        setProblems(reply.problems)
        setTested(null)
      } else if (reply.error === 'untested') {
        setTested(null)
        showToast(say('serverAdd.untested'))
      } else {
        // 블록은 config 에 들어갔을 수 있다 — 기존 Host 목록에서 다시 고를 수 있다는 안내
        showToast(say('serverAdd.addFailed', { text: reply.text || reply.message || reply.error || '' }))
      }
    } finally {
      setBusy(null)
    }
  }

  // [이 서버 믿기] — 보고 있던 지문 그대로 보낸다. 저장되면 바로 다시 [접속 확인]
  const runTrust = async (fingerprints: string[]) => {
    if (busy) return
    setBusy('trust')
    let saved = false
    try {
      const reply = await studio.serverTrustHostKey(values, fingerprints)
      if (reply.ok) {
        saved = true
        showToast(say('serverAdd.trustSaved'), 'success')
      } else if (reply.problems) {
        setProblems(reply.problems)
        setTested(null)
      } else if (reply.error === 'changed') {
        setTested({ input: inputText, reply: { ok: false, reason: 'host-key-changed' } })
        showToast(say('serverAdd.trustChanged'))
      } else if (reply.error === 'untested' || reply.error === 'mismatch') {
        setTested(null)
        showToast(say('serverAdd.untested'))
      } else {
        showToast(say('serverAdd.trustFailed'))
      }
    } catch {
      showToast(say('serverAdd.trustFailed'))
    } finally {
      setBusy(null)
    }
    if (saved) await runTest()
  }

  const pickKey = (file: string) => {
    setMenuOpen(false)
    change('key', file)
  }
  const browseKey = async () => {
    setMenuOpen(false)
    const file = await studio.serverKeyBrowse()
    if (!file) return
    if (!keys.some((key) => key.path === file) && !extraKeys.some((key) => key.path === file)) setExtraKeys((before) => [...before, { path: file, kind: '' }])
    change('key', file)
  }

  const field = (name: Field, options: { code?: boolean; placeholder?: string; hint?: string; inputMode?: 'numeric' } = {}) => {
    const problem = problems[name]
    return (
      <div className={`sv-field sv-${name}`}>
        <label htmlFor={`server-add-${name}`}>{say(`serverAdd.field.${name}`)}</label>
        <input
          id={`server-add-${name}`}
          className={`pack-input${options.code ? ' code' : ''}`}
          value={values[name]}
          placeholder={options.placeholder}
          inputMode={options.inputMode}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={name === 'port' ? 5 : 255}
          aria-invalid={problem ? 'true' : undefined}
          data-autofocus={name === 'alias' && !hosts.length ? '' : undefined}
          onChange={(event) => change(name, event.currentTarget.value)}
        />
        {problem ? <p className="pack-field-error">{problemText(say, name, problem)}</p> : options.hint ? <p className="sv-hint">{options.hint}</p> : null}
      </div>
    )
  }

  const allKeys = [...keys, ...extraKeys]
  const keyProblem = problems.key
  const failed = tested && !tested.reply.ok ? tested.reply : null
  return (
    <form
      className="server-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (passed) void runCreate()
        else void runTest()
      }}>
      <h2 id="server-add-title">{say('serverAdd.title')}</h2>
      <p className="pack-subtitle">{say('serverAdd.subtitle')}</p>
      <button className="pack-close" type="button" aria-label={say('common.close')} onClick={() => close(null)}>
        <svg viewBox="0 0 24 24">
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </svg>
      </button>
      <div className="pack-body">
        {hosts.length ? (
          <>
            <p className="sv-sec">{say('serverAdd.existing')}</p>
            <div className="pack-links">
              {hosts.map((row, index) => (
                <button
                  key={row.host}
                  type="button"
                  className="pack-command"
                  disabled={row.registered || Boolean(busy)}
                  data-autofocus={index === hosts.findIndex((item) => !item.registered) ? '' : undefined}
                  onClick={() => close({ kind: 'host', host: row.host })}>
                  <ServerIcon />
                  <span className="popup-option-copy">
                    <b>{row.host}</b>
                    <small>{say(row.registered ? 'spaces.addServerRegistered' : 'spaces.addServerPick')}</small>
                  </span>
                </button>
              ))}
            </div>
            <p className="sv-or">{say('serverAdd.orNew')}</p>
          </>
        ) : null}
        <div className="sv-grid">
          {field('alias', { placeholder: say('serverAdd.placeholder.alias') })}
          {field('user', { placeholder: say('serverAdd.placeholder.user') })}
          <div className="sv-row">
            {field('host', { code: true, placeholder: say('serverAdd.placeholder.host') })}
            {field('port', { code: true, inputMode: 'numeric' })}
          </div>
          <div className="sv-field sv-select" ref={keyBox}>
            <label htmlFor="server-add-key">{say('serverAdd.field.key')}</label>
            <div className="sv-key-anchor">
            <button
              id="server-add-key"
              type="button"
              className="pack-input sv-key-button"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-invalid={keyProblem ? 'true' : undefined}
              onClick={() => setMenuOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && menuOpen) {
                  event.stopPropagation()
                  setMenuOpen(false)
                }
              }}>
              <span className={values.key ? '' : 'sv-placeholder'}>{values.key || say('serverAdd.keyPick')}</span>
              <span className="sv-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {menuOpen ? (
              <div className="sv-menu" role="listbox" ref={menuBox}>
                {allKeys.length ? null : <p className="sv-menu-empty">{say('serverAdd.keyNone')}</p>}
                {allKeys.map((key) => (
                  <button key={key.path} type="button" role="option" aria-selected={key.path === values.key} className={key.path === values.key ? 'on' : ''} onClick={() => pickKey(key.path)}>
                    <span>{key.path}</span>
                    {key.kind ? <small>{key.kind}</small> : null}
                  </button>
                ))}
                <hr />
                <button type="button" className="sv-browse" onClick={() => void browseKey()}>
                  {say('serverAdd.keyBrowse')}
                </button>
              </div>
            ) : null}
            </div>
            {keyProblem ? <p className="pack-field-error">{problemText(say, 'key', keyProblem)}</p> : <p className="sv-hint">{say('serverAdd.keyHint')}</p>}
          </div>
        </div>
        {passed ? (
          <>
            <div className="sv-result ok">
              <span aria-hidden="true">✓</span>
              <span>{say('serverAdd.testOk', { target: `${values.user.trim()}@${values.alias.trim()}`, sec: (passed.ms / 1000).toFixed(1) })}</span>
            </div>
            <div className="sv-preview">
              <p className="sv-sec">{say('serverAdd.preview')}</p>
              <pre>
                {passed.block
                  .trimEnd()
                  .split('\n')
                  .map((line, index) => (index === 0 ? <i key={index}>{`${line}\n`}</i> : `${line}\n`))}
              </pre>
            </div>
          </>
        ) : null}
        {failed ? <TestFailure reply={failed} values={values} say={say} busy={Boolean(busy)} trusting={busy === 'trust'} trust={(fingerprints) => void runTrust(fingerprints)} /> : null}
      </div>
      <div className="pack-actions">
        <button type="button" className="pack-button" onClick={() => close(null)}>
          {say('common.cancel')}
        </button>
        <span className="sv-spacer" />
        {/* Enter 는 지금 기본 버튼 — 확인 전이면 [접속 확인] · 통과했으면 [추가] (form onSubmit) */}
        <button type={passed ? 'button' : 'submit'} className={passed ? 'pack-button' : 'primary'} disabled={Boolean(busy)} onClick={passed ? () => void runTest() : undefined}>
          {say(busy === 'test' ? 'serverAdd.testing' : 'serverAdd.test')}
        </button>
        <button type={passed ? 'submit' : 'button'} className={passed ? 'primary' : 'pack-button'} disabled={!passed || Boolean(busy)}>
          {say(busy === 'save' ? 'serverAdd.adding' : 'serverAdd.add')}
        </button>
      </div>
    </form>
  )
}

// 복사용 명령의 키 경로 — 셸 작은따옴표로 감싼다(~/ 는 펼쳐지게 밖에 둔다 · ' 는 칸 검사가 막는다 · 보안 검토 L2)
const quotedPath = (path: string) => (path.startsWith('~/') ? `~/'${path.slice(2)}'` : `'${path}'`)

// 접속 실패 — 이유 한 줄 + 고치는 법. 공개 키가 없으면 ssh-copy-id · 호스트 키를 모르면 터미널에서 한 번 접속(지문을 사람이 본다)
type FailureProps = { reply: Extract<ServerTestReply, { ok: false }>; values: HostInput; say: Say; busy: boolean; trusting: boolean; trust: (fingerprints: string[]) => void }
function TestFailure({ reply, values, say, busy, trusting, trust }: FailureProps) {
  const reason = reply.reason ?? 'failed'
  const keys = reason === 'host-key' ? reply.hostKey?.keys : undefined
  if (keys?.length) return <HostKeyTrust keys={keys} say={say} busy={busy} trusting={trusting} trust={trust} />
  const target = `${values.user.trim()}@${values.host.trim()}`
  const port = values.port.trim()
  let help = ''
  let command = ''
  if (reason === 'key-needed') {
    help = say('serverAdd.keyNeededHelp')
    command = `ssh-copy-id -i ${quotedPath(`${values.key.trim()}.pub`)} -p ${port} ${target}`
  } else if (reason === 'host-key') {
    // 앱이 키를 받지 못한 때(HostKeyAlias 설정 · 키 받기 실패)만 — 예전처럼 터미널에서 한 번 접속
    help = say('serverAdd.hostKeyHelp')
    command = `ssh -p ${port} ${target}`
  } else if (reason === 'host-key-changed') {
    help = say('serverAdd.hostKeyChangedHelp')
  } else if (reason === 'unreachable' || reason === 'timeout') {
    help = say('serverAdd.unreachableHelp')
  }
  const copy = () => {
    navigator.clipboard
      .writeText(command)
      .then(() => showToast(say('serverAdd.copied'), 'success'))
      .catch(() => showToast(say('serverAdd.copyFailed')))
  }
  return (
    <div className="sv-result bad" role="alert">
      <span>
        <span aria-hidden="true">✕ </span>
        {say(`server.reason.${reason}`)}
      </span>
      {help ? <p>{help}</p> : null}
      {command ? (
        <div className="sv-cmd">
          <code>{command}</code>
          <button type="button" onClick={copy}>
            {say('serverAdd.copy')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

// 처음 보는 호스트 키 — 종류 · SHA256 지문(ssh 가 터미널에 보이는 꼴) · [이 서버 믿기]
function HostKeyTrust({ keys, say, busy, trusting, trust }: { keys: HostKeyView['keys']; say: Say; busy: boolean; trusting: boolean; trust: (fingerprints: string[]) => void }) {
  return (
    <div className="sv-result warn" role="alert">
      <span>{say('serverAdd.hostKeyNew')}</span>
      <ul className="sv-fingerprints">
        {keys.map((key) => (
          <li key={key.sha256}>
            <small>{key.type}</small>
            <code>{key.sha256}</code>
          </li>
        ))}
      </ul>
      <div className="sv-trust">
        <button type="button" className="pack-button" disabled={busy} onClick={() => trust(keys.map((key) => key.sha256))}>
          {say(trusting ? 'serverAdd.trusting' : 'serverAdd.trust')}
        </button>
      </div>
    </div>
  )
}
