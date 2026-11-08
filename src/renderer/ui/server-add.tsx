// 서버 등록 팝업(#server-add) 몸통 — 기존 Host 고르기 · 새로 입력(주소 → 사용자 → 포트 → 키 → 별칭) · [등록] 하나 · 진행 단계(닫기 없음) · 끝나면 저절로 닫힘
// 기존 Host 를 고르면 그 값(ssh -G)을 칸에 채워 바로 고칠 수 있다(별칭은 그 Host 이름으로 고정 · 고른 줄을 다시 누르면 풀리고 칸을 비운다) — 고쳐서 [등록] 하면 접속 확인 뒤 main 이 그 Host 블록을 다시 쓴다
// Include · Match · 별칭 여럿이면 칸만 막는다(값은 보임 · 안내 줄 없음). [등록] 이 도는 동안은 입력 요약 + 단계만 · 실패하면 입력 화면으로(값 그대로)
// 껍데기(보이기 · 숨기기 · 잠깐 숨기기 · 뒤 화면 막기 · Esc · 포커스 돌려주기)는 바닐라 pack-dialogs.ts showServerAdd.
// [등록] = 검사 → 접속 확인(1번) → 등록(main ssh-setup.mts serverRegister) — 실패한 단계에서 멈추고 그 칸 · 그 단계 아래 이유
// 비밀번호 칸은 없다 — 키 파일 경로만 받고 내용은 읽지 않는다. 처음 보는 호스트 키는 지문(SHA256)을 사람이 보고 [믿고 계속] → 저절로 다시 [등록]
// 공개 키가 아직 없으면 [앱 터미널에서 키 올리기] — 팝업을 잠깐 숨기고 pane 에서 ssh-copy-id · 그 pane 이 끝나면 다시 보이고 저절로 [등록]
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, showToast, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

type HostRow = { host: string; registered: boolean }
type SshKey = { path: string; kind: string }
// 팝업이 끝나며 돌려주는 것 — 등록했으면 그 서버와 [등록] 옆 분석 체크 · 닫았으면 null
export type ServerAddDone = { server: string; analyze: boolean } | null
// suspend — 키 올리는 pane 을 쓰는 동안 껍데기만 숨기고(true) 다시 보인다(false). 몸통 상태는 그대로
type Shell = { close: (done: ServerAddDone) => void; suspend: (hidden: boolean) => void }
type Shown = { hosts: HostRow[]; keys: SshKey[]; shell: Shell; at: number } | null
const shown = createStore<Shown>(null)

export function mount(box: HTMLElement): void {
  mountIsland(box, <ServerAddBody />)
}

// 그리기는 바로(flushSync) — 바닐라가 곧이어 상자를 보이고 첫 칸에 포커스를 준다
export function show(hosts: HostRow[], keys: SshKey[], shell: Shell): void {
  flushSync(() => shown.set({ hosts, keys, shell, at: Date.now() }))
}

export function clear(): void {
  shown.set(null)
}

// 칸 순서 — 주소 → 사용자 → 포트 → 키 → 별칭(별칭은 주소로 제안)
const FIELDS = ['host', 'user', 'port', 'key', 'alias'] as const
type Field = (typeof FIELDS)[number]
const STEPS: RegisterStep[] = ['check', 'connect', 'save']
type Failure = Extract<ServerRegisterReply, { ok: false }>

// 칸 아래 한 줄 — 별칭 · 사용자는 같은 글자 규칙
function problemText(say: Say, field: Field, problem: string): string {
  if (problem !== 'bad') return say(`serverAdd.problem.${problem}`)
  if (field === 'host') return say('serverAdd.problem.badHost')
  if (field === 'key') return say('serverAdd.problem.badKey')
  return say('serverAdd.problem.badName')
}

