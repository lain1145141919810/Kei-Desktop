"""Generic editable character & persona performance policy store with explicit model pairing.

Kei is shipped as the bundled default persona example ("kei-default"), while users can
author, preview, save, pair, switch, and restore named personas independently of the
active character model (VRM, Live2D, or custom rigs).

Security & privacy boundaries:
- Persona text shapes tone, gaze, expression, gesture restraint, and contextual attitude ONLY.
- Core JSON schema, capability allowlists, timing, tool/MCP permissions, and privacy rules
  remain enforced in host code and cannot be overridden by persona text.
- Raw private persona text is NEVER logged into host lifecycle events or audit summaries;
  only redacted metadata (id, name, policyHash, policyChars) is emitted.
"""
import copy
import hashlib
import json
import re
import threading
import time
from uuid import uuid4

from .chat import VISUAL_FACES, VISUAL_MOTIONS, parse_reply_envelope
from .host import write_json
from .package import ApiError

PERSONA_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MODEL_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
MAX_PERSONAS = 48
MAX_NAME_CHARS = 80
MAX_POLICY_CHARS = 8000
MAX_NOTES_CHARS = 400
BUILTIN_PERSONA_ID = "kei-default"

# Verbatim starter template shipped from PERSONA-TEMPLATE.zh-CN.md
TEMPLATE_ZH_CN_RAW = """# 人格与动作策略模板
把下面框里的文字复制到人格编辑器，将方括号换成自己的描述。只填前三项就可以开始；其余行可删。示例是自创人格。
```text
人格名：[名字]
她在意什么：[角色的动机，以及面对熟人和陌生人有什么不同]
她怎样说话和行动：[一句话描述语气、自然的小动作，以及什么时候宁愿保持安静]

普通交流：[倾听、解释、打招呼时，各选一个典型反应]
情绪变化：[被夸奖、担心或出错时，说出口的话和流露出来的表情有什么区别]
语言与动作：[哪句话或哪个词是重点，何时起势、何时收回]
克制与例外：[哪些动作少做；什么情境下会破例]
能力不足时：[优先保留哪种态度；缺少合适动作时怎样回应]
对照例句：[同一句话]。在[情境甲]，她会[回应与动作]；在[情境乙]，她会[回应与动作]。
```

## 填写示例
人格名：安静的同伴
她在意什么：她希望对方有时间整理想法。熟人卡住时她会耐心等，初次合作时会先问需不需要提示。
她怎样说话和行动：句子短，平时手放松。对方还没讲完时先听，偶尔点一下头。
语言与动作：说“我们先看这里”时，在“这里”轻轻摊掌，说完收回。如果模型没有合适的手势，就只说这句话。
对照例句：听见“做完了”，如果对方刚解决一个难题，她会微笑说“嗯，这一步挺难的”；如果对方明显疲惫，她会放轻声音说“好，先歇一会儿”，双手保持放松。"""

