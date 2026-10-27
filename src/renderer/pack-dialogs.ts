// 회사 팩 대화상자 — 팩 상태(packs) · 대화상자 하나(packDialog · packAlert) · 진행 표시 보이기 · 숨기기 · 팩 지우기 · 이름 · 이미지(lookDialog — 레포도 같이)
// renderer.js 에서 옮김(R3e · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. packs 를 바꾸는 바깥 쪽은 setPacks(읽는 쪽은 이름 그대로)
import { $, el, say } from './core.ts'
import { POPUP_ICONS, refreshPackList } from './pack-switch.ts'
import { browserOpen, lineIcon, placeBrowserView, spaceColor, spaceInitials } from './renderer.js'
import { StudioUi } from './ui/index.ts'
import type { PackItem } from './ui/pack-rail.tsx'

// 대화상자 버튼 하나 — value null 은 취소(Esc 와 같다)
export type PackDialogAction = { label: string; value: string | null; kind?: 'primary' | 'danger' | 'link' }
export type PackDialogOptions = {
  title: string
  subtitle?: string
  body?: (string | Node)[]
  actions?: PackDialogAction[]
  input?: { value?: string; placeholder?: string; maxLength?: number; label?: string; code?: boolean; error?: string } | null
  close?: boolean
}
// input 이 있으면 { value, text }(입력 칸 글자) · 없으면 고른 value · 취소는 null
export type PackTextAnswer = { value: string; text: string }
export type PackDialogAnswer = string | PackTextAnswer | null
type LookDialogOptions = { title: string; color: string; image: string | null; value: string; placeholder: string; pickKind: 'pack' | 'repo' }
type LookAnswer = { text: string; iconChange: 'picked' | 'clear' | null }

// ── 회사 팩 ────────────────────────────────────────────────
// 본체가 여러 팩을 지원할 때만 보인다(packs.supported). 일은 main → 아테나 본체 명령이 하고, 화면은 묻고 · 기다리고 · 결과를 보여 준다
export let packs: PackState = { supported: false }
export const setPacks = (next: PackState): void => {
  packs = next
}

// 대화상자 · 진행 표시가 떠 있는 동안 — 뒤 화면은 inert(포커스 · 클릭 막기), 옆 브라우저는 네이티브 뷰라 위를 덮어서 잠깐 뗀다
export const modalOpen = (): boolean => !$('pack-dialog').hidden || !$('pack-progress').hidden
function syncModal(): void {
  const open = modalOpen()
  for (const node of document.querySelectorAll<HTMLElement>('body > header, body > main')) node.inert = open
  if (!browserOpen) return
  if (open) studio.browserHide()
  else placeBrowserView()
}