// 주소로 별칭 제안 — 이름이면 첫 마디(web.example.com → web) · IP 면 점을 - 로. 별칭에 못 쓰는 글자는 - 로
export function suggestAlias(host: string): string {
  const text = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!text) return ''
  const isAddress = /^[\d.]+$/.test(text) || text.includes(':')
  const base = isAddress ? text : text.split('.')[0] || text
  return base.replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
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
  return <ServerAddForm key={current.at} hosts={current.hosts} keys={current.keys} shell={current.shell} say={say} />
}

function ServerAddForm({ hosts, keys, shell, say }: { hosts: HostRow[]; keys: SshKey[]; shell: Shell; say: Say }) {
  const blank = (): HostInput => ({ alias: '', user: '', host: '', port: '22', key: keys[0]?.path ?? '' })
  const [values, setValues] = useState<HostInput>(blank)
  const [aliasEdited, setAliasEdited] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  // 고른 Host 의 칸이 읽기 전용인 이유(null 이면 고칠 수 있음) · 값을 읽는 중
  const [lock, setLock] = useState<HostLock | null>(null)
  const [loading, setLoading] = useState(false)
  const [extraKeys, setExtraKeys] = useState<SshKey[]>([])
  const [problems, setProblems] = useState<HostProblems>({})
  const [coreText, setCoreText] = useState('')
  const [step, setStep] = useState<RegisterStep | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState<'register' | 'trust' | 'upload' | null>(null)
  const [keyPane, setKeyPane] = useState<string | null>(null)
  // 등록 뒤 분석 · 다이어그램 — 기본 꺼짐 · 끝나면 팝업을 닫으며 넘긴다
  const [analyze, setAnalyze] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const keyBox = useRef<HTMLDivElement>(null)
  const menuBox = useRef<HTMLDivElement>(null)
  let source: RegisterSource = { kind: 'new', input: values }
  if (picked) source = lock ? { kind: 'host', alias: picked } : { kind: 'host', alias: picked, input: { ...values, alias: picked } }
  const sourceRef = useRef(source)
  sourceRef.current = source

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

  // 칸을 고치면 결과 · 그 칸 문제는 지운다. 별칭을 손대기 전에는 주소로 제안
  const reset = () => {
    setFailure(null)
    setCoreText('')
    setStep(null)
  }
  const change = (field: Field, value: string) => {
    setValues((before) => {
      const next = { ...before, [field]: value }
      if (field === 'host' && !aliasEdited && !picked) next.alias = suggestAlias(value)
      return next
    })
    if (field === 'alias') setAliasEdited(true)
    setProblems((before) => ({ ...before, [field]: undefined, ...(field === 'host' && !aliasEdited ? { alias: undefined } : {}) }))
    reset()
  }
  // 고르기 — 그 Host 의 값을 칸에 채운다(읽는 동안 칸은 잠근다) · 고른 줄을 다시 눌러 풀면 칸을 비운다
  const pick = async (alias: string | null) => {
    setProblems({})
    reset()
    setLock(null)
    if (!alias) {
      setPicked(null)
      setValues(blank())
      setAliasEdited(false)
      return
    }
    setPicked(alias)
    setLoading(true)
    try {
      const reply = await studio.serverHostDetail(alias)
      if (!reply.ok) {
        setProblems({ alias: 'bad' })
        return
      }
      setValues({ ...reply.values, alias })
      setLock(reply.lock)
      const key = reply.values.key
      if (key && !keys.some((item) => item.path === key)) setExtraKeys((before) => (before.some((item) => item.path === key) ? before : [...before, { path: key, kind: '' }]))
    } catch {
      setProblems({ alias: 'bad' })
    } finally {
      setLoading(false)
    }
  }

  const register = async () => {
    if (busy) return
    setBusy('register')
    reset()
    setProblems({})
    setStep('check')
    const stop = studio.onServerRegisterStep((next) => setStep(next))
    try {
      const reply = await studio.serverRegister(sourceRef.current)
      // 끝나면 완료 화면 없이 저절로 닫는다 — 분석은 [등록] 옆 체크대로
      if (reply.ok) {
        shell.close({ server: reply.server.name, analyze })
        return
      }
      if (reply.problems) setProblems(reply.problems)
      if (reply.lock) setLock(reply.lock)
      if (reply.step === 'check' && reply.text) setCoreText(reply.text)
      setStep(reply.step)
      setFailure(reply)
    } catch {
      setFailure({ ok: false, step: 'connect', reason: 'failed' })
    } finally {
      stop()
      setBusy(null)
    }
  }

  // [믿고 계속] — 보고 있던 지문 그대로 보낸다. 저장되면 저절로 다시 [등록]
  const trust = async (fingerprints: string[]) => {
    if (busy) return
    setBusy('trust')
    let saved = false
    try {
      const reply = await studio.serverTrustHostKey(sourceRef.current, fingerprints)
      if (reply.ok) saved = true
      else if (reply.problems) {
        setProblems(reply.problems)
        setFailure(null)
      } else if (reply.error === 'changed') setFailure({ ok: false, step: 'connect', reason: 'host-key-changed' })
      else if (reply.error === 'untested' || reply.error === 'mismatch') {
        setFailure(null)
        showToast(say('serverAdd.untested'))
      } else showToast(say('serverAdd.trustFailed'))
    } catch {
      showToast(say('serverAdd.trustFailed'))
    } finally {
      setBusy(null)
    }
    if (saved) await register()
  }

  // [앱 터미널에서 키 올리기] — pane 에서 ssh-copy-id(비밀번호는 그 터미널에만). 팝업은 잠깐 숨긴다
  const uploadKey = async () => {
    if (busy) return
    setBusy('upload')
    try {
      const reply = await studio.serverKeyUpload(sourceRef.current)
      if (!reply.ok) {
        if (reply.problems) setProblems(reply.problems)
        showToast(say(reply.error === 'no-public-key' ? 'serverAdd.noPublicKey' : 'serverAdd.keyUploadFailed'))
        return
      }
      setKeyPane(reply.pane)
      shell.suspend(true)
    } catch {
      showToast(say('serverAdd.keyUploadFailed'))
    } finally {
      setBusy(null)
    }
  }

  // 키 올리는 pane 이 끝나면(성공하면 셸이 닫힌다) 팝업을 다시 보이고 저절로 다시 [등록]
  useEffect(() => {
    if (!keyPane) return
    return studio.onPaneExit((paneId) => {
      if (paneId !== keyPane) return
      setKeyPane(null)
      shell.suspend(false)
      void register()
    })
  }, [keyPane])

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

  const closeButton = (
    <button className="pack-close" type="button" aria-label={say('common.close')} onClick={() => shell.close(null)}>
      <svg viewBox="0 0 24 24">
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </svg>
    </button>
  )

  // 고른 Host — 별칭은 그 이름으로 고정 · 읽기 전용(lock)이거나 값을 읽는 중이면 모든 칸을 잠근다
  const fixed = (name: Field) => Boolean(picked) && (name === 'alias' || Boolean(lock) || loading)
  const field = (name: Field, options: { code?: boolean; placeholder?: string; hint?: string; inputMode?: 'numeric' } = {}) => {
    const problem = problems[name]
    const note = name === 'alias' && coreText ? coreText : ''
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
          disabled={Boolean(busy) || fixed(name)}
          aria-invalid={problem || note ? 'true' : undefined}
          data-autofocus={name === 'host' && !hosts.length ? '' : undefined}
          onChange={(event) => change(name, event.currentTarget.value)}
        />
        {problem ? <p className="pack-field-error">{problemText(say, name, problem)}</p> : null}
        {!problem && note ? <p className="pack-field-error">{note}</p> : null}
        {!problem && !note && options.hint && !picked ? <p className="sv-hint">{options.hint}</p> : null}
      </div>
    )
  }

  const allKeys = [...keys, ...extraKeys]
  const keyProblem = problems.key
  const pickedProblem = picked && (problems.alias || coreText) ? coreText || say('serverAdd.problem.badPick') : ''
  // [등록] 이 도는 동안 — 입력 요약(읽기 전용) + 단계만 · 닫기(X) 없음
  if (busy === 'register' && step) {
    return (
      <form className="server-add-form" onSubmit={(event) => event.preventDefault()}>
        <h2 id="server-add-title">{say('serverAdd.title')}</h2>
        <div className="pack-body">
          <dl className="sv-summary">
            {(['alias', 'host', 'user', 'port', 'key'] as const).map((name) => (
              <div key={name}>
                <dt>{say(`serverAdd.field.${name}`)}</dt>
                <dd className={name === 'alias' || name === 'user' ? '' : 'code'}>{(name === 'alias' && picked) || values[name].trim() || '—'}</dd>
              </div>
            ))}
            <div>
              <dt>{say('serverAdd.summary.analyze')}</dt>
              <dd>{say(analyze ? 'serverAdd.summary.analyzeOn' : 'serverAdd.summary.analyzeOff')}</dd>
            </div>
          </dl>
          <Steps step={step} failed={null} say={say} />
        </div>
        <div className="pack-actions">
          <span className="sv-spacer" />
          <button type="submit" className="primary" disabled>
            {say('serverAdd.registering')}
          </button>
        </div>
      </form>
    )
  }
  return (
    <form
      className="server-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        void register()
      }}>
      <h2 id="server-add-title">{say('serverAdd.title')}</h2>
      <p className="pack-subtitle">{say('serverAdd.subtitle')}</p>
      {closeButton}
      <div className="pack-body">
        {hosts.length ? (
          <>
            <p className="sv-sec">{say('serverAdd.existing')}</p>
            {/* 열 때 포커스는 목록 칸에 둔다 — 첫 줄에 두면 고른 것처럼 보인다. Tab 이면 첫 줄로 */}
            <div className="pack-links sv-hosts" tabIndex={-1} data-autofocus="">
              {hosts.map((row) => (
                <button
                  key={row.host}
                  type="button"
                  className={`pack-command${picked === row.host ? ' on' : ''}`}
                  aria-pressed={picked === row.host}
                  disabled={row.registered || Boolean(busy)}
                  onClick={() => void pick(picked === row.host ? null : row.host)}>
                  <ServerIcon />
                  <span className="popup-option-copy">
                    <b>{row.host}</b>
                    <small>{say(row.registered ? 'spaces.addServerRegistered' : picked === row.host ? 'serverAdd.picked' : 'serverAdd.pick')}</small>
                  </span>
                </button>
              ))}
            </div>
            {pickedProblem ? <p className="pack-field-error">{pickedProblem}</p> : null}
            <hr className="sv-or" />
          </>
        ) : null}
        <div className="sv-grid">
          {field('host', { code: true, placeholder: say('serverAdd.placeholder.host') })}
          <div className="sv-row">
            {field('user', { placeholder: say('serverAdd.placeholder.user') })}
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
                disabled={Boolean(busy) || fixed('key')}
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
          {field('alias', { placeholder: say('serverAdd.placeholder.alias'), hint: say('serverAdd.aliasHint') })}
        </div>
        {step ? <Steps step={step} failed={failure ? failure.step : null} say={say} /> : null}
        {failure && failure.step === 'connect' ? (
          <ConnectFailure reply={failure} picked={picked} values={values} say={say} busy={busy} trust={(fingerprints) => void trust(fingerprints)} upload={() => void uploadKey()} retry={() => void register()} />
        ) : null}
        {failure && failure.step === 'save' ? (
          <div className="sv-result bad" role="alert">
            <span>{failure.error === 'config-changed' ? say('serverAdd.configChanged') : say(failure.written ? 'serverAdd.saveFailedWritten' : 'serverAdd.saveFailed', { text: failure.text || failure.error || '' })}</span>
          </div>
        ) : null}
      </div>
      <div className="pack-actions">
        <button type="button" className="pack-button" onClick={() => shell.close(null)}>
          {say('common.cancel')}
        </button>
        <span className="sv-spacer" />
        <label className="sv-analyze">
          <input type="checkbox" checked={analyze} disabled={Boolean(busy)} onChange={(event) => setAnalyze(event.currentTarget.checked)} />
          {say('serverAdd.analyzeAfter')}
        </label>
        <button type="submit" className="primary" disabled={Boolean(busy) || loading}>
          {say(busy === 'register' ? 'serverAdd.registering' : 'serverAdd.register')}
        </button>
      </div>
    </form>
  )
}