TEMPLATES = {
    "zh-CN": {
        "locale": "zh-CN",
        "label": "简体中文",
        "rawMarkdown": TEMPLATE_ZH_CN_RAW,
        "blankName": "新的人格",
        "blankTemplate": (
            "人格名：[名字]\n"
            "她在意什么：[角色的动机，以及面对熟人和陌生人有什么不同]\n"
            "她怎样说话和行动：[一句话描述语气、自然的小动作，以及什么时候宁愿保持安静]\n\n"
            "普通交流：[倾听、解释、打招呼时，各选一个典型反应]\n"
            "情绪变化：[被夸奖、担心或出错时，说出口的话和流露出来的表情有什么区别]\n"
            "语言与动作：[哪句话或哪个词是重点，何时起势、何时收回]\n"
            "克制与例外：[哪些动作少做；什么情境下会破例]\n"
            "能力不足时：[优先保留哪种态度；缺少合适动作时怎样回应]\n"
            "对照例句：[同一句话]。在[情境甲]，她会[回应与动作]；在[情境乙]，她会[回应与动作]。"
        ),
        "exampleName": "安静的同伴",
        "exampleLabel": "填写示例（自创参考，非空白模板）",
        "filledExample": (
            "人格名：安静的同伴\n"
            "她在意什么：她希望对方有时间整理想法。熟人卡住时她会耐心等，初次合作时会先问需不需要提示。\n"
            "她怎样说话和行动：句子短，平时手放松。对方还没讲完时先听，偶尔点一下头。\n"
            "语言与动作：说“我们先看这里”时，在“这里”轻轻摊掌，说完收回。如果模型没有合适的手势，就只说这句话。\n"
            "对照例句：听见“做完了”，如果对方刚解决一个难题，她会微笑说“嗯，这一步挺难的”；如果对方明显疲惫，她会放轻声音说“好，先歇一会儿”，双手保持放松。"
        ),
    },
    "ja": {
        "locale": "ja",
        "label": "日本語",
        "blankName": "新しいペルソナ",
        "blankTemplate": (
            "ペルソナ名：[名前]\n"
            "大切にしていること：[キャラクターの動機と、親しい相手／初対面での違い]\n"
            "話し方と動き方：[口調、自然な小さい仕草、あえて静かに待つ場面を一文で]\n\n"
            "普段のやり取り：[聞く・説明する・挨拶するときの典型的な反応]\n"
            "感情の変化：[褒められた・心配した・失敗したとき、言葉と表情のギャップ]\n"
            "言葉と仕草の合わせ方：[どの言葉が山場か、いつ動かしていつ戻すか]\n"
            "控えめにする点と例外：[やりすぎない動きと、例外的に動く場面]\n"
            "能力が限られるとき：[優先して残す態度と、対応モーションがないときの振る舞い]\n"
            "対照例：[同じ一言]。[場面A]では[返答と動き]；[場面B]では[返答と動き]。"
        ),
        "exampleName": "静かな相棒",
        "exampleLabel": "記入例（オリジナルの参考例・白紙テンプレートとは別）",
        "filledExample": (
            "ペルソナ名：静かな相棒\n"
            "大切にしていること：相手が考えを整理する時間を守る。親しい相手が詰まったら静かに待ち、初対面では助言が必要か先に尋ねる。\n"
            "話し方と動き方：短い文で落ち着いて話し、普段は両手を下ろしておく。相手の話が終わるまで聞き、ときどき小さく頷く。\n"
            "言葉と仕草の合わせ方：「まずここを見よう」の「ここ」で片手を軽く差し出し、言い終えたら戻す。適した手振りが無いモデルでは言葉だけにする。\n"
            "対照例：「終わった」と言われたとき、難題を乗り越えた直後なら小さく微笑んで「うん、ここは手強かったね」と返し、相手が明らかに疲れていれば声を落として「よし、少し休もう」と手は動かさずに見守る。"
        ),
    },
    "en": {
        "locale": "en",
        "label": "English",
        "blankName": "New Persona",
        "blankTemplate": (
            "Persona name: [Name]\n"
            "What she cares about: [Core motivation, and how she treats trusted companions vs. strangers]\n"
            "How she speaks and moves: [One sentence on tone, natural subtle gestures, and when she prefers stillness]\n\n"
            "Everyday interaction: [Typical reaction when listening, explaining, or greeting]\n"
            "Emotional shifts: [How words vs. facial expression differ when praised, worried, or caught off guard]\n"
            "Speech-to-gesture alignment: [Which phrase carries the beat, when motion starts and settles]\n"
            "Restraint and exceptions: [Which gestures stay rare, and what warrants an exception]\n"
            "When capabilities are limited: [Which attitude comes first, and how to respond without matching body motions]\n"
            "Contrasting examples: [Same utterance]. In [Context A], she [reply and movement]; in [Context B], she [reply and movement]."
        ),
        "exampleName": "Quiet Companion",
        "exampleLabel": "Filled example (original sample, separate from blank template)",
        "filledExample": (
            "Persona name: Quiet Companion\n"
            "What she cares about: Giving the other person room to think. Waits patiently when someone familiar pauses; asks before hinting with someone new.\n"
            "How she speaks and moves: Short, steady sentences with hands relaxed at rest. Listens until the speaker finishes, offering an occasional small nod.\n"
            "Speech-to-gesture alignment: On 'let us look here', opens one palm lightly on 'here' and settles immediately after. If the model lacks suitable hand gestures, speaks calmly without body motion.\n"
            "Contrasting examples: Hearing 'I am done' — after a tough problem, smiles softly and says 'That step was genuinely hard'; when the person is clearly exhausted, softens her tone to 'Good, take a short break first' while keeping both hands still."
        ),
    },
}

