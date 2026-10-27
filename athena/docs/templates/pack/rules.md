# {{knowledgeLabel}} 레포 규칙

공통 규칙(`docs/knowledge/common/`)에 더해, 이 레포에서 다른 점과 고유 규칙. 원문: 레포 안 `README.md`·`CLAUDE.md`·`AGENTS.md` 등(있으면).

> 뼈대 — `athena scaffold` 가 만들었다({{today}}). "확인 필요" 줄은 `/setup` 또는 첫 작업에서 레포 코드를 읽고 채운다.

## 필수 — 작업 크기와 무관하게 항상 적용
- 이 레포 밖은 수정하지 않는다
- 확인 필요 — 금지 사항·용어 규칙·생성물(직접 고치지 않는 파일)

## 언어 · 타입 상태
- {{typeState}}
- 새 파일 · 고친 곳은 이 상태의 최신 쪽으로 쓴다(`docs/knowledge/common/coding.md` "언어 · 타입"). 상태를 바꾸는 일(tsconfig · 빌드 · 타입 검사 추가)은 계획서 결정으로
- 이 레포가 공통 "층별 기준"(새로 만들 때의 기본값)과 다르게 하는 것 — 확인 필요(없으면 "없음"). 여기 적은 것이 공통보다 먼저다

## 포맷·검증
- 검증: `scripts/verify/{{verifyCmd}}`
- 확인 필요 — 포맷 설정(Prettier·ESLint·ruff 등)
- 타입 검사 — 설정(`tsconfig.json` · `jsconfig.json` · pyright 설정)이 있으면 검증 스크립트가 돌린다(`scripts/verify/_lib.sh` `typecheck_step` — 섞어 쓰는 중 · pyright 는 바뀐 파일 오류만 실패)

## Git
- **문서·지식의 기준 브랜치는 `origin/{{branch}}`**(운영 반영분, 정본은 팩 `pack.json`)
- **작업 base·PR 대상은 `{{prBase}}`**
