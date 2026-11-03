"""위임 시험의 발신자 화면 — 사용자 pane 환경·데몬에 연결하지 않는다."""
import os
import pathlib


class Backend:
    def self_info(self):
        pane = os.environ.get('FAKE_LEAD_PANE') or ''
        return {'inside': bool(pane), 'pane_id': pane}

    def get_pane(self, pane):
        if os.environ.get('FAKE_LEAD_CLOSED') == '1' or pane != os.environ.get('FAKE_LEAD_PANE'):
            raise ValueError('없는 시험 pane')
        return {'id': pane, 'cwd': str(pathlib.Path(__file__).resolve().parents[2]), 'agent': 'claude'}


def get_backend():
    return Backend()
