"""Operator-defined DSH routes. Task inputs may reference aliases, never endpoints or secrets."""
import re
from urllib.parse import urlsplit

DEFAULTS = {alias:{"label":label, "provider":"deepseek-official","model":"deepseek-v4-"+alias}
            for alias,label in (("flash","DeepSeek Flash"),("pro","DeepSeek Pro"))}


def catalog(config):
    models = dict(DEFAULTS)
    providers = config.get("dsh_providers", {})
    entries=config.get("dsh_models",{})
    if not isinstance(entries,dict) or not isinstance(providers,dict):
        raise ValueError("Expected dictionaries for dsh_models and dsh_providers")
    for alias, entry in entries.items():
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}",alias) or alias in (*DEFAULTS,"work","review"):
            raise ValueError("Invalid or reserved DSH model alias: "+alias)
        if not isinstance(entry,dict) or not all(isinstance(entry.get(k),str) and entry[k].strip() for k in ("provider","model","label")):
            raise ValueError("Expected provider, model and label for "+alias)
        if set(entry)-{"provider","model","label","enabled"} or not isinstance(entry.get("enabled",True),bool):
            raise ValueError("Invalid model settings for "+alias)
        if entry["provider"] != "deepseek-official" and entry["provider"] not in providers:
            raise ValueError("Missing provider for "+alias)
        if entry.get("enabled",True):
            models[alias] = {k:entry[k] for k in ("provider","model","label")}
    return models


def adapter_nodes(config, aliases):
    models = catalog(config)
    grouped = {}
    for alias in aliases:
        entry=models[alias]
        provider=entry["provider"]
        if provider=="deepseek-official":
            continue
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}",provider):
            raise ValueError("Invalid provider identifier")
        spec=config["dsh_providers"][provider]
        if not isinstance(spec,dict) or set(spec)-{"api","baseURL","apiKeyEnv"}:
            raise ValueError("Unsupported provider configuration; store credentials in the environment")
        opts=dict(spec)
        if not all(isinstance(v,str) and v.strip() for v in opts.values()):
            raise ValueError("Provider settings must be non-empty strings")
        if "apiKeyEnv" in opts and not re.fullmatch(r"[A-Z_][A-Z0-9_]*",opts["apiKeyEnv"]):
            raise ValueError("Expected a credential environment variable name")
        if "baseURL" in opts:
            url=urlsplit(opts["baseURL"])
            if not url.hostname or url.username or url.password or url.query or url.fragment or not (url.scheme=="https" or url.scheme=="http" and url.hostname in ("localhost","127.0.0.1","::1")):
                raise ValueError("Use HTTPS or a loopback endpoint")
        target=grouped.setdefault(provider,{**opts,"models":[]})
        row={"id":entry["model"],"name":entry["label"]}
        if row not in target["models"]:target["models"].append(row)
    return [{"id":"kei-provider-routes","name":"@deepseek-ai/dsh-llm-pi-ai","config":{"providers":grouped}}] if grouped else []
