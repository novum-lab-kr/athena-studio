// 작업 창(index.html) 진입점 — Vite 가 이 파일부터 묶는다(vite.config.mts)
// 화면 코드는 모두 .ts — 옛 renderer.js 는 기능별 파일로 다 옮겨 지웠다(R3 · 계획서 "R3 나누기"). 전역으로 넣는 것은 없다 — 각 파일이 필요한 것을 import 한다
// 시작은 main.ts — 나눈 묶음(core · terminal · screen · browser · work · detail …)을 모두 import 해서 그것들이 다 돈 뒤 맨 끝 init() 이 돈다(R3f)
// import 는 적힌 차례대로 돈다 — ui/index.ts → main.ts. 다른 묶음을 따로 먼저 싣지 않는다(main.ts 보다 먼저 시작된 묶음이 있으면 main.ts 의 init() 이 그 본문보다 먼저 돈다)
import '@xterm/xterm/css/xterm.css'
import './style.css'
// React 화면(ui/) — 바닐라 .ts 가 import 한다. 읽는 차례를 그대로 두려고 main.ts 보다 먼저
import './ui/index.ts'
import './main.ts'
