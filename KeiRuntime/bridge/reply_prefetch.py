"""Bounded, non-presentational translation prefetch for AstrBot SSE."""
import re


class ReplySentenceCollector:
    def __init__(self, limit=2):
        self.text = ''
        self.seen = set()
        self.limit = limit

    def feed(self, item):
        if item.get('chain_type') in ('tool_call', 'tool_call_result'):
            self.text = ''
            return []
        if (item.get('type') != 'plain' or item.get('chain_type') not in (None, '', 'plain')
                or not isinstance(item.get('data'), str)):
            return []
        if len(self.seen) >= self.limit:
            return []
        delta = item['data']
        self.text = (self.text + delta if item.get('streaming') else delta)[-4096:]
        # An open fence or unfinished link can change cleanup; defer it.
        if self.text.count('```') % 2 or self.text.count('[') != self.text.count(']'):
            return []
        clean = re.sub(r'```.*?```', '', self.text, flags=re.S)
        clean = re.sub(r'`([^`]*)`', r'\1', clean)
        clean = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', clean)
        clean = re.sub(r'https?://\S+', '', clean)
        clean = re.sub(r'[*#>|_~]+', '', clean)
        clean = re.sub(r'\s+', ' ', clean).strip()
        ready = []
        for match in re.finditer(r'.+?[。！？!?；;]+', clean):
            sentence = match.group().strip()
            # Long sentences follow the existing semantic splitter at commit.
            if not sentence or len(sentence) > 72 or sentence in self.seen:
                continue
            self.seen.add(sentence)
            ready.append(sentence)
            if len(self.seen) >= self.limit:
                break
        return ready
