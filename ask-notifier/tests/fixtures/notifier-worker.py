"""Offline NDJSON peer for Node transport tests; never imports the native bridge."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--state-dir', required=True)
args = parser.parse_args()
state_dir = Path(args.state_dir)
state_dir.mkdir(parents=True, exist_ok=True)
journal = state_dir / 'fixture-journal.json'
records = json.loads(journal.read_text()) if journal.exists() else {}


def persist():
    temporary = journal.with_suffix('.tmp')
    temporary.write_text(json.dumps(records), encoding='utf-8')
    temporary.replace(journal)


for line in sys.stdin:
    envelope = json.loads(line)
    method, params = envelope['method'], envelope['params']
    with (state_dir / 'fixture-events.jsonl').open('a', encoding='utf-8') as events:
        events.write(json.dumps({'method': method, 'params': params}) + '\n')
    if method == 'inspect':
        value = {'state': 'ready', 'reason': None, 'accountId': 'wxid_fixture', 'version': '4.2.0.53'}
    elif method == 'query':
        saved = records.get(params['requestId'])
        value = {'found': False} if saved is None else {'found': True, **saved}
    elif method == 'send':
        value = {'state': 'unknown', 'reason': 'offline fixture unknown', 'accountId': 'wxid_fixture'}
        records[params['requestId']] = value
        persist()
        (state_dir / 'fixture-intent').write_text(params['requestId'], encoding='ascii')
        if params['text'] == 'exit-after-intent':
            os._exit(23)
        if params['text'] == 'malformed-after-intent':
            print('not-json', flush=True)
            time.sleep(60)
        if params['text'] == 'hold-after-intent':
            time.sleep(60)
        value = {'state': 'submitted', 'reason': None, 'accountId': 'wxid_fixture'}
        records[params['requestId']] = value
        persist()
    elif method == 'close':
        value = {'closed': True}
    else:
        raise AssertionError('Unexpected fixture RPC')
    print(json.dumps({'id': envelope['id'], 'result': value}), flush=True)
    if method == 'close':
        break
