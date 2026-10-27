// React 화면들을 한 이름(StudioUi)으로 묶어 바닐라 .ts(core · main · browser · work · detail …)에 넘긴다 — 바닐라 쪽은 이 파일을 import 한다
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
import * as browser from './browser-bar.tsx'
import * as notices from './notices.tsx'
import * as spaces from './spaces.tsx'

const StudioUi = { connect, textsChanged, explorer, monitor, settings, work, paneDetail, welcome, browser, notices, spaces, packRail, packMenu, packProgress }

export { StudioUi }
