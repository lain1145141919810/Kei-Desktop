"""Model routes for native DSH children. No external shell or nested CLI delegation."""
import json
from pathlib import Path
from bridge.dsh_models import catalog, adapter_nodes
import hashlib

DEFAULT = {"mode":"auto", "work":"flash", "review":"pro"}
ROLES = ("work","review")


def settings(data, config=None):
    if not isinstance(data,dict) or not set(data)<=set(DEFAULT):
        raise ValueError("Invalid subagent settings")
    result = {**DEFAULT,**data}
    if result["mode"] not in ("auto","ask","manual","off") or any(result[k] not in catalog(config or {}) for k in ROLES):
        raise ValueError("Unknown subagent mode or model")
    return result


def routes(config, requested=None):
    pref=settings(config.get("subagents",{}),config)
    if pref["mode"]=="off":
        return {}
    if pref["mode"]=="manual":
        return {k:pref[k] for k in ROLES}
    if requested is not None:
        if not isinstance(requested,dict) or not set(requested)<=set(ROLES) or any(m not in catalog(config or {}) for m in requested.values()):
            raise ValueError("Invalid child model assignment")
        return dict(requested)
    if pref["mode"]=="ask":
        return {}
    return {alias:alias for alias in catalog(config)}


def instructions(config):
    pref=settings(config.get("subagents",{}),config)
    mode=pref["mode"]
    base="Configured DSH model aliases: "+json.dumps(catalog(config),ensure_ascii=False)+". Before undertaking any work, decide whether an independent DSH child would improve execution, research or verification. Handle simple work directly. "
    if config["backend"]!="dsh":
        return base+"Native DSH children are available when the user selects DSH. Do not claim other executors have these tools."
    if mode=="ask":
        return base+"If delegation is useful, FIRST ask which configured models should handle which work, and wait for a reply. Once answered, pass child_roles with work and/or review and describe the assigned subtasks in request."
    if mode=="manual":
        return base+f"Admin selected work={pref['work']} and review={pref['review']}. Delegate useful subtasks to child_work/child_review through astrbot_task."
    if mode=="off":
        return base+"Native delegation is disabled by the owner."
    return base+"Delegate through astrbot_task when useful. Explicitly describe the child's assignment to DSH. Choose among the listed aliases according to the work and the user preference. Respect explicit user assignments via child_roles. Ask only when their preference matters."


def patch_file(root, mapping, config=None):
    config=config or {}
    models=catalog(config)
    if not set(mapping)<=set(models)|set(ROLES) or not set(mapping.values())<=set(models):
        raise ValueError("Invalid DSH routes")
    aliases=set(mapping.values())
    if config.get("parent_alias"): aliases.add(config["parent_alias"])
    nodes=adapter_nodes(config,sorted(aliases))
    if mapping:
        nodes.extend([{"id":"kei-children","name":"@deepseek-ai/dsh-subagent"},{"id":"kei-spawn","name":"@deepseek-ai/dsh-subagent-spawn-in-process"}])
    for role,model in sorted(mapping.items()):
        nodes.append({"id":"kei-child-"+role,"name":"@deepseek-ai/dsh-tool-subagent","config":{
            "provider":"spawn","toolName":"child_"+role,"enableRunInBackground":False,"maxDepth":1,
            "agentOptions":{"provider":models[model]["provider"],"model":models[model]["model"],"maxTokens":2048},
            "persona":"Complete only the assigned subtask in the parent's workspace. Report results and limitations. Respect the parent's permissions."}})
    folder=Path(root)/"child-profiles";folder.mkdir(exist_ok=True,parents=True)
    data=json.dumps([{"insert":nodes}],ensure_ascii=True)
    path=folder/(hashlib.sha256(data.encode()).hexdigest()[:24]+".yml")
    if not path.exists() or path.read_text(encoding="utf8")!=data:
        import tempfile,os
        with tempfile.NamedTemporaryFile(mode="w",encoding="utf8",dir=folder,delete=False) as f:f.write(data)
        os.replace(f.name,path)
    return path