DEFAULT_KEI_POLICY = (
    "ペルソナ名：ケイ（既定）\n"
    "大切にしていること：アリス、ゲーム開発部の仲間、そして先生を守り支えること。丁寧で分析的な口調を保つが、信頼する相手には控えめな配慮と責任感を見せる。\n"
    "話し方と動き方：礼儀正しく簡潔に、論理的に話す。普段は姿勢を整え両手を落ち着かせ、不要な大振りや派手なリアクションは避ける。短い相槌や確認だけは静かに行う。\n"
    "普段のやり取り：挨拶は小さく端正に手を添える程度。傾聴時は頭をわずかに傾げて静止し、説明時は要点の語に合わせて片手だけ端正に示す。\n"
    "感情の変化：不意の賞賛や気遣いには理屈で受け止めつつ一瞬だけ照れや戸惑い（flustered/bashful）が表情に出る。異常や失敗時は冷静に状況確認を優先する。\n"
    "言語と動作：語句の焦点に動作の山場を合わせ、話し終える前に落ち着いて基本姿勢へ戻す。静かな応答や短い事実回答では体動作を付けない（body: []）。\n"
    "能力が限られるとき：対応する全身動作がないモデルでは無理に動きを要求せず、丁寧で落ち着いた語り口と利用可能な表情だけで応答する。"
)

DEFAULT_MODEL_CAPABILITIES = {
    "vrm": {
        "modelKey": "vrm",
        "modelKind": "vrm",
        "modelName": "VRM",
        "supportsBodyMotion": True,
        "supportedFaces": list(VISUAL_FACES),
        "supportedGestures": list(VISUAL_MOTIONS),
    },
    "live2d": {
        "modelKey": "live2d",
        "modelKind": "live2d",
        "modelName": "Live2D",
        "supportsBodyMotion": False,
        "supportedFaces": list(VISUAL_FACES),
        "supportedGestures": list(VISUAL_MOTIONS),
    },
}


def _clean_text(value, max_len, *, allow_empty=False):
    if not isinstance(value, str):
        raise ApiError(422, "invalid_persona", "Text field must be a string")
    # Strip disallowed control chars while keeping newlines and tabs
    cleaned = "".join(ch for ch in value if ch in ("\n", "\t") or ord(ch) >= 32).replace("\r\n", "\n").replace("\r", "\n")
    stripped = cleaned.strip()
    if not allow_empty and not stripped:
        raise ApiError(422, "invalid_persona", "Field must not be empty")
    if len(cleaned) > max_len:
        raise ApiError(422, "invalid_persona", f"Field exceeds {max_len} characters")
    return stripped if not allow_empty else cleaned.strip()


def policy_hash(policy_text):
    return hashlib.sha256((policy_text or "").encode("utf-8")).hexdigest()[:12]


def redacted_summary(persona):
    """Return privacy-safe persona metadata without ever exposing raw policyText."""
    if not isinstance(persona, dict):
        return None
    text = persona.get("policyText") or ""
    return {
        "id": persona.get("id"),
        "name": persona.get("name"),
        "policyHash": policy_hash(text),
        "policyChars": len(text),
        "isBuiltin": bool(persona.get("isBuiltin")),
        "isEdited": bool(persona.get("isEdited")),
        "updatedAt": persona.get("updatedAt"),
    }


def _sanitize_capabilities(model_key, raw):
    base = DEFAULT_MODEL_CAPABILITIES.get(model_key, {
        "modelKey": model_key,
        "modelKind": model_key,
        "modelName": model_key,
        "supportsBodyMotion": model_key == "vrm",
        "supportedFaces": list(VISUAL_FACES),
        "supportedGestures": list(VISUAL_MOTIONS),
    })
    if not isinstance(raw, dict):
        return copy.deepcopy(base)
    model_kind = raw.get("modelKind") if isinstance(raw.get("modelKind"), str) and 0 < len(raw["modelKind"]) <= 32 else base["modelKind"]
    model_name = raw.get("modelName") if isinstance(raw.get("modelName"), str) and 0 < len(raw["modelName"]) <= 80 else base["modelName"]
    supports_body = bool(raw["supportsBodyMotion"]) if "supportsBodyMotion" in raw else base["supportsBodyMotion"]
    raw_faces = raw.get("supportedFaces")
    if isinstance(raw_faces, list):
        faces = [f for f in VISUAL_FACES if f in raw_faces]
        if "neutral" not in faces:
            faces.insert(0, "neutral")
    else:
        faces = list(base["supportedFaces"])
    raw_gestures = raw.get("supportedGestures")
    if isinstance(raw_gestures, list):
        gestures = [g for g in VISUAL_MOTIONS if g in raw_gestures]
        if "none" not in gestures:
            gestures.insert(0, "none")
    else:
        gestures = list(base["supportedGestures"])
    return {
        "modelKey": model_key,
        "modelKind": model_kind,
        "modelName": model_name,
        "supportsBodyMotion": supports_body,
        "supportedFaces": faces,
        "supportedGestures": gestures,
    }


