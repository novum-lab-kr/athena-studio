"""탭 번들 생성기 견본 — 심층 다이어그램 폴더(docs/diagrams/<앱>/)에 복사해 TABS 만 바꿔 쓴다(docs/diagrams/AUTHORING.md 4절).
앱 이름은 이 파일이 있는 폴더 이름 · 기준 커밋은 첫 탭 JSON 의 meta.repository.revision 에서 읽는다(문구로 박지 않는다).
출력: <폴더>/<앱>-architecture.html — 탭마다 deliver 로 만든 html 을 iframe 하나씩 담는다.
"""
import html, json, os, sys

D = os.path.dirname(os.path.abspath(__file__))
APP = os.path.basename(D)
# (탭 이름, deliver 로 만든 html 파일, 한 줄 설명) — 첫 탭은 상세(<앱>-detail.architecture.html), 그다음 도메인 탭
TABS = [
    (f"{APP} 상세", f"{APP}-detail.architecture.html", "진입 → 셸 → 가드 → 화면군 → 관문 → 외부"),
    # ("<도메인> 화면", "<도메인>.architecture.html", "<그 탭에 담긴 화면 한 줄>"),
]

missing = [file for _, file, _ in TABS if not os.path.exists(os.path.join(D, file))]
if missing:
    sys.exit(f"탭 html 이 없다(먼저 deliver 로 만든다): {', '.join(missing)}")

# 기준 커밋 — 첫 탭 JSON 의 meta.repository.revision(모든 탭이 같은 커밋이어야 한다)
try:
    with open(os.path.join(D, TABS[0][1].replace(".html", ".json")), encoding="utf-8") as f:
        REVISION = (json.load(f).get("meta", {}).get("repository", {}).get("revision") or "")[:8]
except (OSError, ValueError):
    REVISION = ""

buttons, panels = [], []
for i, (name, fn, desc) in enumerate(TABS):
    with open(os.path.join(D, fn), encoding="utf-8") as f:
        srcdoc = html.escape(f.read(), quote=True)
    active = " is-active" if i == 0 else ""
    buttons.append(
        f'<button class="tab{active}" data-idx="{i}" type="button">'
        f'<span class="tab-name">{html.escape(name)}</span>'
        f'<span class="tab-desc">{html.escape(desc)}</span></button>'
    )
    panels.append(
        f'<div class="panel{active}" data-idx="{i}">'
        f'<iframe title="{html.escape(name)}" loading="lazy" srcdoc="{srcdoc}"></iframe></div>'
    )

page = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__APP__ 아키텍처 다이어그램</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f6f7f9; --panel: #ffffff; --line: #e2e5ea;
    --text: #12161c; --muted: #66707e; --accent: #0f766e; --accent-soft: #e6f4f1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #0d1014; --panel: #151a21; --line: #262d37;
      --text: #e8ecf1; --muted: #98a3b3; --accent: #2dd4bf; --accent-soft: #10302c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0d1014; --panel: #151a21; --line: #262d37;
    --text: #e8ecf1; --muted: #98a3b3; --accent: #2dd4bf; --accent-soft: #10302c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard",
                 "Noto Sans KR", "Segoe UI", sans-serif;
    display: flex; flex-direction: column;
  }
  header { padding: 14px 20px 0; flex: 0 0 auto; }
  h1 { margin: 0 0 2px; font-size: 16px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
  nav { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 10px; }
  .tab {
    flex: 0 0 auto; text-align: left; cursor: pointer;
    background: var(--panel); color: var(--muted);
    border: 1px solid var(--line); border-radius: 9px;
    padding: 7px 12px; font: inherit; line-height: 1.35;
    transition: border-color .12s, color .12s, background .12s;
  }
  .tab:hover { border-color: var(--accent); }
  .tab.is-active { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
  .tab-name { display: block; font-size: 12.5px; font-weight: 600; }
  .tab-desc { display: block; font-size: 10.5px; color: var(--muted); margin-top: 1px; }
  main { flex: 1 1 auto; min-height: 0; padding: 0 20px 16px; }
  .panel { display: none; height: 100%; }
  .panel.is-active { display: block; }
  iframe {
    width: 100%; height: 100%; border: 1px solid var(--line);
    border-radius: 12px; background: var(--panel); display: block;
  }
</style>
</head>
<body>
<header>
  <h1>__APP__ 아키텍처 다이어그램</h1>
  <p class="sub">Archify 로 생성 · 저장소 리비전 __REVISION__ 기준 · 각 탭은 독립 실행되는 다이어그램입니다</p>
  <nav>__BUTTONS__</nav>
</header>
<main>__PANELS__</main>
<script>
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      const idx = tab.dataset.idx;
      tabs.forEach(function (t) { t.classList.toggle('is-active', t === tab); });
      panels.forEach(function (p) { p.classList.toggle('is-active', p.dataset.idx === idx); });
      try { localStorage.setItem('__APP__-diagram-tab', idx); } catch (e) {}
    });
  });
  try {
    const saved = localStorage.getItem('__APP__-diagram-tab');
    if (saved !== null) {
      const target = document.querySelector('.tab[data-idx="' + saved + '"]');
      if (target) target.click();
    }
  } catch (e) {}
</script>
</body>
</html>
"""
out = os.path.join(D, f"{APP}-architecture.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(page.replace("__APP__", html.escape(APP)).replace("__REVISION__", REVISION or "(모름)").replace("__BUTTONS__", "\n".join(buttons)).replace("__PANELS__", "\n".join(panels)))
print(out, round(os.path.getsize(out) / 1024 / 1024, 2), "MB")
