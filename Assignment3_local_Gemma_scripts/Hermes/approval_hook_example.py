# Source: Assignment3_local_Gemma.pdf, Part 1, step 8.
# EXAMPLE of the idea only: your hook and names may differ.

# The platform of each session is recorded in the pre_llm_call hook, e.g. _PLATFORM[session_id] = platform
def on_pre_tool_call(tool_name, args, session_id=None, **kwargs):
    decision = your_policy(tool_name, args)            # may return {"action": "approve", ...}
    if decision and decision.get("action") == "approve" \
            and _PLATFORM.get(session_id or "", "") == "api_server":
        return {"action": "block",
                "message": "This action needs human approval, which the web chat cannot show. "
                           "Save a draft instead, or ask me in Telegram/Discord to approve it there."}
    return decision
