// 옛 <script> 가 만들던 전역 — renderer.js 가 아직 읽는 이름만(공유 lib 2개). renderer.js 를 .ts 로 나누면서 옮긴 묶음은 직접 import 한다
// (xterm 4개 · StudioPaneKeys · StudioI18n 은 terminal.ts · core.ts 가 import — R3a). 공유 lib(src/lib/*.mts)는 ES 모듈 — 이름공간째 전역에 넣는다(renderer.js 가 StudioLayout.paneIds 처럼 읽는다)
import * as StudioLayout from '../lib/layout.mts'
import * as StudioSpaceNames from '../lib/space-names.mts'

Object.assign(globalThis, { StudioLayout, StudioSpaceNames })
