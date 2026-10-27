// 작업 창(index.html) 진입점 — Vite 가 이 파일부터 묶는다(vite.config.mts)
// renderer.js 는 옛 <script> 때처럼 전역 이름(StudioLayout · StudioSpaceNames · StudioUi)을 읽는다. 그래서 여기서 ES 모듈로 가져와 전역에 그대로 넣은 뒤 renderer.js 를 싣는다.
// renderer.js 가 import 하는 .ts(core · terminal · screen …)는 renderer.js 본문보다 먼저 돈다 — 맨 끝 init() 은 renderer.js 에 남는다
// import 는 적힌 차례대로 돈다 — 전역 넣기(globals) → renderer.js. renderer.js 를 쪼개 .ts 로 옮기면 이 전역 넣기도 줄여 간다
import '@xterm/xterm/css/xterm.css'
import './style.css'
import './globals.ts'
// React 화면(ui/) — renderer.js 가 StudioUi 전역으로 부른다. 그래서 renderer.js 보다 먼저
import './ui/index.ts'
import './renderer.js'
