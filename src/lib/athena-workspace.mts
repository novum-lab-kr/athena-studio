// 아테나 작업 공간 판정 — ES 모듈(space-names.mts 와 같은 방식). main(core.findAthenaWorkspace)과 화면(tabs.ts isAthenaWorkspace)이
// 같은 규칙을 쓰도록 한 곳에 둔다. node 모듈을 쓰지 않는다(화면도 import) — 같은 폴더인지는 부르는 쪽이 판정 함수로 넘긴다.
export const ATHENA_WORKSPACE = 'athena'

// 판정에 읽는 칸만
export type AthenaCandidate = { label?: unknown; cwd?: unknown }

// 폴더 이름(맨 끝 칸) — 끝 '/' 는 떼고 본다
export function folderName(dir: string | null | undefined): string {
  return String(dir || '').replace(/\/+$/, '').split('/').pop() || ''
}

// 이 아테나 폴더의 작업 공간 하나 — 이름이 athena 이고 그 폴더인 것이 먼저.
// 없으면 이름이 그 폴더 이름이고 그 폴더인 것: #120 전 버그로 데몬 tab new 가 아테나 폴더 이름(path.basename)으로 만든
// 작업 공간이다(그 안에 원래 아테나 pane 들이 있다) — 그것을 아테나 작업 공간으로 알아본다(새로 만들지 않게).
// dirs 는 같은 폴더를 가리키는 표기들(적어 둔 경로 · 심볼릭 링크를 푼 경로) — 폴더 이름은 그중 어느 것과 같아도 된다
export function pickAthenaWorkspace<W extends AthenaCandidate>(
  workspaces: readonly W[] | null | undefined,
  dirs: readonly (string | null | undefined)[],
  inFolder: (cwd: string) => boolean,
): W | null {
  const here = (workspaces || []).filter((workspace) => typeof workspace.cwd === 'string' && inFolder(workspace.cwd))
  const names = new Set(dirs.map(folderName).filter(Boolean))
  return here.find((workspace) => workspace.label === ATHENA_WORKSPACE) || here.find((workspace) => names.has(String(workspace.label))) || null
}
