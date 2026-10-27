// 옛 <script> 가 만들던 전역 — renderer.js 가 이 이름들을 그대로 읽는다(xterm UMD 4개 · 공유 lib 4개)
// 공유 lib(src/lib/*.js)는 UMD 라 번들에서는 CommonJS 기본 내보내기로 잡힌다 — 전역에 다시 넣는다
import { Terminal } from '@xterm/xterm'
import * as FitAddon from '@xterm/addon-fit'
import * as WebLinksAddon from '@xterm/addon-web-links'
import * as Unicode11Addon from '@xterm/addon-unicode11'
import StudioLayout from '../lib/layout.js'
import StudioSpaceNames from '../lib/space-names.js'
import StudioPaneKeys from '../lib/pane-keys.js'
import StudioI18n from '../lib/i18n.js'

Object.assign(globalThis, { Terminal, FitAddon, WebLinksAddon, Unicode11Addon, StudioLayout, StudioSpaceNames, StudioPaneKeys, StudioI18n })
