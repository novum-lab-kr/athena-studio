// 메뉴 막대 패널(tray.html) 진입점 — tray.js 가 읽는 전역 StudioI18n 을 넣은 뒤 tray.js 를 싣는다
// 정적 import 만 쓴다: main 이 창을 다 읽자마자(did-finish-load) tray:update 를 한 번 보내는데, 동적 import() 로 늦게 실으면 그 전에 받을 준비가 안 돼 패널이 빈다
import './tray.css'
import './tray-globals.ts'
import './tray.js'
