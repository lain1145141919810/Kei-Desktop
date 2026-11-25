"""Model routes for native DSH children. No external shell or nested CLI delegation."""
import json
from pathlib import Path
from .dsh_models import catalog, adapter_nodes
import hashlib

ROLES = ("work", "review")


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
