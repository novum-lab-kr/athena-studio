# Changelog

All notable user-facing changes to Athena Studio. Internal refactors and tests are not listed.

<!-- 시작점: 홈페이지 창이 athena-studio GitHub 릴리스 v0.2.0 ~ v0.13.34(2026-10-26 ~ 28) 제목에서 손님에게 보이는 것만 골라 영어로 요약(2026-10-28). 홈페이지 /releases 와 같은 내용 -->

<!-- 0.15: 첫 배포판 — #80 ~ #88 머지에서 손님에게 보이는 것만(개발판 전용 수정 · refactor · 문서는 뺌). 배포판 Release 본문은 그 minor 절(## X.Y) — 범위 끝은 올릴 때 실제 태그로 채우거나 열어 둔다 -->

<!-- 0.16 · 0.17: v0.15.9..main 머지(#97 ~ #103)를 태그 v0.16.* · v0.17.* 경계로 나눠 손님에게 보이는 것만(빌드 · 올리기 스크립트 · 번호 체계 같은 내부는 뺌) -->

<!-- 0.17 끝 · 0.18 · 0.19: v0.17.6..main 머지(#109 ~ #115)를 태그 v0.17.7 · v0.18.* · v0.19.* 경계로 나눠 손님에게 보이는 것만(#115 README 정리는 앱 밖이라 뺌). 0.19 범위 끝은 열어 둔다 -->

<!-- 0.20 ~ 0.25: v0.19.2..main 머지(#117 ~ #129)를 한 절(0.25)로 — 공개 배포판은 0.19.2 다음이 0.25 라서. 손님에게 보이는 것만(개발 앱 다시 켜기 #118 · 규칙 문서 정리 #123 은 뺌) -->

<!-- 0.28: v0.25.1..main 머지(#131 ~ #144)에서 손님에게 보이는 것만(규칙 문서 #139 · 테스트 · 데모는 뺌). 범위 끝은 열어 둔다 -->

<!-- 0.32: v0.28.7..main 머지(#146 ~ #155)에서 손님에게 보이는 것만(문서 #145 · 다이어그램 #151 은 뺌 · #152 는 #155 팝업 줄에 · #154 는 #153 설정 줄에 합침). 범위 끝은 v0.32.4 로 닫았다 -->

<!-- 0.40: v0.32.4..main 머지(#160 ~ #182)에서 손님에게 보이는 것만(개발 앱 묶음 #161 · 검증 범위 #177 #178 은 뺌 · #176 #181 은 PR 설정 줄에 · #172 는 #164 줄에 합침). 범위 끝은 열어 둔다 -->

<!-- 0.46: v0.42.2..main 머지(#198 ~ #210 · 검증 시간 줄이기)에서 손님에게 보이는 것만(README 만 바뀐 #199 #201 #202 #203 #206 #208 은 뺌). 범위 끝은 열어 둔다 -->

<!-- 0.47: v0.46.4..main 머지(#213 · #214)에서 손님에게 보이는 것만(#214 의 전체 검증 코어 시험은 개발용 팩 스크립트라 뺌). 범위 끝은 열어 둔다 -->

## 0.47 (v0.47.0 – · Nov 1, 2026)

### New
- Updating the app or core no longer closes your panes: running panes switch to the new code and keep going.
- If panes are running an older version that cannot switch, Athena lists the panes that would close and closes them only when you choose to. Otherwise you can keep using them as they are.
- A pack can allow specific commands for its repository's agent panes with `permissionsAllow`, so they run without a permission prompt.

### Fixed
- An agent's "done" notification now waits until its background commands have finished.
- An agent pane can now push review fixes to its open pull request even when no request is waiting on that pull request.
- A decision request without a decision console now stays a decision and opens as a question popup, so you can answer it in the app.

## 0.46 (v0.42.3 – v0.46.4 · Nov 1, 2026)

### New
- Athena finds each repository's rule documents and loads their full text into agent sessions. You can add or exclude documents in the pack; above 40,000 characters per repository, the largest files are listed instead.
- Small pull requests take a ⚡ fast path, shown as a chip on the Board card: one reviewer and one review, and after one round of fixes the work merges once verification and the conflict check pass. A repository can turn this off.

### Improved
- The Board's Metrics tab shows time by stage (work, verification, review, merge wait), review rounds and fixes per merge.
- Scripts now fill in a plan's validation line and status, and agent instructions and core test output are shorter.
- Standard verification runs core test suites in parallel — about 5 minutes down to under 2.

### Fixed
- Athena's commit script no longer refuses a valid worktree when the worktree list is long.
- A core update, rollback or catch-up now stops the automatic review process and starts it again on the new code if work remains, so the old process no longer removes the choices from questions in the Work popup.
- Automatic merge no longer goes ahead if the pull request's base changed while it was waiting.
- Reopening a request without options now keeps its existing choices.
- If a request changes while its answer dialog is open, your answer is not sent and a conflict message appears.

## 0.42 (v0.40.5 – v0.42.2 · Oct 31, 2026)

### Improved
- The window opens first on restart, and the core update runs in the background: the tab bar shows "core update in progress", and a result popup appears when it finishes. Pack commands, new agent panes and catch-up wait until the update is done.
- The core update popup shows short kind chips, and an update that only changes the last version number now lists its recent changes too.
- A dev-app update skips `npm install` when the dependencies are unchanged.
- When a dev-app update needs `npm install`, it now installs while the app keeps running and asks before restarting. The Settings row shows waiting for a turn and installing, and "Later" leaves a Restart button there.

### Fixed
- The QA runner no longer crashes with an assertion error from the HTTP client, and a case whose process died is now recorded as failed instead of passing.
- `init --scan` now reads the pack's `local.json` repositories root first.
- Splitting a pane or closing one no longer resizes the neighbouring panes' terminals by a rough guess while the app is attached.
- A forced kill of the install is no longer reported as an install failure: it is shown separately, the app stays open, and the install is retried on the next launch.
- A core update no longer fails on Node 24.5.0 because an old pack link pointing at a folder could not be deleted.

### Security
- Updated Electron to 44.10.0, so the Node built into the app is now the security release 24.22.1.

## 0.40 (v0.32.5 – v0.40.4 · Oct 30, 2026)

### New
- Choose per repository whether Athena opens a pull request, runs the automatic review, and merges, in Settings. Turning auto PR off skips the pull request and review and merges the work branch straight into the base branch once verification passes. Merging can be automatic, ask first in Work, or left to you.
- When a delegated agent finishes a turn, Athena is notified automatically. The agent's "next prompt" suggestion is turned off, so a leftover suggestion is no longer mistaken for text you were typing.
- In the Board's Learn tab, candidates are grouped by notebook so you can approve a group at once, view details, edit, or delete them. Fewer new candidates open: a one-off code finding waits until it shows up a second time.
- QA now runs layered test cases written from each repository's flow documents (front end and back end run; apps are documented only). The old service-diagram skill is removed.

### Improved
- Heavy commands such as builds and tests can run two at a time. The second slot opens only when memory is free and CPU load is below the core count.
- New worktrees install dependencies and set up the dev app automatically.
- Automatic review in Codex now uses the model and reasoning effort from your `~/.codex/config.toml`.
- Athena's commit script no longer refuses to commit when the only changes already staged are the files you named, including renames.

### Fixed
- An agent's question no longer disappears from the Work popup. Unanswered questions stay until the agent acknowledges or cancels them, and a failure to read requests is shown instead of an empty list.
- Switching packs back and forth no longer prints terminal output twice.
- After a pack is renamed during first setup, the pack in the left list opens instead of showing "pack not found".
- The commit guard no longer blocks Athena's own commit script when it is called through a variable set to a literal path.
- The auto PR switch in Settings now saves.
- The fingerprint step of `/sync` no longer crashes on a repository without its base branch; it skips that repository with a warning and does not confirm stale fingerprints.

## 0.32 (v0.28.8 – v0.32.4 · Oct 30, 2026)

### New
- After Athena's core updates, an in-app popup shows the previous and new versions, what's new, and how the update went, with working sessions listed by agent name.
- In packs without the Athena Studio repository, a bug report about Athena itself becomes a GitHub issue draft with private details hidden. Athena shows you the draft and opens it on GitHub for you to review and submit.

### Improved
- Athena hands a new task to an idle agent pane for the same repository instead of opening another pane.
- Agent panes start without MCP servers, so each reply uses fewer tokens. Reviewer panes keep them.
- The PR automation switches in Settings are named for what they turn on: "Auto PR · review" and "Merge right after approval". The warning line under them is gone.

### Fixed
- The commit guard no longer wrongly blocks Athena's own commit script when the message spans several lines or the path uses `~` or a variable.
- In repositories with auto-merge on, agents no longer ask you to merge a pull request they opened. Automatic review takes it through to merge, and the agent reports its state.

## 0.28 (v0.26.0 – v0.28.7 · Oct 29, 2026)

### New
- When an agent asks you a question in its pane, the question now also shows up as a request in Work, so you can pick an answer there.

### Improved
- Reports to the Athena pane now arrive in one step. If the Athena pane can't be found, the report is kept as a request instead of being lost.
- Delegating a task again updates which pane is the lead.
- Korean screen text now uses a plainer, more consistent tone.

### Fixed
- The side browser no longer flashes white when the board or a decision console opens, including while the panel slides out.
- Commands that kill processes by name (`pkill`, `killall`) or with a zero or negative target are blocked for agents, so one cannot stop unrelated processes.
- The secret-leak guard no longer blocks harmless `ps` commands.
- Opening a decision console from the Work popup now uses the side browser instead of your outside browser.
- In the agent monitor, Athena's own session shows as `athena` instead of a folder name.
- Work, Settings, and Board menu popups are no longer hidden while the side browser is open.

## 0.25 (v0.20.0 – v0.25.1 · Oct 29, 2026)

### New
- Drag files or folders from Finder onto a pane to paste their paths into its input line. Nothing is sent until you press Enter.
- When a pull request is opened, Athena warns if the tests added in it would also pass without the change (shown in the plan's validation and the PR description). It never blocks the PR.

### Improved
- Light tasks run on a lighter model, and a review after "needs changes" can use a stronger one (set per pack under `models`).
- Long agent sessions compact automatically earlier, at 200k tokens, for Athena and agent panes.
- In the Athena pane's details, task rows without a pane (in progress, finished, archived) open their plan in the same panel, with a back arrow to the task list.
- The Athena pane is named `<repo> · <plan title>` instead of an Athena prefix.

### Fixed
- The background process no longer shows a nameless icon in the Dock.
- After the background process restarts or the app updates, the app no longer creates an extra workspace named after a folder instead of the `athena` workspace; older workspaces with that name show as `athena`.
- Placeholder lines in an unedited plan template are no longer counted as remaining steps, and work that ends without a pull request is reported as done.

## 0.19 (v0.19.0 – v0.19.2 · Oct 29, 2026)

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

