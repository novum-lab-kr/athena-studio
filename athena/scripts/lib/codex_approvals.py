"""공식 Codex 요청의 원래 연결·식별자·선택지를 보관한다. 화면/키 입력은 해석하지 않는다."""
import copy
import threading
import time
import uuid
from typing import Callable


def choices_for(method: str, params: dict) -> list[dict]:
    if method == 'item/commandExecution/requestApproval':
        decisions = params.get('availableDecisions')
        if not isinstance(decisions, list):
            decisions = ['accept', 'acceptForSession', 'decline', 'cancel']
            amendment = params.get('proposedExecpolicyAmendment')
            if isinstance(amendment, list) and amendment:
                decisions.insert(2, {'acceptWithExecpolicyAmendment': {'execpolicy_amendment': amendment}})
            for rule in params.get('proposedNetworkPolicyAmendments') or []:
                decisions.insert(2, {'applyNetworkPolicyAmendment': {'network_policy_amendment': rule}})
        choices = []
        for decision in decisions:
            key = decision if isinstance(decision, str) else next(iter(decision), '')
            if key not in ('accept', 'acceptForSession', 'decline', 'cancel', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'):
                continue
            choices.append({'key': key, 'detail': decision if isinstance(decision, dict) else None, 'result': {'decision': decision}})
        return choices
    if method == 'item/fileChange/requestApproval':
        return [{'key': value, 'result': {'decision': value}} for value in ('accept', 'acceptForSession', 'decline', 'cancel')]
    if method == 'item/permissions/requestApproval' and isinstance(params.get('permissions'), dict):
        return [{'key': key, 'result': {'permissions': granted, 'scope': scope}} for key, granted, scope in (
            ('acceptForTurn', params['permissions'], 'turn'), ('acceptForSession', params['permissions'], 'session'), ('decline', {}, 'turn'))]
    if method == 'item/tool/requestUserInput':
        questions = params.get('questions')
        if isinstance(questions, list) and len(questions) == 1:
            question = questions[0]
            options = question.get('options') or []
            if isinstance(question.get('id'), str) and not question.get('isSecret') and options and all(isinstance(option.get('label'), str) for option in options):
                return [{'key': 'original', 'label': option['label'], 'description': option.get('description', ''),
                         'result': {'answers': {question['id']: {'answers': [option['label']]}}}} for option in options]
        return []
    # Browser 등 MCP의 유한 선택 폼은 원래 값/제목을 보존한다. 자유 입력·인증 URL은 TUI에서 처리한다.
    if method == 'mcpServer/elicitation/request' and params.get('mode') == 'form':
        schema = params.get('requestedSchema') or {}
        properties = schema.get('properties') or {}
        if len(properties) == 1:
            name, field = next(iter(properties.items()))
            values = field.get('enum')
            labels = field.get('enumNames') or values
            if not values and field.get('oneOf'):
                values = [option.get('const') for option in field['oneOf']]
                labels = [option.get('title') for option in field['oneOf']]
            if isinstance(values, list) and values and isinstance(labels, list) and len(labels) == len(values) and all(isinstance(value, str) for value in values + labels):
                result = [{'key': 'original', 'label': labels[index], 'result': {'action': 'accept', 'content': {name: value}}} for index, value in enumerate(values)]
                return result + [{'key': 'mcp' + action.capitalize(), 'result': {'action': action}} for action in ('decline', 'cancel')]
    return []


class Approvals:
    def __init__(self, pane: str, body: str, send: Callable[[dict], None]):
        self.pane = pane
        self.body = body
        self.generation = str(uuid.uuid4())
        self.send = send
        self.lock = threading.RLock()
        self.pending: dict[str, dict] = {}
        self.finished: set[str] = set()
        self.inflight: dict[str, threading.Event] = {}
        self.turns: dict[str, str] = {}
        self.closed = False
        self.items: dict[tuple[str, str], dict] = {}

    @staticmethod
    def identity(request_id: object) -> str:
        return repr(request_id)

    def server(self, message: dict) -> None:
        with self.lock:
            method = message.get('method')
            params = message.get('params') or {}
            if method == 'turn/started':
                thread = params.get('threadId')
                turn = (params.get('turn') or {}).get('id')
                self.invalidate(thread)
                if isinstance(thread, str) and isinstance(turn, str):
                    self.turns[thread] = turn
            elif method == 'item/started':
                item = params.get('item') or {}
                if isinstance(params.get('threadId'), str) and isinstance(item.get('id'), str):
                    self.items[(params['threadId'], item['id'])] = copy.deepcopy(item)
            elif method in ('turn/completed', 'thread/closed', 'thread/archived'):
                self.invalidate(params.get('threadId'))
            elif method == 'serverRequest/resolved':
                key = self.identity(params.get('requestId'))
                self.finish(key)
                event = self.inflight.pop(key, None)
                if event:
                    event.set()
            elif 'id' in message and isinstance(method, str):
                key = self.identity(message['id'])
                if key in self.pending or key in self.finished:
                    return
                thread, turn = params.get('threadId'), params.get('turnId')
                choices = choices_for(method, params)
                # turn 없는 MCP 요청도 원래 RPC로는 처리하지만 앱 직접 선택에는 올리지 않는다.
                direct = bool(choices and isinstance(thread, str) and turn and self.turns.get(thread) == turn)
                self.pending[key] = {'token': str(uuid.uuid4()), 'receivedAtMs': int(time.time() * 1000), 'envelope': copy.deepcopy(message), 'choices': choices if direct else []}

    def finish(self, key: str) -> None:
        self.pending.pop(key, None)
        self.finished.add(key)

    def invalidate(self, thread: object) -> None:
        for key, record in list(self.pending.items()):
            if record['envelope'].get('params', {}).get('threadId') == thread:
                self.finish(key)
        self.turns.pop(thread, None)
        for key in list(self.items):
            if key[0] == thread:
                del self.items[key]

    def client(self, message: dict) -> None:
        with self.lock:
            method = message.get('method')
            if method in ('turn/interrupt', 'turn/start', 'thread/unsubscribe', 'thread/archive', 'thread/resume'):
                self.invalidate((message.get('params') or {}).get('threadId'))
            if 'id' in message and 'method' not in message:
                key = self.identity(message['id'])
                if key in self.finished:
                    return
                if key in self.pending:
                    self.finish(key)
            self.send(message)

    def listing(self) -> list[dict]:
        with self.lock:
            if self.closed:
                return []
            return [{'token': record['token'], 'generation': self.generation, 'pane': self.pane, 'body': self.body,
                     'method': record['envelope']['method'], 'receivedAtMs': record['receivedAtMs'], 'params': copy.deepcopy(record['envelope']['params']),
                     'item': copy.deepcopy(self.items.get((record['envelope']['params'].get('threadId'), record['envelope']['params'].get('itemId')))),
                     'choices': [{key: value for key, value in choice.items() if key != 'result'} for choice in record['choices']]}
                    for record in self.pending.values() if record['choices']]

    def answer(self, payload: dict) -> bool:
        with self.lock:
            if self.closed or payload.get('generation') != self.generation or payload.get('pane') != self.pane or payload.get('body') != self.body:
                return False
            record = next((record for record in self.pending.values() if record['token'] == payload.get('token')), None)
            index = payload.get('choice')
            if not record or type(index) is not int or not 0 <= index < len(record['choices']):
                return False
            params = record['envelope']['params']
            if self.turns.get(params['threadId']) != params['turnId']:
                return False
            key = self.identity(record['envelope']['id'])
            result = record['choices'][index]['result']
            # 쓰기 전에 소비한다. 쓰기 실패 뒤에도 허가를 자동 재전송하지 않는다.
            self.finish(key)
            confirmed = threading.Event()
            self.inflight[key] = confirmed
            self.send({'id': record['envelope']['id'], 'result': copy.deepcopy(result)})
        # 성공은 공식 resolved 알림까지 확인한다. 시간 초과에도 응답을 재전송하지 않는다.
        ok = confirmed.wait(2)
        with self.lock:
            self.inflight.pop(key, None)
        return ok

    def close(self) -> None:
        with self.lock:
            self.closed = True
            self.pending.clear()
            self.turns.clear()
            self.items.clear()
