// React 화면들을 바닐라 renderer.js 에 넘기는 전역 — renderer.js 는 아직 ES import 를 쓰지 않는다(node --check 로 문법을 본다).
// 진입점(entry.ts)이 renderer.js 보다 먼저 싣는다. renderer.js 를 .ts 로 옮기면 이 전역 대신 바로 import 한다
import { connect, textsChanged } from './bridge.ts'
import * as explorer from './explorer.tsx'
import * as monitor from './monitor.tsx'
import * as packMenu from './pack-menu.tsx'
import * as packProgress from './pack-progress.tsx'
import * as packRail from './pack-rail.tsx'
import * as paneDetail from './pane-detail.tsx'
import * as settings from './settings-pop.tsx'
import * as work from './work-pop.tsx'
import * as welcome from './pack-welcome.tsx'

const StudioUi = { connect, textsChanged, explorer, monitor, settings, work, paneDetail, welcome, packRail, packMenu, packProgress }

declare global {
  // renderer.js 가 읽는 전역 이름
  var StudioUi: typeof import('./index.ts').StudioUi
}

Object.assign(globalThis, { StudioUi })

export { StudioUi }