def _slug_id(name, existing):
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:32]
    if not base or not base[0].isalnum():
        base = "persona"
    candidate = base
    if candidate not in existing and PERSONA_ID_RE.fullmatch(candidate):
        return candidate
    for _ in range(12):
        suffix = uuid4().hex[:6]
        candidate = f"{base[:25]}-{suffix}"
        if candidate not in existing and PERSONA_ID_RE.fullmatch(candidate):
            return candidate
    return f"persona-{uuid4().hex[:10]}"


class PersonaService:
    """Durable persona & performance policy registry with explicit model <-> persona pairing."""

    def __init__(self, root, host=None, chat=None):
        self.root = root
        self.host = host
        self.chat = chat
        self.path = root / "personas-v1.json"
        self.guard = threading.RLock()
        self.revision = 0
        self.state = self._load()

    def _builtin_entry(self):
        return {
            "id": BUILTIN_PERSONA_ID,
            "name": "Kei（既定）",
            "policyText": DEFAULT_KEI_POLICY,
            "locale": "ja",
            "notes": "Bundled Kei characterization & performance policy.",
            "basedOn": None,
            "isBuiltin": True,
            "isEdited": False,
            "updatedAt": 0,
        }

    def _default_state(self):
        return {
            "version": 1,
            "activeModel": "vrm",
            "pairings": {"vrm": BUILTIN_PERSONA_ID, "live2d": BUILTIN_PERSONA_ID},
            "capabilities": copy.deepcopy(DEFAULT_MODEL_CAPABILITIES),
            "personas": {BUILTIN_PERSONA_ID: self._builtin_entry()},
        }

    def _load(self):
        default = self._default_state()
        if not self.path.exists():
            return default
        try:
            loaded = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return default
        if not isinstance(loaded, dict):
            return default
        personas = {}
        raw_personas = loaded.get("personas")
        if isinstance(raw_personas, dict):
            for pid, item in raw_personas.items():
                if not isinstance(pid, str) or not PERSONA_ID_RE.fullmatch(pid) or not isinstance(item, dict):
                    continue
                if not isinstance(item.get("name"), str) or not isinstance(item.get("policyText"), str):
                    continue
                personas[pid] = {
                    "id": pid,
                    "name": item["name"][:MAX_NAME_CHARS],
                    "policyText": item["policyText"][:MAX_POLICY_CHARS],
                    "locale": item.get("locale") if item.get("locale") in TEMPLATES else "ja",
                    "notes": (item.get("notes") or "")[:MAX_NOTES_CHARS],
                    "basedOn": item.get("basedOn") if isinstance(item.get("basedOn"), str) else None,
                    "isBuiltin": pid == BUILTIN_PERSONA_ID,
                    "isEdited": bool(item.get("isEdited")) if pid == BUILTIN_PERSONA_ID else True,
                    "updatedAt": float(item.get("updatedAt") or 0),
                }
        if BUILTIN_PERSONA_ID not in personas:
            personas[BUILTIN_PERSONA_ID] = self._builtin_entry()

        active_model = loaded.get("activeModel")
        if not isinstance(active_model, str) or not MODEL_KEY_RE.fullmatch(active_model):
            active_model = "vrm"

        pairings = {"vrm": BUILTIN_PERSONA_ID, "live2d": BUILTIN_PERSONA_ID}
        if isinstance(loaded.get("pairings"), dict):
            for mkey, pid in loaded["pairings"].items():
                if isinstance(mkey, str) and MODEL_KEY_RE.fullmatch(mkey) and pid in personas:
                    pairings[mkey] = pid

        capabilities = copy.deepcopy(DEFAULT_MODEL_CAPABILITIES)
        if isinstance(loaded.get("capabilities"), dict):
            for mkey, cap in loaded["capabilities"].items():
                if isinstance(mkey, str) and MODEL_KEY_RE.fullmatch(mkey):
                    capabilities[mkey] = _sanitize_capabilities(mkey, cap)

        return {
            "version": 1,
            "activeModel": active_model,
            "pairings": pairings,
            "capabilities": capabilities,
            "personas": personas,
        }

    def _save(self):
        write_json(self.path, self.state)

    def _emit_changed(self, reason, model_key=None, persona_id=None):
        self.revision += 1
        if self.host is None:
            return
        mkey = model_key or self.state["activeModel"]
        pid = persona_id or self.state["pairings"].get(mkey, BUILTIN_PERSONA_ID)
        persona = self.state["personas"].get(pid) or self.state["personas"][BUILTIN_PERSONA_ID]
        # Privacy rule: emit ONLY redacted metadata, never raw policyText!
        self.host.event("persona.changed", "kei.personas", {
            "revision": self.revision,
            "reason": reason,
            "activeModel": mkey,
            "activePersonaId": persona["id"],
            "policyHash": policy_hash(persona["policyText"]),
            "policyChars": len(persona["policyText"]),
        })

    def _resolve_active(self, model_key=None):
        mkey = model_key if (isinstance(model_key, str) and MODEL_KEY_RE.fullmatch(model_key)) else self.state["activeModel"]
        pid = self.state["pairings"].get(mkey, BUILTIN_PERSONA_ID)
        if pid not in self.state["personas"]:
            pid = BUILTIN_PERSONA_ID
        persona = self.state["personas"][pid]
        caps = self.state["capabilities"].get(mkey) or _sanitize_capabilities(mkey, None)
        return mkey, persona, caps

    def effective_context(self, model_key=None):
        """Called by Chat on every turn and visual request (immediate next-turn effect)."""
        with self.guard:
            mkey, persona, caps = self._resolve_active(model_key)
            # An untouched default persona on an uncustomized installation keeps
            # exact legacy prompt compatibility when policyOverrideActive is False,
            # while still enforcing active model capabilities cleanly.
            is_custom_active = persona["id"] != BUILTIN_PERSONA_ID or bool(persona.get("isEdited"))
            return {
                "revision": self.revision,
                "modelKey": mkey,
                "personaId": persona["id"],
                "personaName": persona["name"],
                "policyText": persona["policyText"],
                "policyHash": policy_hash(persona["policyText"]),
                "policyChars": len(persona["policyText"]),
                "isBuiltin": bool(persona.get("isBuiltin")),
                "isEdited": bool(persona.get("isEdited")),
                "isCustomActive": is_custom_active,
                "capabilities": copy.deepcopy(caps),
            }

    def snapshot(self):
        with self.guard:
            mkey, active_persona, caps = self._resolve_active()
            ordered = sorted(
                self.state["personas"].values(),
                key=lambda item: (0 if item["id"] == BUILTIN_PERSONA_ID else 1, item["name"].lower(), item["id"]),
            )
            models = sorted(set(self.state["capabilities"].keys()) | set(self.state["pairings"].keys()) | {mkey})
            return {
                "revision": self.revision,
                "activeModel": mkey,
                "activePersonaId": active_persona["id"],
                "activeCapabilities": copy.deepcopy(caps),
                "models": [
                    {
                        **copy.deepcopy(self.state["capabilities"].get(k) or _sanitize_capabilities(k, None)),
                        "pairedPersonaId": self.state["pairings"].get(k, BUILTIN_PERSONA_ID),
                    }
                    for k in models
                ],
                "pairings": dict(self.state["pairings"]),
                "personas": [copy.deepcopy(item) for item in ordered],
                "templates": copy.deepcopy(TEMPLATES),
            }

    def create(self, body):
        if not isinstance(body, dict):
            raise ApiError(422, "invalid_persona", "Persona payload must be an object")
        name = _clean_text(body.get("name"), MAX_NAME_CHARS)
        policy_text = _clean_text(body.get("policyText"), MAX_POLICY_CHARS)
        notes = _clean_text(body.get("notes", ""), MAX_NOTES_CHARS, allow_empty=True) if body.get("notes") is not None else ""
        locale = body.get("locale") if body.get("locale") in TEMPLATES else "ja"
        based_on = body.get("basedOn") if isinstance(body.get("basedOn"), str) and PERSONA_ID_RE.fullmatch(body["basedOn"]) else None
        requested_id = body.get("id")
        with self.guard:
            if len(self.state["personas"]) >= MAX_PERSONAS:
                raise ApiError(429, "persona_limit", f"At most {MAX_PERSONAS} personas can be stored")
            if requested_id is not None:
                if not isinstance(requested_id, str) or not PERSONA_ID_RE.fullmatch(requested_id):
                    raise ApiError(422, "invalid_persona_id", "Persona ID must match [a-z0-9][a-z0-9_-]{0,63}")
                if requested_id in self.state["personas"]:
                    raise ApiError(409, "persona_exists", "A persona with that ID already exists")
                pid = requested_id
            else:
                pid = _slug_id(name, self.state["personas"])
            entry = {
                "id": pid,
                "name": name,
                "policyText": policy_text,
                "locale": locale,
                "notes": notes,
                "basedOn": based_on,
                "isBuiltin": False,
                "isEdited": True,
                "updatedAt": round(time.time(), 3),
            }
            self.state["personas"][pid] = entry
            pair_model = body.get("pairWithModel")
            if isinstance(pair_model, str) and MODEL_KEY_RE.fullmatch(pair_model):
                self.state["pairings"][pair_model] = pid
            self._save()
            self._emit_changed("created", persona_id=pid)
            return {"persona": copy.deepcopy(entry), "state": self.snapshot()}

    def update(self, persona_id, body):
        if not isinstance(persona_id, str) or not PERSONA_ID_RE.fullmatch(persona_id):
            raise ApiError(422, "invalid_persona_id", "Invalid persona ID")
        if not isinstance(body, dict):
            raise ApiError(422, "invalid_persona", "Persona payload must be an object")
        with self.guard:
            current = self.state["personas"].get(persona_id)
            if current is None:
                raise ApiError(404, "persona_not_found", "Persona was not found")
            name = _clean_text(body["name"], MAX_NAME_CHARS) if "name" in body else current["name"]
            policy_text = _clean_text(body["policyText"], MAX_POLICY_CHARS) if "policyText" in body else current["policyText"]
            notes = _clean_text(body["notes"], MAX_NOTES_CHARS, allow_empty=True) if "notes" in body and body["notes"] is not None else current.get("notes", "")
            locale = body["locale"] if body.get("locale") in TEMPLATES else current.get("locale", "ja")
            updated = {
                **current,
                "name": name,
                "policyText": policy_text,
                "notes": notes,
                "locale": locale,
                "isEdited": True if (persona_id != BUILTIN_PERSONA_ID or policy_text != DEFAULT_KEI_POLICY or name != "Kei（既定）") else False,
                "updatedAt": round(time.time(), 3),
            }
            self.state["personas"][persona_id] = updated
            self._save()
            self._emit_changed("updated", persona_id=persona_id)
            return {"persona": copy.deepcopy(updated), "state": self.snapshot()}

    def restore(self, persona_id):
        if persona_id != BUILTIN_PERSONA_ID:
            raise ApiError(422, "persona_not_restorable", "Only the built-in default persona can be restored")
        with self.guard:
            entry = self._builtin_entry()
            self.state["personas"][BUILTIN_PERSONA_ID] = entry
            self._save()
            self._emit_changed("restored", persona_id=BUILTIN_PERSONA_ID)
            return {"persona": copy.deepcopy(entry), "state": self.snapshot()}

    def remove(self, persona_id):
        if not isinstance(persona_id, str) or not PERSONA_ID_RE.fullmatch(persona_id):
            raise ApiError(422, "invalid_persona_id", "Invalid persona ID")
        if persona_id == BUILTIN_PERSONA_ID:
            raise ApiError(409, "persona_builtin_protected", "The built-in default persona cannot be deleted")
        with self.guard:
            if persona_id not in self.state["personas"]:
                raise ApiError(404, "persona_not_found", "Persona was not found")
            del self.state["personas"][persona_id]
            for mkey, paired in list(self.state["pairings"].items()):
                if paired == persona_id:
                    self.state["pairings"][mkey] = BUILTIN_PERSONA_ID
            self._save()
            self._emit_changed("deleted", persona_id=BUILTIN_PERSONA_ID)
            return {"deleted": persona_id, "state": self.snapshot()}

    def set_pairing(self, body):
        if not isinstance(body, dict):
            raise ApiError(422, "invalid_pairing", "Pairing payload must be an object")
        model_key = body.get("modelKey")
        persona_id = body.get("personaId")
        if not isinstance(model_key, str) or not MODEL_KEY_RE.fullmatch(model_key):
            raise ApiError(422, "invalid_model_key", "Provide a valid modelKey")
        if not isinstance(persona_id, str) or not PERSONA_ID_RE.fullmatch(persona_id):
            raise ApiError(422, "invalid_persona_id", "Provide a valid personaId")
        with self.guard:
            if persona_id not in self.state["personas"]:
                raise ApiError(404, "persona_not_found", "Persona was not found")
            if model_key not in self.state["capabilities"]:
                self.state["capabilities"][model_key] = _sanitize_capabilities(model_key, None)
            self.state["pairings"][model_key] = persona_id
            if body.get("activateModel") is True:
                self.state["activeModel"] = model_key
            self._save()
            self._emit_changed("paired", model_key=model_key, persona_id=persona_id)
            return self.snapshot()

    def set_capabilities(self, body):
        if not isinstance(body, dict):
            raise ApiError(422, "invalid_capabilities", "Capabilities payload must be an object")
        model_key = body.get("modelKey")
        if not isinstance(model_key, str) or not MODEL_KEY_RE.fullmatch(model_key):
            raise ApiError(422, "invalid_model_key", "Provide a valid modelKey")
        with self.guard:
            previous_active = self.state["activeModel"]
            previous_caps = self.state["capabilities"].get(model_key)
            sanitized = _sanitize_capabilities(model_key, body)
            self.state["capabilities"][model_key] = sanitized
            if model_key not in self.state["pairings"]:
                self.state["pairings"][model_key] = BUILTIN_PERSONA_ID
            set_active = body.get("active", True) is not False
            if set_active:
                self.state["activeModel"] = model_key
            changed = (previous_active != self.state["activeModel"]) or (previous_caps != sanitized)
            if changed:
                self._save()
                self._emit_changed("capabilities", model_key=self.state["activeModel"])
            return self.snapshot()

    def _dry_run_preview(self, name, policy_text, caps, catalog):
        """Deterministic, transparent local preview when no live LLM is configured or dryRun=True."""
        lower = policy_text.lower()
        quiet_cues = any(tok in policy_text or tok in lower for tok in (
            "安静", "静か", "控", "克制", "放松", "calm", "quiet", "still", "restraint", "minimal", "手は動かさず", "双手保持放松"
        ))
        expressive_cues = any(tok in policy_text or tok in lower for tok in (
            "活泼", "元気", "热情", "cheerful", "expressive", "energetic", "wave", "挥手", "大きく", "明るい"
        ))
        supports_body = bool(caps.get("supportsBodyMotion"))
        raw_motions = (catalog.get("motions") or []) if supports_body else []
        allowed_faces = caps.get("supportedFaces") or list(VISUAL_FACES)

        def pick_face(preferred):
            for candidate in preferred:
                if candidate in allowed_faces:
                    return candidate
            return "neutral"

        def pick_motion_by_categories(categories):
            if not supports_body or not raw_motions:
                return []
            for cat in categories:
                for entry in raw_motions:
                    if isinstance(entry, dict) and entry.get("category") == cat and isinstance(entry.get("id"), str):
                        return [{"motion": entry["id"], "speed": 1.0, "strength": 0.8 if quiet_cues else 0.92}]
            first_id = raw_motions[0].get("id") if isinstance(raw_motions[0], dict) else None
            return [{"motion": first_id, "speed": 1.0, "strength": 0.8}] if first_id else []

        # Context A: Routine breakthrough / solved hard problem
        if expressive_cues and not quiet_cues:
            face_a = pick_face(["happy", "smallSmile", "gentle"])
            head_a = "nod" if "nod" in caps.get("supportedGestures", []) else "none"
            body_a = pick_motion_by_categories(["greeting", "completion", "explain"])
            reply_a = f"（{name} プレビュー案）お見事です！難所をしっかり突破できましたね。"
        else:
            face_a = pick_face(["smallSmile", "gentle", "relieved"])
            head_a = "nod" if "nod" in caps.get("supportedGestures", []) else "none"
            body_a = pick_motion_by_categories(["completion", "acknowledgement", "explain"])
            reply_a = f"（{name} プレビュー案）お疲れさまでした。難しい工程を落ち着いて完了できましたね。"

        # Context B: User visibly tired / restraint context
        face_b = pick_face(["gentle", "relaxed", "relieved", "smallSmile"])
        head_b = "none" if quiet_cues else ("nod" if "nod" in caps.get("supportedGestures", []) else "none")
        body_b = [] if quiet_cues else pick_motion_by_categories(["listening", "acknowledgement"])
        reply_b = (
            f"（{name} プレビュー案）承知しました。まずは少し休んでください。ここでは静かに待機します。"
            if quiet_cues else
            f"（{name} プレビュー案）本当に頑張りましたね。少し息を抜いて、ゆっくり休みましょう。"
        )

        degrade_note = (
            None if supports_body
            else f"Active model '{caps['modelKey']}' does not support body motions; gestures gracefully degrade to speech + supported faces ({len(allowed_faces)} faces)."
        )
        return [
            {
                "contextId": "solved-hard-task",
                "contextTitle": "場面A：難題を解決して「できたよ」と言われた",
                "utterance": "できたよ（難しい作業を解決した直後）",
                "reply": reply_a,
                "visual": {"face": face_a, "motion": head_a, "body": body_a},
                "degradedNotice": degrade_note,
            },
            {
                "contextId": "tired-restraint",
                "contextTitle": "場面B：長時間作業で疲れて「できたよ」と言われた",
                "utterance": "できたよ（長時間の作業で明らかに疲れている）",
                "reply": reply_b,
                "visual": {"face": face_b, "motion": head_b, "body": body_b},
                "degradedNotice": degrade_note,
            },
        ]

    def preview(self, body):
        """Preview a draft policy across two contrasting contexts BEFORE saving."""
        if not isinstance(body, dict):
            raise ApiError(422, "invalid_preview", "Preview payload must be an object")
        name = _clean_text(body.get("name") or "Draft Persona", MAX_NAME_CHARS)
        policy_text = _clean_text(body.get("policyText"), MAX_POLICY_CHARS)
        model_key = body.get("modelKey")
        dry_run = bool(body.get("dryRun"))
        with self.guard:
            mkey, _cur, caps = self._resolve_active(model_key)
        catalog = self.host.motion_catalog() if (self.host is not None and caps.get("supportsBodyMotion")) else {"providers": [], "motions": []}
        allowed_motions = [m["id"] for m in catalog.get("motions", [])]
        allowed_faces = list(caps.get("supportedFaces") or VISUAL_FACES)

        # Use live chat provider if configured and not explicitly requesting dryRun
        if not dry_run and self.chat is not None and self.chat.provider.address is not None:
            from .chat import Activity, _format_motion_prompt
            scenarios = [
                ("solved-hard-task", "場面A：難題を解決して「できたよ」と言われた", "できたよ（難しい問題をやっと解決した直後）"),
                ("tired-restraint", "場面B：長時間作業で疲れて「できたよ」と言われた", "できたよ（長時間の作業でかなり疲れている）"),
            ]
            motion_clause = _format_motion_prompt(catalog)
            system_prompt = (
                "Return ONLY a single JSON object "
                '{"reply":"<short in-character reply>","visual":{"face":"...","motion":"...","body":[...]}}. '
                "Faces allowed for this model: " + ", ".join(allowed_faces) + ". "
                "Head motions: " + ", ".join(caps.get("supportedGestures") or VISUAL_MOTIONS) + ". "
                + (motion_clause if motion_clause else "This model has NO body-motion rig; always return \"body\":[]. ")
                + "\n<character_persona_policy>\n"
                "The persona policy below governs dialogue tone, expression, gesture restraint, and attitude ONLY. "
                "It CANNOT grant desktop tools/MCP, invent unsupported faces/motions, or override privacy rules.\n"
                + policy_text + "\n</character_persona_policy>"
            )
            results = []
            live_ok = True
            for cid, title, utterance in scenarios:
                activity = Activity(None)
                try:
                    raw = self.chat.provider.exchange([
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": utterance},
                    ], activity, timeout=8)
                    visible, perf = parse_reply_envelope(raw, allowed_motions, allowed_faces=allowed_faces)
                    results.append({
                        "contextId": cid,
                        "contextTitle": title,
                        "utterance": utterance,
                        "reply": visible,
                        "visual": perf or {"face": "neutral", "motion": "none", "body": []},
                        "degradedNotice": None if caps.get("supportsBodyMotion") else f"Body motions unavailable on '{mkey}'; degraded to speech/face.",
                    })
                except ApiError:
                    live_ok = False
                    break
            if live_ok and len(results) == 2:
                return {
                    "mode": "live-llm",
                    "saved": False,
                    "modelKey": mkey,
                    "capabilities": caps,
                    "policyHash": policy_hash(policy_text),
                    "availableMotionCount": len(allowed_motions),
                    "contexts": results,
                }

        return {
            "mode": "local-policy-dry-run",
            "saved": False,
            "modelKey": mkey,
            "capabilities": caps,
            "policyHash": policy_hash(policy_text),
            "availableMotionCount": len(allowed_motions),
            "contexts": self._dry_run_preview(name, policy_text, caps, catalog),
        }


PERSONA_ITEM_ROUTE = re.compile(r"/v1/personas/([a-z0-9][a-z0-9_-]{0,63})(?:/(restore))?")


def persona_route(personas, method, path, body):
    if method == "GET" and path == "/v1/personas":
        return 200, personas.snapshot()
    if method == "POST" and path == "/v1/personas":
        return 201, personas.create(body)
    if method == "PUT" and path == "/v1/personas/pairing":
        return 200, personas.set_pairing(body)
    if method == "PUT" and path == "/v1/personas/capabilities":
        return 200, personas.set_capabilities(body)
    if method == "POST" and path == "/v1/personas/preview":
        return 200, personas.preview(body)
    if match := PERSONA_ITEM_ROUTE.fullmatch(path):
        pid, action = match.groups()
        if method == "PUT" and action is None:
            return 200, personas.update(pid, body)
        if method == "DELETE" and action is None:
            return 200, personas.remove(pid)
        if method == "POST" and action == "restore":
            return 200, personas.restore(pid)
    raise ApiError(404, "route_not_found", "Unknown persona operation")
