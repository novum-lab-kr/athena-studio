# {{knowledgeLabel}} 레포 규칙

공통 규칙(`docs/knowledge/common/`)에 더해, 이 레포에서 다른 점과 고유 규칙. 원문: 레포 안 `README.md`·`CLAUDE.md`·`AGENTS.md` 등(있으면).

> 뼈대 — `athena scaffold` 가 만들었다({{today}}). "확인 필요" 줄은 `/setup` 또는 첫 작업에서 레포 코드를 읽고 채운다.

## 필수 — 작업 크기와 무관하게 항상 적용
- 이 레포 밖은 수정하지 않는다
- 확인 필요 — 금지 사항·용어 규칙·생성물(직접 고치지 않는 파일)

## 포맷·검증
- 검증: `scripts/verify/{{verifyCmd}}`
- 확인 필요 — 포맷 설정(Prettier·ESLint·ruff 등)

## Git
- **문서·지식의 기준 브랜치는 `origin/{{branch}}`**(운영 반영분, 정본은 팩 `pack.json`)
- **작업 base·PR 대상은 `{{prBase}}`**
