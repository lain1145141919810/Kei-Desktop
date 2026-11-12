"""Route AstrBot's platform-qualified live events before desktop state is touched."""
LOCAL_VOICE_ORIGIN = "webchat:FriendMessage:webchat!kei-local-voice!kei-local-voice"


def belongs_to_desktop(session, payload):
    platform = payload.get("platform")
    if session == LOCAL_VOICE_ORIGIN:
        return platform in (None, "webchat")
    # AstrBot MessageSession serializes as platform_id:message_type:session_id.
    # Affect and cancellation events can lack platform metadata.
    if len(session.split(":", 2)) == 3:
        return False
    if platform or payload.get("source") in {"astrbot", "astrbot_tool", "astrbot_plugin_test"}:
        return False
    return True
