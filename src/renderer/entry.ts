// 작업 창(index.html) 진입점 — Vite 가 이 파일부터 묶는다(vite.config.mts)
// renderer.js 는 옛 <script> 때처럼 전역 이름 StudioUi 를 읽는다(ui/index.ts 가 넣는다). 공유 lib(StudioLayout · StudioSpaceNames)는 나눈 .ts 가 직접 import 한다(R3c 에서 전역 넣기 globals.ts 를 지움)
// 시작은 main.ts — 나눈 묶음(core · terminal · screen … · renderer.js)을 모두 import 해서 그것들이 다 돈 뒤 맨 끝 init() 이 돈다(R3f)
// import 는 적힌 차례대로 돈다 — ui/index.ts → main.ts. renderer.js 를 따로 먼저 싣지 않는다(renderer.js 가 main.ts 보다 먼저 시작되면 main.ts 의 init() 이 renderer.js 본문보다 먼저 돈다)
import '@xterm/xterm/css/xterm.css'
import './style.css'
// React 화면(ui/) — renderer.js 가 StudioUi 전역으로 부른다. 그래서 main.ts 보다 먼저
import './ui/index.ts'
import './main.ts'
