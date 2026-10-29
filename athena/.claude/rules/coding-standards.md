# 공통 코드 규칙

정본은 `docs/knowledge/common/coding.md`(팀 공통) → `docs/knowledge/<레포>/rules.md`(레포) → 레포 원문 문서 순이며 뒤가 우선한다. 아래는 늘 기억할 요약.

## 작업 원칙
- 작업 전 반드시 기존 코드 패턴을 분석하고 그 패턴을 따른다 — 구조 · 이름 · 폴더 · 라이브러리는 기존 패턴, **언어 · 타입 · 문법 수준은 아래 "언어 · 타입 · 최신 문법" 이 먼저**
- 범위 · 포맷(작업한 파일만 — `prettier --write <파일>`) · 담당 레포 밖 금지는 `AGENTS.md` 5절

## 언어 · 타입 · 최신 문법 (상세 `coding.md` "언어 · 타입" · "최신 문법" · "층별 기준")
- 새 레포 · 새 프로젝트는 TypeScript `strict`(Python 은 타입 힌트 + pyright) · `tsconfig` `strict` · `noUncheckedIndexedAccess` · `target` ES2022 이상
- 기존 레포는 레포 `rules.md` "언어 · 타입 상태"(JS + JSDoc · `checkJs` / 섞어 쓰는 중 / TS)를 따르고 새 파일 · 고친 곳은 그 상태의 최신 쪽으로. 칸이 없으면 지금 코드가 상태(빌드 없는 레포에 `.ts` 를 만들지 않는다). 전환 PR 은 동작을 바꾸지 않는다
- 최신 문법(ES2015+)이 기본 — `const` / `let`(`var` 금지) · 화살표 함수 · 구조 분해 · 스프레드 · 템플릿 문자열 · `async` / `await` · `?.` · `??` · 클래스 필드 · 최신 Array / Object 메서드 · ES 모듈. CommonJS 레포의 모듈 방식은 `rules.md` 상태대로(바꾸면 새 파일부터)
- 새로 만들 때의 층별 기본값(레포 `rules.md` 가 다르게 정하면 그쪽이 먼저) — FE: 웹 서비스 Next.js · 앱 안 화면 · 단일 페이지 도구 Vite + React / BE: OpenAPI 계약 · 하위 호환(추가만) · 경계에서 입력 검증 · 오류 `{ code, message }` · 비밀값은 환경 변수 · UTC 저장 · 마이그레이션 · JSON 로그 · `/health` — Node 는 TS · NestJS(큰 서버) · Fastify(작은 서비스) · zod, Python 은 3.12+ · 타입 힌트 · pyright · ruff · uv · FastAPI + pydantic v2 / 앱: React Native + Expo · TS `strict` · 비밀 키는 앱에 넣지 않는다

## 변수명 / 가독성
- 1개 문자 변수명 금지 (반복문 변수 포함)
- 3항 연산자 중첩 금지. 필요하면 별도 함수로 분리
- 새 코드에서 `any` 금지. `unknown`으로 받아 narrowing
- 이번 변경으로 생긴 미사용 import·변수·함수는 정리한다. 기존 미사용 코드는 요청 범위일 때만 지우고, 아니면 보고에만 적는다(이슈 등록 기준 `docs/issues.md`)

## 단순한 구현
- 현재 요구에 필요 없는 범용화·옵션·prop 을 추가하지 않는다. 가독성·테스트·기존 패턴을 위한 분리와 필수 상태·오류 처리·외부 입력 검증·보안 처리는 유지한다. 상세는 `docs/knowledge/common/coding.md` "단순한 구현"

## 성능
- O(n²) 이상 로직, 2중 이상 반복문은 재검토 대상

## 오류 대응
- 같은 오류 3회 반복 시 접근 방식을 전면 재검토하고 아테나에 보고

## 보안
- 비밀값(토큰 · 키 · 비밀번호 · `.env*`) 노출 금지 — 정본 `AGENTS.md` 5절. 서버 전용 값 · storage 는 `coding.md` "보안"
