"""Check that search tool lifecycle emits useful, bounded CG2 metadata."""

import asyncio
from types import SimpleNamespace

from mcp.types import CallToolResult, TextContent

from data.plugins.astrbot_plugin_kei.main import KeiPlugin


def test_search_tool_progress_metadata():
    plugin = object.__new__(KeiPlugin)
    published = []

    async def capture(_event, event_type, *, payload):
        published.append((event_type, payload))

    plugin._publish_agent_event = capture
    tool = SimpleNamespace(name="deepseek_web_search")
    result = CallToolResult(
        content=[TextContent(type="text", text="Found a result")],
        structuredContent={
            "results": [
                {
                    "title": " Official source ",
                    "url": "https://user:secret@example.com/path",
                }
            ]
        },
    )

    async def run():
        await plugin.publish_tool_start(None, tool, {"query": "latest release"})
        await plugin.publish_tool_end(None, tool, None, result)

    asyncio.run(run())
    assert published[0][0] == "agent.tool.start"
    assert published[0][1]["subject"] == "latest release"
    assert published[1][0] == "agent.tool.end"
    assert published[1][1]["result_count"] == 1
    assert published[1][1]["result_previews"] == [
        {"title": "Official source", "snippet": "", "source": "example.com"}
    ]


def test_shell_progress_is_semantic_only():
    activity, label = KeiPlugin._tool_step(
        "astrbot_execute_shell", {"command": "rg SECRET_PATTERN private/path"}
    )
    assert (activity, label) == ("reading", "检索本地内容")
    assert "SECRET_PATTERN" not in label
