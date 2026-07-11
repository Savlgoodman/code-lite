from __future__ import annotations

from acp import schema as acp_schema


def build_client_capabilities(runtime: str) -> acp_schema.ClientCapabilities:
    kwargs = {
        "auth": acp_schema.AuthCapabilities(terminal=False),
        "fs": acp_schema.FileSystemCapabilities(
            read_text_file=False,
            write_text_file=False,
        ),
        "terminal": False,
    }
    if runtime == "claude_code":
        kwargs["elicitation"] = acp_schema.ElicitationCapabilities(
            form=acp_schema.ElicitationFormCapabilities(),
            url=None,
        )
    return acp_schema.ClientCapabilities(**kwargs)
