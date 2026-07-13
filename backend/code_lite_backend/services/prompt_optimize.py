"""提示词优化的外部模型调用（stdlib urllib，与 settings.py / image_gen.py 一致，不新增依赖）。

生图提示词优化与 code agent 提示词优化共用同一条 chat/completions 调用，仅 system 模板不同。
"""
from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


OPTIMIZE_TIMEOUT = 60


def _chat_endpoint(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if normalized.endswith("/v1"):
        return f"{normalized}/chat/completions"
    return f"{normalized}/v1/chat/completions"


def optimize_prompt(
    *,
    base_url: str,
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> str:
    """调用文本模型优化提示词，返回优化后的文本；失败抛 RuntimeError（中文可读消息）。"""
    endpoint = _chat_endpoint(base_url)
    request_body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
    }).encode("utf-8")
    request = Request(
        endpoint,
        data=request_body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=OPTIMIZE_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except HTTPError as error:
        if error.code == 401:
            raise RuntimeError("API Key 无效") from error
        raise RuntimeError(f"提示词优化接口返回 {error.code}") from error
    except (OSError, URLError, TimeoutError) as error:
        raise RuntimeError("无法连接文本模型供应商") from error
    except json.JSONDecodeError as error:
        raise RuntimeError("文本模型返回内容无法解析") from error

    choices = payload.get("choices") if isinstance(payload, dict) else None
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            return content.strip()
    raise RuntimeError("提示词优化结果为空")
