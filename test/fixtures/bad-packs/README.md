# 나쁜 팩 fixture

- future-format — 모르는 형식 버전 → format-unknown
- no-pack-json — pack.json 없음 → invalid-pack
- outside-link — 팩 밖(/etc/hosts)을 가리키는 링크 → unsafe
- .env 가 든 팩 · ../ 가 든 압축 · 링크 폴더를 거치는 우회 · 최상위 .git → /etc 링크는 test/packs-test.sh 가 그때 만든다(비밀 모양 파일을 레포에 두지 않으려고 · git 은 .git 이란 이름의 경로를 커밋하지 못한다)
