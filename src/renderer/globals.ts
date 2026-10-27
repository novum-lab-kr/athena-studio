// 옛 <script> 가 만들던 전역 — renderer.js 가 이 이름들을 그대로 읽는다(xterm UMD 4개 · 공유 lib 4개)
// 공유 lib(src/lib/*.mts)는 ES 모듈 — 이름공간째 전역에 넣는다(renderer.js 가 StudioLayout.paneIds 처럼 읽는다)
import { Terminal } from '@xterm/xterm'
import * as FitAddon from '@xterm/addon-fit'
import * as WebLinksAddon from '@xterm/addon-web-links'
import * as Unicode11Addon from '@xterm/addon-unicode11'
import * as StudioLayout from '../lib/layout.mts'
import * as StudioSpaceNames from '../lib/space-names.mts'
import * as StudioPaneKeys from '../lib/pane-keys.mts'
import * as StudioI18n from '../lib/i18n.mts'

Object.assign(globalThis, { Terminal, FitAddon, WebLinksAddon, Unicode11Addon, StudioLayout, StudioSpaceNames, StudioPaneKeys, StudioI18n })
