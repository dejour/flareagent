"""Local-only smoke test for attachment upload, ownership, and task history."""
import base64
import json
import os
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get('TEST_BASE_URL', 'http://127.0.0.1:3000')
assert BASE.startswith(('http://localhost:', 'http://127.0.0.1:'))
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
USER = 'attachment-' + str(uuid.uuid4())
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xfoAAAAASUVORK5CYII=')

def request(path, method='GET', body=None, user=USER, content_type='application/json'):
    headers = {'x-cloudagent-test-user': user, 'Content-Type': content_type}
    data = json.dumps(body).encode() if content_type == 'application/json' and body is not None else body
    req = urllib.request.Request(BASE + '/api/' + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()

status, _, raw = request('tasks', 'POST', {
    'prompt': 'Inspect the attached screenshot',
    'requestId': str(uuid.uuid4()),
    'deferStart': True,
})
assert status == 201, raw
task_id = json.loads(raw)['task']['id']
boundary = 'flareagent-test-' + uuid.uuid4().hex
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\n'
        'Content-Type: image/png\r\n\r\n').encode() + PNG + f'\r\n--{boundary}--\r\n'.encode()
path = f'tasks/{task_id}/attachments?initial=1'
status, _, raw = request(path, 'POST', body, content_type=f'multipart/form-data; boundary={boundary}')
assert status == 201, raw
attachment_id = json.loads(raw)['id']
status, _, raw = request(f'tasks/{task_id}')
assert status == 200 and json.loads(raw)['events'][0]['attachments'][0]['id'] == attachment_id, raw
path = f'tasks/{task_id}/attachments/{attachment_id}'
status, headers, raw = request(path)
assert status == 200 and headers['Content-Type'] == 'image/png' and raw == PNG
assert request(path, user='another-user')[0] == 404
fake = body.replace(PNG, b'<script>alert(1)</script>')
assert request(f'tasks/{task_id}/attachments?initial=1', 'POST', fake,
               content_type=f'multipart/form-data; boundary={boundary}')[0] == 415
print('PASS image upload, history, download, and owner isolation')
