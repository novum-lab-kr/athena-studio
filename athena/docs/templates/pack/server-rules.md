# 서버 {{name}} 규칙

> 서버 `{{name}}`(ssh 별칭 `{{host}}`)에서 지킬 것. 등록 {{today}} — 확인 필요 칸은 분석이 채운다.

## 필수
- 접속은 `scripts/ssh-run.sh {{name}}` 로만 — 주소 · 사용자 · 키는 각자 `~/.ssh/config`(팩 · 계획서 · 보고에 적지 않는다)
- 팩 레포에서 배포된 코드는 서버에서 고치지 않는다 — 그 레포에서 고쳐 배포한다. 서버에서 직접 고치는 것은 서버 설정뿐
- 위험한 것만 묻는다(판정 정본 `scripts/lib/server_allow.py`) — 읽기 · 파일 쓰기 · mkdir · `systemctl daemon-reload` · 명령 잇기는 바로. 서비스 재시작 · 멈춤 · 켜기/끄기 · 삭제 · 설치/제거 · 권한 · 사용자 · 재부팅 · 디스크 · 방화벽 · crontab 고치기 · 판정 못 한 명령은 `ssh-run.sh` 가 연 확인 요청에 `실행` 답을 받은 뒤에만
- 파일 고치기는 `ssh-run.sh {{name}} --put <로컬> <원격>` 이 원격 `~/.athena-backups/<시각>/` 에 원본을 백업한 뒤 덮어쓴다 — 보호 경로(sudoers · cron · fstab · `/etc/ssh` · `.ssh` · `/boot` …)와 다음에 실행되는 자리(`/etc/profile.d` · `rc.local` · `/etc/systemd` · `ld.so.conf` · `/usr/local/bin` · 셸 rc …)만 먼저 확인(diff · 백업 위치). 명령으로 바로 쓴 파일(`tee` · `>` · `sed -i` · `cp`)은 백업이 없다 — 되돌릴 일이 있으면 먼저 `cp -p <파일> <파일>.bak` 하거나 `--put` 을 쓴다
- `.env*` · 키 · 인증서 내용은 읽지 않는다 — 있는지 · 크기 · 권한만

## 이 서버만의 규칙
- 확인 필요 — 분석 뒤 채운다(예: 다시 켜도 되는 시간대 · 같이 쓰는 사람 · 먼저 알릴 곳)
