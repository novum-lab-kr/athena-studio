// 화면(renderer) 빌드 — src/renderer 의 index.html · tray.html 을 dist/renderer/ 로 묶는다(git 무시). main 은 dist/renderer/… 를 연다
// 켤 때마다 빌드한다(scripts/dev-app.js start · 0.3초 안팎) — 손으로는 npm run build:renderer
// - base './' — file:// 로 연다(Electron loadFile)
// - outDir 은 dist/renderer 로 고정 — renderer.js 의 ICON_ROOT('../../node_modules/…')가 레포 뿌리에서 두 칸 아래를 전제한다
// - publicDir 없음 · renderer.js 가 실행 중에 만드는 로고 경로(assets/logo/athena-white-<크기>.png)는 번들러가 못 보므로 로고 폴더를 그대로 복사한다
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const root = path.join(import.meta.dirname, 'src', 'renderer')
const logoDir = path.join(root, 'assets', 'logo')

// 빌드가 끝나면 로고 폴더를 결과 폴더의 같은 자리로 복사한다(실행 중에 만드는 경로가 그대로 맞게)
function copyLogo(): Plugin {
  let outDir = ''
  return {
    name: 'athena-copy-logo',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      fs.cpSync(logoDir, path.join(outDir, 'assets', 'logo'), { recursive: true })
    },
  }
}

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [copyLogo()],
  build: {
    outDir: path.join(import.meta.dirname, 'dist', 'renderer'),
    emptyOutDir: true,
    // Electron 44(Chromium 140) 한 곳에서만 돈다
    target: 'chrome140',
    // 옛 브라우저용 modulepreload 대체 코드는 넣지 않는다
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: path.join(root, 'index.html'),
        tray: path.join(root, 'tray.html'),
      },
    },
  },
})
