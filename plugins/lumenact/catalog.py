"""Read and map the public little-endian lumenact.curves.v1 format."""
import hashlib
import json
import math
import re
import struct
from pathlib import Path

FORMAT = "lumenact.curves.v1"
SOURCE_REVISION = "7585447a131b51e12962cac829e14e3a9f9c00f3"
ASSET_REVISION = "df8126a2a854735227ec81b7f12ab62d49a6d989"
PINNED = {
    "models/expression/catalog.json": (52304, "e8eb061eb8507f4c8047b3ba6dea4e22645d349ddb685b5590e7e65548ff45e5"),
    "models/expression/curves.f32": (13495800, "b75515de64a1b9195985353b5a55e36eaf4d32dcb58fc32548ff570e205f9cb9"),
    "models/semantic/config.json": (19493, "129a21372e14b556797d90b6ef0dd00af5bf2c565db1fde653423131ffc87772"),
    "models/semantic/selector.onnx": (153300336, "b4d53610dc6b95e9f994a371dcc2cd8c24777e28ae56c3720d9d6eebeb1688f2"),
    "models/semantic/tokenizer/tokenizer.json": (439124, "7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839"),
}
RESERVED = {"neutral", "aa", "ih", "ou", "ee", "oh", "blink", "blinkleft", "blinkright",
            "lookleft", "lookright", "lookup", "lookdown"}
TARGET_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,47}")
MAX_FRAMES = 1800
DEFAULT_MAPPING = {
    "happy": ["mouth_smile_1", "mouth_smile_2", "eye_smile", "eye_cool_L", "eye_cool_R"],
    "surprised": ["eye_surprised", "eye_surprised_L", "eye_surprised_R", "eyeshighlight_move_L", "eyeshighlight_move_R"],
    "sad": ["eye_small_L", "eye_small_R", "eyebrow_angry_L", "eyebrow_angry_R", "mouth_short"],
    "angry": ["eye_angry", "mouth_angry_1", "mouth_angry_2", "eyebrow_angry_L", "eyebrow_angry_R"],
    "relaxed": ["mouth_smile_1", "eye_cool_L", "eye_cool_R"],
}
FAMILIES = {
    "happy": "卖萌和蔼安详 大眼微笑 微笑 微笑_闭眼 挑眉逗趣 星星眼 欣慰宽慰 爱心眼 骄傲自豪 害羞",
    "surprised": "头晕目眩 小眼震惊 惊讶震惊 震惊疑惑质问 尴尬",
    "sad": "担忧担心 痛苦疼痛 进入陌生环境担忧左顾右盼 道歉抱歉 难过流泪",
    "angry": "厌烦厌恶 意志坚定 生气愤怒",
    "relaxed": "思考专注 感觉无聊无趣 睡眼朦胧敷衍 自然放松",
}
LABEL_TARGET = {label: target for target, labels in FAMILIES.items() for label in labels.split()}

def pinned_file(root, name):
    path = root / name
    size, digest = PINNED[name]
    if not path.is_file() or path.stat().st_size != size:
        raise ValueError("asset_missing")
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != digest:
        raise ValueError("asset_integrity")
    return path


def mapping_from(value):
    value = value or DEFAULT_MAPPING
    if not isinstance(value, dict) or not 1 <= len(value) <= 12:
        raise ValueError("mapping_invalid")
    result = {}
    for target, source in value.items():
        if not TARGET_NAME.fullmatch(target) or target.lower() in RESERVED:
            raise ValueError("mapping_reserved")
        if not isinstance(source, list) or not 1 <= len(source) <= 8 or any(
            not isinstance(item, str) or not item or len(item) > 80 for item in source
        ):
            raise ValueError("mapping_invalid")
        result[target] = tuple(source)
    return result


class Curves:
    def __init__(self, directory, pinned_root=None):
        if pinned_root is None:
            config, data = directory / "catalog.json", directory / "curves.f32"
        else:
            config = pinned_file(pinned_root, "models/expression/catalog.json")
            data = pinned_file(pinned_root, "models/expression/curves.f32")
        catalog = json.loads(config.read_text("utf-8"))
        self.fps = catalog["fps"]
        self.width = catalog["channel_count"]
        self.bytes = data.read_bytes()
        if (catalog["schema"] != FORMAT or catalog["curves"] != "curves.f32"
            or type(self.fps) not in (int, float) or not 1 <= self.fps <= 120
            or type(self.width) is not int or not 1 <= self.width <= 256
            or len(self.bytes) % (self.width * 4)):
            raise ValueError("curve_format")
        self.channels = {}
        for channel in catalog["channels"]:
            name, index = channel["property"], channel["index"]
            if channel["kind"] == "blendshape" and name.startswith("blendShape."):
                if type(index) is not int or not 0 <= index < self.width:
                    raise ValueError("curve_channel")
                key = name.removeprefix("blendShape.")
                if key in self.channels:
                    raise ValueError("curve_channel")
                self.channels[key] = index
        self.styles = {}
        for style in catalog["styles"]:
            ident, offset, frames = str(style["id"]), style["offset"], style["frames"]
            if (ident in self.styles or type(offset) is not int or offset < 0 or type(frames) is not int
                or not 2 <= frames <= MAX_FRAMES or (offset + frames) * self.width * 4 > len(self.bytes)):
                raise ValueError("curve_span")
            self.styles[ident] = style

    def find(self, label, context_id):
        same = [style for style in self.styles.values() if style["label"] == label]
        return next((style for style in same if style["context_id"] == context_id), same[0] if same else None)

    def clip(self, style, mapping, intensity):
        targets = []
        series = []
        unmapped = []
        for name, aliases in mapping.items():
            indices = [self.channels[alias] for alias in aliases if alias in self.channels]
            if not indices:
                unmapped.append(name)
                continue
            values = []
            for frame in range(style["offset"], style["offset"] + style["frames"]):
                samples = [struct.unpack_from("<f", self.bytes, (frame * self.width + ix) * 4)[0] for ix in indices]
                if not all(math.isfinite(value) for value in samples):
                    raise ValueError("curve_nonfinite")
                normalized = [min(1, max(0, value / 100)) for value in samples]
                values.append(round(sum(normalized) / len(normalized) * intensity, 5))
            if any(values):
                targets.append(name)
                series.append(values)
        return {
            "format": "kei.expression.clip.v1", "clipId": str(style["id"]), "label": style["label"],
            "fps": self.fps, "frames": style["frames"], "targets": targets, "tracks": series,
            "unmapped": unmapped,
        }
