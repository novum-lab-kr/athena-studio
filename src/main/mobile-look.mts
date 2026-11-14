// ── 폰에 보낼 팩 · 레포 이미지 — 파일 경로 대신 내용 해시 토큰만 snapshot 에 싣고, 그림은 폰이 look.icon 으로 따로 받는다 ──
// 계획서 plans/feature/20261114-폰에-팩-레포-이미지-이름-맥과-똑같이.md 5절. snapshot 은 조각 64개 · 16MiB 상한이라 그림을 매번 싣지 않는다.
// 토큰은 파일 내용이 바뀔 때만 바뀐다 — 폰은 토큰이 같으면 저장해 둔 그림을 쓴다.
// 읽는 규칙은 맥 화면과 같다(files.mts iconDataUrl — 일반 파일 · 1MiB 이하 · png · jpeg · webp 만). 경로는 폰에 넘기지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as packModel from '../lib/pack.mts'

// 아테나 작업 공간 줄 이미지 — 맥 사이드바(ui/spaces.tsx spaceImage)가 그 줄에 늘 그리는 우리 로고 화이트판.
// 사이드바는 칸 크기에 맞춰 32 · 180 을 고르는데 폰은 한 장만 받으니 큰 쪽(180 · 약 10KB). 같은 파일을 배포판도 들고 간다
// (scripts/package-mac.js FILES 'src/renderer/assets/logo/**' · asar 안 씀) — tray.mts TRAY_ICON_DIR 과 같은 자리 풀기
export const ATHENA_LOGO = path.join(import.meta.dirname, '..', 'renderer', 'assets', 'logo', 'athena-white-180.png')

export type IconFile = { token: string; mime: string; data: string }
export type IconTokens = ReturnType<typeof createIconTokens>

// 같은 파일(경로 · 크기 · 고친 시각)이면 다시 읽지 않는다
type Seen = { size: number; mtimeMs: number; token: string | null }

// 토큰 — sha256 앞 32자(128비트). 내용만 본다(경로 · 이름이 바뀌어도 같은 그림이면 같은 토큰)
export const iconToken = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 32)

async function readIcon(iconPath: string): Promise<{ bytes: Buffer; mime: string; size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.promises.stat(iconPath)
    if (!stat.isFile() || stat.size > packModel.ICON_MAX_BYTES) return null
    const bytes = await fs.promises.readFile(iconPath)
    // 읽는 사이 커졌을 수 있다 — 읽은 크기로 한 번 더
    if (bytes.length > packModel.ICON_MAX_BYTES) return null
    const mime = packModel.iconMime(bytes.subarray(0, 12))
    return mime ? { bytes, mime, size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

export function createIconTokens() {
  const seen = new Map<string, Seen>() // 경로 → 마지막으로 본 파일
  const paths = new Map<string, string>() // 토큰 → 경로(내준 토큰만 look.icon 이 읽는다)

  // 경로의 토큰 — 없는 파일 · 규칙 밖이면 null
  async function tokenOf(iconPath: string | null | undefined): Promise<string | null> {
    if (!iconPath) return null
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(iconPath)
    } catch {
      seen.delete(iconPath)
      return null
    }
    const before = seen.get(iconPath)
    if (before && before.size === stat.size && before.mtimeMs === stat.mtimeMs) return before.token
    const icon = await readIcon(iconPath)
    const token = icon ? iconToken(icon.bytes) : null
    seen.set(iconPath, { size: stat.size, mtimeMs: stat.mtimeMs, token })
    if (token) paths.set(token, iconPath)
    return token
  }

  // 토큰의 그림 — 내준 적 없는 토큰 · 그사이 지워졌거나 내용이 바뀐 파일(토큰이 안 맞음)은 null
  async function read(token: string): Promise<IconFile | null> {
    const iconPath = paths.get(token)
    if (!iconPath) return null
    const icon = await readIcon(iconPath)
    if (!icon || iconToken(icon.bytes) !== token) return null
    return { token, mime: icon.mime, data: icon.bytes.toString('base64') }
  }

  return { tokenOf, read }
}