// 대화상자 하나 — actions: [{ label, value, kind: 'primary'|'danger'|'link' }] · Esc 는 null.
// 버튼은 맥처럼 취소(value null) → 다른 것 → 확인 · 위험(맨 오른쪽) 순서로 놓는다. 위험이 있으면 처음 포커스는 취소에
// input: { value, placeholder, maxLength, label, code } — Enter 는 확인(primary) 버튼(한글 조합 중이면 무시)
// 이미 열린 것이 있으면 null 로 닫고 연다(앞 흐름이 영영 기다리지 않게)
let closeOpenDialog: ((value: string | null) => void) | null = null
export function packDialog({ title, subtitle = '', body = [], actions = [], input = null, close = false }: PackDialogOptions): Promise<PackDialogAnswer> {
  if (closeOpenDialog) closeOpenDialog(null)
  const dialog = $('pack-dialog')
  const before = document.activeElement
  $('pack-dialog-title').textContent = title
  const sub = $('pack-dialog-subtitle')
  sub.textContent = subtitle
  sub.hidden = !subtitle
  const bodyNode = $('pack-dialog-body')
  bodyNode.replaceChildren(...body.map((part) => (typeof part === 'string' ? el('p', null, part) : part)))
  let field: HTMLInputElement | null = null
  if (input) {
    field = el('input', `pack-input${input.code ? ' code' : ''}`)
    field.id = 'pack-dialog-input'
    field.placeholder = input.placeholder || ''
    field.value = input.value || ''
    if (input.maxLength) field.maxLength = input.maxLength
    field.spellcheck = false
    field.autocomplete = 'off'
    field.setAttribute('aria-label', input.label || title)
    let place: HTMLElement = field
    // input.error — 칸 아래 빨간 한 줄(고쳐 쓰면 사라진다)
    if (input.error) {
      place = el('div', 'pack-field')
      const error = el('p', 'pack-field-error', input.error)
      error.id = 'pack-dialog-input-error'
      error.setAttribute('role', 'alert')
      place.append(field, error)
      field.setAttribute('aria-invalid', 'true')
      field.setAttribute('aria-describedby', error.id)
      field.addEventListener('input', () => {
        error.remove()
        field!.removeAttribute('aria-invalid')
      }, { once: true })
    }
    // 본문에 [data-input-slot] 이 있으면 그 자리에(이름 · 이미지처럼 칸이 옆에 붙는 대화상자)
    ;(bodyNode.querySelector('[data-input-slot]') || bodyNode).append(place)
  }
  const rank = (action: PackDialogAction): number => (action.value === null ? 0 : action.kind === 'primary' || action.kind === 'danger' ? 2 : 1)
  const ordered = actions.map((action, index) => ({ action, index })).sort((a, b) => rank(a.action) - rank(b.action) || a.index - b.index).map((item) => item.action)
  return new Promise<PackDialogAnswer>((resolve) => {
    const finish = (value: string | null): void => {
      if (closeOpenDialog !== finish) return
      closeOpenDialog = null
      dialog.hidden = true
      dialog.onkeydown = null
      syncModal()
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
      resolve(field && value !== null ? { value, text: field.value } : value)
    }
    const buttons = ordered.map((action) => {
      const kind = action.kind === 'primary' ? 'primary' : action.kind === 'danger' ? 'pack-button danger' : action.kind === 'link' ? 'link' : 'pack-button'
      const button = el('button', kind, action.label)
      button.type = 'button'
      button.dataset.kind = action.kind || ''
      if (action.value === null) button.dataset.cancel = ''
      button.addEventListener('click', () => finish(action.value))
      return button
    })
    $('pack-dialog-actions').replaceChildren(...buttons)
    // close — 머리 오른쪽 ✕(Esc 와 같다) · 아래 [닫기] 버튼 대신
    const closeButton = $('pack-dialog-close')
    closeButton.hidden = !close
    closeButton.onclick = () => finish(null)
    // 목록 줄(팩 고르기) · 고르기 카드도 같은 끝내기로
    for (const node of bodyNode.querySelectorAll<HTMLElement>('[data-value]')) node.addEventListener('click', () => finish(node.dataset.value as string))
    closeOpenDialog = finish
    dialog.onkeydown = (event) => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      } else if (event.key === 'Enter' && field && document.activeElement === field) {
        event.preventDefault()
        const primary = buttons.find((button) => button.dataset.kind === 'primary') || buttons.find((button) => !('cancel' in button.dataset))
        if (primary) primary.click()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // 목록 · 고르기 카드 안에서는 위아래 화살표로
        const group = document.activeElement && document.activeElement.closest('.pack-list, .pack-links')
        if (!group) return
        const items = [...group.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        event.preventDefault()
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]!.focus()
      }
    }
    dialog.hidden = false
    syncModal()
    const cancel = buttons.find((button) => 'cancel' in button.dataset)
    const danger = buttons.some((button) => button.dataset.kind === 'danger')
    const focus = field || (danger && cancel) || bodyNode.querySelector<HTMLElement>('[data-value]') || buttons.find((button) => button.dataset.kind === 'primary') || cancel || buttons[0] || (close && $('pack-dialog-close'))
    if (focus) focus.focus({ preventScroll: true })
  })
}

export const packAlert = (title: string, text: unknown): Promise<PackDialogAnswer> => packDialog({ title, body: String(text || '').split('\n'), actions: [{ label: say('common.ok'), value: 'ok', kind: 'primary' }] })

// 진행 표시 — cancellable 이면 [취소](기다리는 중 · 검사 중에만 — 본체가 바꾸기 시작한 뒤에는 없다).
// 몸통(제목 · 단계 줄 · [취소])은 React(ui/pack-progress.tsx) — 여기는 보이기 · 숨기기 · 뒤 화면 막기 · 포커스만
let progressBefore: Element | null = null // 닫으면 포커스를 돌려줄 곳
export function showPackProgress(title: string, cancellable: boolean): void {
  const progress = $('pack-progress')
  if (progress.hidden) progressBefore = document.activeElement
  StudioUi.packProgress.show(title, cancellable)
  $('pack-progress').hidden = false
  syncModal()
  $('pack-progress').focus({ preventScroll: true })
}
export const hidePackProgress = (): void => {
  $('pack-progress').hidden = true
  syncModal()
  // 이어서 대화상자가 떴으면 그쪽 포커스 그대로
  if ($('pack-dialog').hidden && progressBefore instanceof HTMLElement && progressBefore.isConnected) progressBefore.focus({ preventScroll: true })
  progressBefore = null
}

