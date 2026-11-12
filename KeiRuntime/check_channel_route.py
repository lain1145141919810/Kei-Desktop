"""Opt-in integration check. Sends synthetic events to a running local KeiRuntime."""
import asyncio
import json
import uuid
import httpx
import websockets


async def main():
    tag = "route-test-" + uuid.uuid4().hex
    async with httpx.AsyncClient(base_url="http://127.0.0.1:17881",trust_env=False) as http, websockets.connect("ws://127.0.0.1:17881/ws?client=kei-desktop") as ws:
        async def post(kind, session, suffix, payload):
            response = await http.post("/events",json=dict(type=kind,turn_id=tag+suffix,session_id=session,text="channel routing probe",payload=payload))
            response.raise_for_status()
            return response.json()
        for origin in ("qq-adapter:FriendMessage:test-user","qq-adapter:GroupMessage:test-group"):
            for kind in ("agent.begin","assistant.reply","assistant.affect","interrupt","agent.done"):
                payload = {"platform":"aiocqhttp"} if kind=="assistant.reply" else {}
                assert (await post(kind,origin,"-qq",payload))["route"]=="external"
        for origin, suffix in (("kei-desktop","-local"),("webchat:FriendMessage:webchat!kei-local-voice!kei-local-voice","-voice")):
            assert (await post("debug.channel.route",origin,suffix,{}))["status"]=="accepted"
        seen=set()
        async with asyncio.timeout(10):
            while tag+"-voice" not in seen:
                e=json.loads(await ws.recv())
                if str(e.get("turn_id")).startswith(tag):seen.add(e["turn_id"])
        assert seen=={tag+"-local",tag+"-voice"},seen
        print("QQ direct/group events isolated; native desktop and local AstrBot voice events delivered")
if __name__=="__main__":
    asyncio.run(main())
