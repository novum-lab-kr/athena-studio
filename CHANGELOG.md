# Changelog

All notable user-facing changes to Athena Studio. Internal refactors and tests are not listed.

<!-- 시작점: 홈페이지 창이 athena-studio GitHub 릴리스 v0.2.0 ~ v0.13.34(2026-10-26 ~ 28) 제목에서 손님에게 보이는 것만 골라 영어로 요약(2026-10-28). 홈페이지 /releases 와 같은 내용 -->

## 0.13 (v0.13.0 – v0.13.34 · Oct 27–28, 2026)

### New
- Athena follows up-to-date coding rules: per-layer language and type rules, modern syntax, scaffolds, and a type-check step in verification.

### Improved
- The app interface was rebuilt on TypeScript and React for a steadier screen.

### Fixed
- Large pull requests are reviewed code-first. If a diff had to be cut short, an approval asks you to confirm.
- Plans with steps left are no longer completed or archived automatically.
- ⌘← and ⌘→ move to the start and end of the line, fixing repeated characters with Korean input.
- The agent monitor shows in every workspace.

## 0.12 (v0.12.0 – v0.12.3 · Oct 27, 2026)

### New
- Pane details show token usage.

### Improved
- The agent monitor shows only agents that are working, labeled by repository.

### Fixed
- Blocked items in pane details are shown in red.

## 0.11 (v0.11.0 – v0.11.5 · Oct 26–27, 2026)

### New
- The status board became the work board: an issue list as the first screen, finished work archived automatically, and a pane details pop-up.

### Improved
- Pane details are easier to read and have a back button.
- Pane title bars are always visible, focused or not.

## 0.10 (v0.10.0 – v0.10.7 · Oct 26, 2026)

### New
- Repositories in the sidebar get two-letter badges.

### Improved
- Terminals redraw smoothly in real time while you resize the window, without jumping lines or overflow.

### Fixed
- Pull requests opened after a plan is complete are also reviewed and merged automatically.

## 0.9 (v0.9.0 · Oct 26, 2026)

### New
- Repository logos in the sidebar. The Athena workspace always shows the Athena logo.

## 0.8 (v0.8.0 – v0.8.2 · Oct 26, 2026)

### New
- Repository images in expanded sidebar rows.

### Fixed
- ⌘⌫ deletes to the start of the line, and ⇧↩ inserts a new line instead of sending.

## 0.7 (v0.7.0 · Oct 26, 2026)

### Improved
- Core updates apply right away, even while agents are working. Commits and heavy commands finish first.

## 0.6 (v0.6.0 – v0.6.1 · Oct 26, 2026)

### New
- Automatic pull request review starts as soon as work is pushed and carries over earlier approvals. Without Codex, Claude reviews twice.

### Fixed
- Automatic flows resolve merge conflicts more reliably.

## 0.5 (v0.5.0 · Oct 26, 2026)

### Improved
- Automatic review settles implementation details itself, raises all comments at once and blocks only on real problems.

## 0.4 (v0.4.0 · Oct 26, 2026)

### New
- Rename repositories and give them images. Shared through pack export and backup.

## 0.3 (v0.3.0 – v0.3.1 · Oct 26, 2026)

### New
- Choose a model for each role in a pack: agents, pull request review and learning review.

## 0.2 (v0.2.0 · Oct 26, 2026)

### New
- Version numbers. Every release is tagged and the app shows its version.

