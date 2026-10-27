// 옛 <script src="../lib/i18n.js"> 가 만들던 전역 StudioI18n — tray.js 가 그대로 읽는다(src/lib/i18n.mts 이름공간째)
import * as StudioI18n from '../lib/i18n.mts'

Object.assign(globalThis, { StudioI18n })
