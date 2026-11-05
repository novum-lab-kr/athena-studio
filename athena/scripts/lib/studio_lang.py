"""사람에게 보이는 코어 문구의 언어 — 앱 언어를 따른다.

Athena Studio 는 고른 언어를 본체 .claude/settings.local.json 의 language(korean · english · japanese · chinese)에 적는다
(훅 language.py · 현황판 scripts/board/i18n.mjs 가 같은 값을 읽는다). 값이 없거나 못 읽으면 한국어.
에이전트만 보는 안내(additionalContext · permissionDecisionReason)와 로그는 이걸로 바꾸지 않는다 — 사람이 보는 글만.
"""
import json
import pathlib

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
FROM_SETTING = {'korean': 'ko', 'english': 'en', 'japanese': 'ja', 'chinese': 'zh'}
FALLBACK = 'ko'


def language(root=ATHENA_DIR) -> str:
    """본체의 지금 언어 — ko · en · ja · zh"""
    try:
        settings = json.loads((pathlib.Path(root) / '.claude' / 'settings.local.json').read_text(encoding='utf-8'))
        return FROM_SETTING.get(str(settings.get('language') or '').strip().lower(), FALLBACK)
    except Exception:
        return FALLBACK


def pick(texts: dict, **values) -> str:
    """언어별 글 {'ko': …, 'en': …} 에서 지금 언어 것을 고르고 '{이름}' 자리를 채운다(빠진 언어는 한국어)"""
    text = texts.get(language()) or texts[FALLBACK]
    return text.format(**values) if values else text

