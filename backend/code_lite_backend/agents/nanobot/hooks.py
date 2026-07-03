from __future__ import annotations

import asyncio
import uuid
from typing import Any

from nanobot.agent import AgentHook, AgentHookContext

from code_lite_backend.agents.risk import describe_risk, risk_level
from code_lite_backend.core.json_utils import to_jsonable
from code_lite_backend.services.approvals import ApprovalBroker, ToolApprovalRejected


class UiApprovalHook(AgentHook):
    def __init__(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        output_queue: asyncio.Queue[dict[str, Any]],
        approvals: ApprovalBroker,
    ) -> None:
        super().__init__(reraise=True)
        self._conversation_id = conversation_id
        self._turn_id = turn_id
        self._output_queue = output_queue
        self._approvals = approvals

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        for call in context.tool_calls:
            level = risk_level(call.name)
            if level == "low":
                continue

            approval_id = f"approval-{uuid.uuid4().hex}"
            future = await self._approvals.create(
                approval_id=approval_id,
                conversation_id=self._conversation_id,
                turn_id=self._turn_id,
            )
            risk = describe_risk(call.name)
            await self._output_queue.put(
                {
                    "type": "approval.required",
                    "conversationId": self._conversation_id,
                    "turnId": self._turn_id,
                    "approvalId": approval_id,
                    "toolCallId": call.id,
                    "name": call.name,
                    "arguments": to_jsonable(call.arguments or {}),
                    "risk": level,
                    **risk,
                }
            )

            allowed = await future
            if not allowed:
                raise ToolApprovalRejected(f"用户拒绝执行工具：{call.name}")
