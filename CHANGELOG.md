# Changelog

All notable user-facing changes to Athena Studio. Internal refactors and tests are not listed.

<!-- 시작점: 홈페이지 창이 athena-studio GitHub 릴리스 v0.2.0 ~ v0.13.34(2026-10-26 ~ 28) 제목에서 손님에게 보이는 것만 골라 영어로 요약(2026-10-28). 홈페이지 /releases 와 같은 내용 -->

<!-- 0.15: 첫 배포판 — #80 ~ #88 머지에서 손님에게 보이는 것만(개발판 전용 수정 · refactor · 문서는 뺌). 배포판 Release 본문은 그 minor 절(## X.Y) — 범위 끝은 올릴 때 실제 태그로 채우거나 열어 둔다 -->

<!-- 0.16 · 0.17: v0.15.9..main 머지(#97 ~ #103)를 태그 v0.16.* · v0.17.* 경계로 나눠 손님에게 보이는 것만(빌드 · 올리기 스크립트 · 번호 체계 같은 내부는 뺌) -->

<!-- 0.17 끝 · 0.18 · 0.19: v0.17.6..main 머지(#109 ~ #115)를 태그 v0.17.7 · v0.18.* · v0.19.* 경계로 나눠 손님에게 보이는 것만(#115 README 정리는 앱 밖이라 뺌). 0.19 범위 끝은 열어 둔다 -->

## 0.19 (v0.19.0 – · Oct 29, 2026)

### New
- Right-clicking a pane shows its number and name at the top of the menu, so you can find the pane a report mentions.

## 0.18 (v0.18.0 – v0.18.3 · Oct 29, 2026)

### New
- Drag the edges to resize the workspace list on the left, the Explorer on the right, and the monitor at the bottom.

### Improved
- Resize handles no longer light up with a colored box; only the cursor changes.

### Fixed
- Dragging the border between panes is no longer blocked by the left pane's scrollbar.
- The details icon in a pane's header shows even when the board is not running.
- The Work and Settings buttons at the top right are no longer left disabled after leaving the start screen.

## 0.17 (v0.17.0 – v0.17.7 · Oct 28–29, 2026)

### New
- Athena can watch a repository's open GitHub issues: when turned on, new issues are imported as work items and handed to Athena, and the agent monitor shows a line for each.
- The Mac app's menu has a Third-Party Notices item with the license texts of the open-source software it includes.

### Improved
- The license terms were updated.
- Work alerts show only things you need to decide. Status updates from automatic pull request reviews go to the Athena pane instead.

### Fixed
- Plans with sub-steps left are no longer completed automatically.

## 0.16 (v0.16.0 – v0.16.2 · Oct 28, 2026)

### New
- The Mac app updates itself from Settings (⚙): when a new version is out, press Update to download it, verify it, and restart. If anything fails, the current version keeps running and a short reason is shown.

### Improved
- New agent panes split the largest pane along its longer side.

### Fixed
- The Explorer opens for workspaces whose folder was deleted, using the pane's folder instead or saying the folder is gone.
- Choices from the decision console and repository picker are no longer lost when an agent is showing a question. They are sent once the question closes.

## 0.15 (v0.15.0 – v0.15.9 · Oct 28, 2026)

### New
- Athena Studio is available as a Mac app for Apple Silicon and Intel (macOS 13 Ventura or later). It is signed and notarized by Apple, so it opens without a security warning.

### Fixed
- Switching to a pack for the first time no longer shows the previous pack's state when an older list finishes loading late.
- Pane details keep the plan's title even when the plan has an empty title line.

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