const PACK_NAME_MAX = 40 // 표시 이름 1~40자(본체가 다시 검사한다)

// 화면에 보일 팩 이름 — 표시 이름(팩 안에 저장 · 팀과 같이) → 이름 → id
export const packLabel = (pack: PackItem | null | undefined): string => (pack && (pack.displayName || pack.name || pack.id)) || ''

// 팩 지우기 — 무엇이 지워지고 무엇이 남는지 · 자동 백업을 알리고 확인. 워크트리가 있으면 목록을 보여 주고 한 번 더 묻는다
export async function deletePack(id: string): Promise<unknown> {
  const pack = [...packs.packs!, packs.current].find((item) => item && item.id === id)
  const name = packLabel(pack) || id
  const ok = await packDialog({
    title: say('pack.delete.title', { name }),
    body: [el('p', null, say('pack.delete.body')), el('p', 'muted', say('pack.delete.note'))],
    actions: [{ label: say('pack.delete.yes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }],
  })
  if (!ok) return
  showPackProgress(say('pack.delete.progress', { name }), false)
  let result = await studio.packDelete(id)
  hidePackProgress()
  if (result.error === 'has-worktrees') {
    const lines = result.worktrees!.map((tree) => el('p', 'muted', tree.dirty ? say('pack.delete.treeDirty', { name: tree.name, count: tree.dirty }) : tree.name))
    const again = await packDialog({
      title: say('pack.delete.treesTitle', { count: result.worktrees!.length }),
      body: [el('p', null, say('pack.delete.treesBody')), ...lines],
      actions: [{ label: say('pack.delete.treesYes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }],
    })
    if (!again) return
    showPackProgress(say('pack.delete.progress', { name }), false)
    result = await studio.packDelete(id, { withWorktrees: true })
    hidePackProgress()
  }
  if (!result.ok) return packAlert(say('pack.delete.failed'), result.text || result.message)
  await refreshPackList()
  const reveal = await packDialog({
    title: say('pack.delete.done', { name }),
    body: [el('p', 'muted', say('pack.delete.doneNote')), el('p', 'muted', result.backup)],
    actions: [{ label: say('pack.reveal'), value: 'reveal', kind: 'primary' }, { label: say('common.ok'), value: null }],
  })
  if (reveal) studio.packReveal()
}

// 팩 아이콘 우클릭 — main 메뉴(이름 바꾸기 · 원래 이름으로 · 이미지 고르기 · 이미지 지우기)에서 고른 것을 한다
export async function editPackLook(id: string, action: string): Promise<unknown> {
  let result: PackReply | null = null
  if (action === 'rename') {
    const pack = [...packs.packs!, packs.current].find((item) => item && item.id === id)
    const answer = (await packDialog({
      title: say('pack.rename.title'),
      body: [say('pack.rename.body', { id })],
      input: { value: packLabel(pack), placeholder: (pack && pack.name) || id, maxLength: PACK_NAME_MAX },
      actions: [
        { label: say('common.ok'), value: 'ok', kind: 'primary' },
        { label: say('common.cancel'), value: null },
      ],
    })) as PackTextAnswer | null
    if (!answer || !answer.text.trim()) return
    result = await studio.packSetName(id, answer.text.trim())
  }
  if (action === 'reset-name') result = await studio.packSetName(id, null)
  if (action === 'icon' || action === 'clear-icon') result = await studio.packSetIcon(id, action === 'clear-icon')
  if (result && !result.ok && !result.canceled) return packAlert(say('pack.look.failed'), result.text || result.message)
}

// 팩 이름 · 이미지 한 번에(아이콘 더블클릭) — lookDialog. 이름을 비우면 원래 이름으로(--clear). 둘 다 팩 안에 저장돼 팀과 같이 쓴다
export async function editPackLookDialog(id: string): Promise<unknown> {
  const find = () => [...(packs.packs || []), packs.current].find((item) => item && item.id === id)
  const pack = find()
  if (!pack) return
  const image = pack.iconPath ? ((await studio.packIcon(id)) || {}).dataUrl || null : null
  const answer = await lookDialog({ title: say('pack.look.title'), color: id, image, value: packLabel(pack), placeholder: pack.name || id, pickKind: 'pack' })
  if (!answer) return
  const now = find() || pack
  const results: PackReply[] = []
  if (answer.text !== packLabel(now)) results.push(await studio.packSetName(id, answer.text ? answer.text : null))
  if (answer.iconChange) results.push(await studio.packSetIcon(id, answer.iconChange === 'clear', answer.iconChange === 'picked'))
  const failed = results.find((result) => result && !result.ok && !result.canceled)
  if (failed) return packAlert(say('pack.look.failed'), failed.text || failed.message)
}

// 이름 · 이미지 대화상자(팩 · 레포 같이) — 왼쪽 큰 아이콘(누르면 이미지 고르기 · 오른쪽 위 지우기) + 오른쪽 이름 칸.
// 이미지도 이름처럼 [저장] 때 바뀐다(고른 파일은 main 이 들고 있다). 돌려주는 것: null(취소) · { text(앞뒤 공백 뺀 이름), iconChange: null(그대로) · 'picked' · 'clear' }
export async function lookDialog({ title, color, image: startImage, value, placeholder, pickKind }: LookDialogOptions): Promise<LookAnswer | null> {
  let image = startImage
  let iconChange: LookAnswer['iconChange'] = null
  const avatar = el('button', 'space-icon pack-icon pack-look-avatar')
  avatar.type = 'button'
  avatar.style.setProperty('--space-color', spaceColor(color) as string)
  avatar.setAttribute('aria-label', say('pack.menu.icon'))
  avatar.dataset.tip = say('pack.menu.icon')
  // 지우기 — 아이콘 오른쪽 위 작은 휴지통(이미지가 있을 때만)
  const remove = el('button', 'pack-look-remove')
  remove.type = 'button'
  remove.append(lineIcon(POPUP_ICONS.trash))
  remove.setAttribute('aria-label', say('pack.menu.clearIcon'))
  remove.dataset.tip = say('pack.menu.clearIcon')
  const error = el('p', 'pack-look-error')
  error.setAttribute('role', 'alert')
  const nameField = () => document.getElementById('pack-dialog-input') as HTMLInputElement | null
  const paint = () => {
    if (image) {
      const node = el('img', 'pack-icon-image')
      node.src = image
      node.alt = ''
      avatar.replaceChildren(node)
    } else {
      const field = nameField()
      avatar.replaceChildren(document.createTextNode(spaceInitials((field && field.value.trim()) || placeholder)))
    }
    const edit = el('span', 'pack-look-edit')
    edit.append(lineIcon(POPUP_ICONS.camera))
    avatar.append(edit)
    remove.hidden = !image
  }
  avatar.addEventListener('click', async () => {
    error.textContent = ''
    const result = await studio.packPickIcon(pickKind)
    if (!result || result.canceled) return
    if (!result.ok) {
      error.textContent = result.text || say('pack.look.failed')
      return
    }
    image = result.dataUrl as string
    iconChange = 'picked'
    paint()
  })
  remove.addEventListener('click', () => {
    image = null
    iconChange = 'clear'
    paint()
    avatar.focus()
  })
  const side = el('div', 'pack-look-side')
  side.append(avatar, remove)
  const name = el('div', 'pack-look-name')
  const label = el('label', 'pack-look-label', say('pack.look.name'))
  label.htmlFor = 'pack-dialog-input'
  const slot = el('div')
  slot.dataset.inputSlot = ''
  name.append(label, slot, error)
  const look = el('div', 'pack-look')
  look.append(side, name)
  look.addEventListener('input', () => !image && paint()) // 이미지가 없으면 머리글자가 이름을 따라간다
  const pending = packDialog({
    title,
    body: [look],
    input: { value, placeholder, maxLength: PACK_NAME_MAX, label: say('pack.look.name') },
    actions: [
      { label: say('pack.look.save'), value: 'save', kind: 'primary' },
      { label: say('common.cancel'), value: null },
    ],
  }) as Promise<PackTextAnswer | null>
  paint()
  nameField()!.select()
  const answer = await pending
  if (!answer || answer.value !== 'save') return null
  return { text: answer.text.trim(), iconChange }
}

