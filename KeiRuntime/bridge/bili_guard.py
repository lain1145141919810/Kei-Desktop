"""Deterministic containment and heuristic quarantine; not a perfect detector."""
import base64
import re
import unicodedata
from urllib.parse import unquote

RULES = re.compile(
    r'ignore.{0,45}(instruction|previous|system)|system\s*(prompt|message)|developer\s*(message|mode)|'
    r'<\s*/?\s*(system|assistant|tool|analysis)|["\']role["\']\s*:|'
    r'忽略.{0,20}(指令|规则|设定)|系统提示|开发者模式|你现在(是|必须)|'
    r'(读取|发送|泄露|上传|获取).{0,20}(密钥|密码|cookie|令牌|凭据)|'
    r'指示.{0,15}(無視|上書き)|システムプロンプト|'
    r'(powershell|cmd\.exe|exec_command|bili_reply|bili_send_message|curl\s|invoke-webrequest)|'
    r'(sessdata|bili_jct|api[_ -]?key|authorization\s*:|bearer\s+)', re.I | re.S)

def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text) if unicodedata.category(c) not in ('Cf', 'Cc') or c in '\n\t')

def suspicious(text):
    value = normalized(str(text))
    forms = [value, unquote(value)]
    for token in re.findall(r'[A-Za-z0-9+/]{32,}={0,2}', value)[:30]:
        try:
            forms.append(base64.b64decode(token, validate=True).decode('utf-8'))
        except (ValueError, UnicodeError):
            pass
    return any(RULES.search(form) for form in forms)

def public_text(text, maximum=240):
    if not isinstance(text, str) or not 8 <= len(text) <= maximum:
        raise ValueError('invalid_public_text')
    if any(unicodedata.category(c) in ('Cf','Cc') for c in text) or suspicious(text):
        raise ValueError('unsafe_public_text')
    if re.search(r'https?[:：]|www\.|@|[a-zA-Z]:[\\/]|\d{7,}|<|>|\[(?:CQ|at)', normalized(text), re.I):
        raise ValueError('link_mention_path_or_identifier')
    return text
