# 셸 한 줄 만들기 — 인자마다 작은따옴표로 감싸 공백으로 잇는다(scripts/screen pane run 에 넘길 명령용).
# pane run 은 단어를 따옴표 없이 이어 붙여 그 pane 의 셸에 한 줄로 친다 — 띄어쓰기 든 경로(Application Support)·한글 인자가
# 쪼개지지 않게 이걸로 한 줄을 만들어 넘긴다. printf '%q' 는 로케일이 없으면 한글을 바이트로 깨뜨려 쓰지 않는다.
#   . "$ATHENA_DIR/scripts/lib/shell-line.sh"; "$SCREEN" pane run "$PANE" "$(shell_line node "$ATHENA_DIR/x.mjs" --flag)"
shell_line() {
  local out="" arg quote="'\\''"   # 인자 안의 ' 는 '\'' 로(닫고 · 이스케이프한 ' · 다시 연다)
  for arg in "$@"; do
    out+="'${arg//\'/$quote}' "
  done
  printf '%s' "${out% }"
}
