"""Allowlisted error diagnostics; never serialize API raw responses or credentials."""
import json
import re
import time
import traceback
from pathlib import Path

ROOT = Path('D:/KeiRuntime/data/bilibili')

def clean(value):
    text = str(value)
    text = re.sub(r'https?://[^\s]+', '[URL]', text)
    text = re.sub(r'(?i)(bearer\s+)\S+', r'\1[REDACTED]', text)
    text = re.sub(r'''(?i)(["']?(?:cookie|set-cookie|authorization)["']?\s*[=:]\s*)[^\r\n]+''', r'\1[REDACTED]', text)
    text = re.sub(r'''(?i)(["']?(?:sessdata|bili_jct|access_token|refresh_token|api_key|token|password)["']?\s*[=:]\s*)["'][^"']*["']''', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)((?:sessdata|bili_jct|cookie|authorization|access_token|refresh_token|api_key|token|password)\s*[=:]\s*)[^\s,;]+', r'\1[REDACTED]', text)
    text = re.sub(r'[A-Za-z0-9_%-]{32,}', '[REDACTED]', text)
    return text[:500]

def error_detail(exc, action, stage, bvid=None):
    # ResponseCodeException.__str__ includes raw response: use .msg only.
    msg = getattr(exc, 'msg', None)
    if msg is None and isinstance(exc, (ValueError, OSError)):
        msg = str(exc)
    detail = {'at': time.time(), 'action': action, 'stage': stage,
              'error_type': type(exc).__name__, 'message': clean(msg) if msg else '',
              'bvid': bvid if isinstance(bvid,str) and re.fullmatch(r'BV[0-9A-Za-z]{10}',bvid) else None}
    for key in ('code', 'status', 'errno', 'host', 'port'):
        value = getattr(exc,key,None)
        if isinstance(value,(int,str)):
            detail[key] = clean(value) if isinstance(value,str) else value
    response = getattr(exc,'response',None)
    if isinstance(getattr(response,'status_code',None),int):
        detail['http_status'] = response.status_code
    os_error = getattr(exc,'os_error',None)
    if os_error:
        detail['os_error'] = clean(os_error)
    detail['stack'] = [{'file':Path(x.filename).name,'line':x.lineno,'function':x.name}
                       for x in traceback.extract_tb(exc.__traceback__)[-8:]]
    return detail

def write_error(detail, root=ROOT):
    """Logging failures must not change a submitted action's outcome."""
    try:
        root = Path(root)
        root.mkdir(parents=True,exist_ok=True)
        path = root/'interaction-errors.jsonl'
        if path.exists() and path.stat().st_size > 2_000_000:
            path.replace(root/'interaction-errors.previous.jsonl')
        with path.open('a',encoding='utf-8') as out:
            out.write(json.dumps(detail,ensure_ascii=False)+'\n')
    except OSError:
        pass
