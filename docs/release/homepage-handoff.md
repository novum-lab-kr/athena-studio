# 홈페이지(athena.novum-lab.com) 작업에 넘기는 것 — Athena Studio 배포판

보내는 쪽: 아테나(Athena Studio 레포 팀 리드) · 2026-10-28
상태: 배포판 1단계(패키징) 진행 중 — 아래 주소에는 아직 파일이 없다. 첫 배포판이 올라가면 알린다.

## 1. 홈페이지가 읽을 고정 주소 (이것만 지키면 늘 최신)
- Apple Silicon: `https://github.com/novum-lab-kr/athena-studio-releases/releases/latest/download/Athena-Studio-mac-arm64.dmg`
- Intel:        `https://github.com/novum-lab-kr/athena-studio-releases/releases/latest/download/Athena-Studio-mac-x64.dmg`
- 버전 정보:     `https://github.com/novum-lab-kr/athena-studio-releases/releases/latest/download/latest.json`

latest.json 모양:
```json
{
  "version": "0.14.0",
  "date": "2026-10-30",
  "minMacOS": "12.0",
  "files": [
    { "arch": "arm64", "name": "Athena-Studio-mac-arm64.dmg", "size": 123456789, "sha256": "…" },
    { "arch": "x64",   "name": "Athena-Studio-mac-x64.dmg",   "size": 123456789, "sha256": "…" }
  ]
}
```
(위 값은 모양 예시 — 실제 version · minMacOS 는 첫 배포판에서 정해진다)

- 두 칩 모두 낸다 — 버튼을 [Download for Apple Silicon] · [Intel] 둘로, 또는 하나로 두고 아래에 다른 칩 링크
- 서명 · 공증된 판(손님 맥에서 바로 열림)
- 배포판은 기능(feat) 단위로 사람이 손으로 만든다 — 하루에 여러 번 바뀌지 않는다

## 2. 부탁 — 업데이트 내역
- 홈페이지 쪽에서 써 둔 **버전별 요약**을 손님용 `CHANGELOG.md`(영어 · 배포판마다 New / Improved / Fixed 몇 줄 · refactor · 테스트 같은 내부 정리는 뺌)의 시작점으로 쓰려 한다
- 그 요약의 **위치(파일 · 레포 경로)나 내용**을 보내 주세요
- 앞으로 CHANGELOG.md 를 어디서 보여 줄지(배포 레포 Release 본문 · 홈페이지가 CHANGELOG 를 읽어 그리기 등) 원하는 방식이 있으면 알려 주세요

## 3. 라이선스 · 약관 (초안 · 법률 검토 전)
- 레포 루트 `LICENSE`(소스 — 모든 권리 보유) · `docs/release/EULA.md`(손님용 사용 약관 · 영어)
- 홈페이지에 약관 페이지(/terms 등)를 둘 거면 `docs/release/EULA.md` 를 쓰면 된다 — `[ ]` 빈칸(이름 · 이메일 · 준거법 · 날짜)은 다 채움(2026-10-28 · 주소는 넣지 않음) · 당사자는 사업자 Novum Lab(대표 Eunju Kim · 사업자등록번호 496-37-01619 · 연락 mcsung@novum-lab.com — 홈페이지 하단과 같게 · 2026-10-28 바꿈) · 약관 5절이 가리키는 제3자 고지는 배포판 앱 `Contents/Resources/THIRD_PARTY_NOTICES.txt`(맥 메뉴 [Athena → Third-Party Notices])
- 구독은 나중 계획 — 생기면 EULA 에 절을 더하고 홈페이지에 알린다