// 진행 단계 — 검사 → 접속 확인 → 등록. 멈춘 단계는 ✕
function Steps({ step, failed, say }: { step: RegisterStep; failed: RegisterStep | null; say: Say }) {
  const at = STEPS.indexOf(step)
  return (
    <ol className="sv-steps" aria-live="polite">
      {STEPS.map((name, index) => {
        let state = 'wait'
        if (index < at) state = 'ok'
        else if (index === at) state = failed === name ? 'bad' : 'run'
        return (
          <li key={name} className={`sv-step ${state}`}>
            <span aria-hidden="true">{stepMark(state)}</span>
            {say(`serverAdd.step.${name}`)}
          </li>
        )
      })}
    </ol>
  )
}

function stepMark(state: string): string {
  if (state === 'ok') return '✓'
  if (state === 'bad') return '✕'
  if (state === 'run') return '…'
  return '·'
}

// 접속 실패 — 이유 한 줄 + 고치는 법. 처음 보는 호스트 키면 지문 · [믿고 계속] · 공개 키가 없으면 [앱 터미널에서 키 올리기]
type FailureProps = { reply: Failure; picked: string | null; values: HostInput; say: Say; busy: string | null; trust: (fingerprints: string[]) => void; upload: () => void; retry: () => void }
function ConnectFailure({ reply, picked, values, say, busy, trust, upload, retry }: FailureProps) {
  const reason = reply.reason ?? 'failed'
  const keys = reason === 'host-key' ? reply.hostKey?.keys : undefined
  if (keys?.length) return <HostKeyTrust keys={keys} say={say} busy={Boolean(busy)} trusting={busy === 'trust'} trust={trust} />
  if (reason === 'key-needed') {
    return (
      <div className="sv-result bad" role="alert">
        <span>
          <span aria-hidden="true">✕ </span>
          {say('server.reason.key-needed')}
        </span>
        <p>{say('serverAdd.keyNeededHelp')}</p>
        <div className="sv-trust">
          <button type="button" className="pack-button" disabled={Boolean(busy)} onClick={retry}>
            {say('serverAdd.recheck')}
          </button>
          <button type="button" className="primary" disabled={Boolean(busy)} onClick={upload}>
            {say('serverAdd.keyUpload')}
          </button>
        </div>
      </div>
    )
  }
  let help = ''
  if (reason === 'host-key') help = say('serverAdd.hostKeyHelp', { command: picked ? `ssh ${picked}` : `ssh -p ${values.port.trim()} ${values.user.trim()}@${values.host.trim()}` })
  else if (reason === 'host-key-changed') help = say('serverAdd.hostKeyChangedHelp')
  else if (reason === 'unreachable' || reason === 'timeout') help = say('serverAdd.unreachableHelp')
  return (
    <div className="sv-result bad" role="alert">
      <span>
        <span aria-hidden="true">✕ </span>
        {say(`server.reason.${reason}`)}
      </span>
      {help ? <p>{help}</p> : null}
    </div>
  )
}

// 처음 보는 호스트 키 — 종류 · SHA256 지문(ssh 가 터미널에 보이는 꼴) · [믿고 계속]
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
