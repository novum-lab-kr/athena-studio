// 떼어 낸 옆 브라우저 창(browser-window.html) 진입점 — 스타일과 browser-window.ts 를 싣는다
// 정적 import 만 쓴다: main 이 창을 다 읽자마자(did-finish-load) 상태(browser:state · browser:tabs)를 한 번 보낸다
import './style.css'
import './browser-window.ts'
