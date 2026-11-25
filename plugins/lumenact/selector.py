"""Local RBT3 classification and matching against the authored clip catalog."""
import json

from catalog import pinned_file


class Selector:
    def __init__(self, root):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        config_file = pinned_file(root, "models/semantic/config.json")
        model = pinned_file(root, "models/semantic/selector.onnx")
        tokenizer = pinned_file(root, "models/semantic/tokenizer/tokenizer.json")
        self.config = json.loads(config_file.read_text("utf-8"))
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.tokenizer.enable_truncation(max_length=self.config["max_length"])
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        self.np = np

    def predict(self, intent, text):
        encoded = self.tokenizer.encode(intent, text or None)
        fields = {"input_ids": encoded.ids, "attention_mask": encoded.attention_mask, "token_type_ids": encoded.type_ids}
        feeds = {item.name: self.np.asarray([fields[item.name]], dtype=self.np.int64)
                 for item in self.session.get_inputs()}
        labels, contexts, *_ = self.session.run(None, feeds)
        label_logits = labels[0].astype("float64")
        index = int(label_logits.argmax())
        probabilities = self.np.exp(label_logits - label_logits.max())
        catalog = self.config["catalog"]
        label = catalog["labels"][index]
        context_index = int(contexts[0].argmax())
        context = catalog["contexts"][context_index - 1] if context_index else {}
        return {
            "selector": "onnx", "model": self.config["name"], "label": label,
            "confidence": float(probabilities[index] / probabilities.sum()),
            "contextId": context["context_id"] if context.get("label") == label else "auto",
        }
