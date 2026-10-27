// 작업 창(index.html) 진입점 — Vite 가 이 파일부터 묶는다(vite.config.mts)
// renderer.js 는 옛 <script> 때처럼 전역 이름 StudioUi 를 읽는다(ui/index.ts 가 넣는다). 공유 lib(StudioLayout · StudioSpaceNames)는 나눈 .ts 가 직접 import 한다(R3c 에서 전역 넣기 globals.ts 를 지움)
// renderer.js 가 import 하는 .ts(core · terminal · screen …)는 renderer.js 본문보다 먼저 돈다 — 맨 끝 init() 은 renderer.js 에 남는다
// import 는 적힌 차례대로 돈다 — ui/index.ts → renderer.js
import '@xterm/xterm/css/xterm.css'
import './style.css'
// React 화면(ui/) — renderer.js 가 StudioUi 전역으로 부른다. 그래서 renderer.js 보다 먼저
import './ui/index.ts'
import './renderer.js'
