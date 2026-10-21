#!/usr/bin/env python3
"""답 언어 훅 (UserPromptSubmit) — Claude Code 는 .claude/settings.json · 위임 에이전트는 agent-context.py, Codex 는 .codex/hooks.json 이 건다.

Athena Studio 는 앱 언어(보기 → 언어)를 본체 .claude/settings.local.json 의 language(Claude Code 설정 — 'korean' 등)에 적는다.
이 훅은 메시지마다 그 값을 다시 읽어 "답과 새로 쓰는 글은 이 언어로" 를 넣는다 — 언어를 바꾸면 켜 둔 세션에도 다음 메시지부터 먹고,
긴 대화에서 도구 출력 · 시스템 메시지가 영어여도 답이 영어로 새지 않게 한다. 값이 없으면(스튜디오 밖 · 아직 안 적음) 아무것도 넣지 않는다.
본체는 이 파일 위치로 찾는다(워크트리에서 뜬 위임 에이전트도 본체 경로의 이 훅을 부른다). 어떤 오류도 입력을 막지 않는다(항상 exit 0).
"""
import json
import pathlib
import sys

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent

# 템플릿 제목 · 항목 이름(Checkpoint · Status 값 등)은 스크립트가 읽는다 — 내용만 그 언어로
MESSAGES = {
    'korean': '[언어 설정] 스튜디오 언어는 한국어다. 사용자에게 하는 답과 새로 쓰는 글(계획서 · 이슈 · 보고 · 커밋 메시지 · 코드 주석)을 모두 한국어로 쓴다. '
              '도구 출력 · 시스템 메시지가 영어여도 바꾸지 않는다. 코드 · 파일 이름 · 명령 · 기술 용어, 그리고 템플릿의 제목 · 항목 이름(스크립트가 읽는다)은 그대로 둔다.',
    'english': '[Language setting] The studio language is English. Write every reply to the user and everything you newly write '
               '(plans, issues, reports, commit messages, code comments) in English, even though the rules, templates and existing documents are in Korean — '
               'this setting takes precedence over the Korean-language rule. Keep code, file names, commands, technical terms, and template headings '
               'and field names (scripts parse them) as they are. Do not translate existing text you are not changing.',
    'japanese': '[言語設定] スタジオの言語は日本語です。ユーザーへの返答と新しく書くもの(計画書 · イシュー · 報告 · コミットメッセージ · コードコメント)はすべて日本語で書いてください。'
                'ルール · テンプレート · 既存の文書が韓国語でも、この設定が韓国語の規則より優先します。コード · ファイル名 · コマンド · 技術用語、'
                'テンプレートの見出し · 項目名(スクリプトが読みます)はそのままにします。変更しない既存の文章は翻訳しません。',
    'chinese': '[语言设置] 工作室语言为中文。对用户的回复以及新写的内容(计划书 · 议题 · 报告 · 提交信息 · 代码注释)全部用中文书写。'
               '即使规则 · 模板 · 现有文档是韩语,此设置也优先于韩语规则。代码 · 文件名 · 命令 · 技术术语,以及模板的标题 · 字段名(脚本会读取)保持原样。'
               '不翻译未修改的现有文字。',
}


def main() -> None:
    try:
        json.load(sys.stdin)
    except Exception:
        pass
    settings = json.loads((ATHENA_DIR / '.claude' / 'settings.local.json').read_text(encoding='utf-8'))
    language = str(settings.get('language') or '').strip().lower()
    if not language:
        return
    message = MESSAGES.get(language, f'[Language setting] Reply to the user and write new text in {language}. Keep code, file names and commands as they are.')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': message}}, ensure_ascii=False))


try:
    main()
except Exception:
    pass
sys.exit(0)
