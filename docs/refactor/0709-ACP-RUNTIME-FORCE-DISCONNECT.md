# ACP Runtime 强制断开与进程树清理修复方案

创建日期：2026-07-09

本文记录 ACP 连接释放不彻底导致 Codex、Claude Code 底层 runtime 进程残留的问题，以及面向设置变更、ACP 包升级和 runtime executable 切换的修复方案。本文聚焦 bug 修复和生命周期治理，不替代 `docs/design/0708-ACP-MULTI-SESSION-CONNECTION.md` 的多 session 架构设计。

## 1. 背景

当前设置页已有“ACP 连接管理”入口：

```text
UI 设置页
  -> POST /api/runtimes/acp/cleanup
  -> AcpRuntimeManager.close_all()
  -> AcpRuntimeManager.close_connection()
  -> AcpRuntimeManager._close_connection()
```

用户点击“释放全部连接”后，后端状态会清空，UI 也会显示没有 ACP 连接。但实际观察中，`claude-agent-acp`、`codex-acp` 启动出来的底层 runtime 进程仍可能残留。例如 Claude Code 使用 SDK 内置 `claude.exe` 时，残留进程会占用 `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`，从而导致后续 ACP 包升级或覆盖失败。

这说明当前释放是“状态释放”多于“进程释放”。对于 runtime 设置页而言，这会让以下操作看似生效但实际仍复用旧进程或被文件占用阻塞：

1. 切换底层 Runtime 可执行文件。
2. 切换 ACP 包目录。
3. 升级或重装 ACP npm 包。
4. 切换配置模式或影响环境变量的设置。
5. 手动释放所有 ACP 连接。

## 2. 当前实现诊断

### 2.1 cleanup API 已接到 manager

现有 API 路径：

```text
backend/code_lite_backend/api/routes/runtime.py
  POST /runtimes/acp/cleanup
    -> await services.runtime_manager.close_all()
```

这说明按钮不是“纯前端假释放”。它确实调用了后端 manager。

### 2.2 `_close_connection()` 只处理直接子进程

当前核心逻辑位于：

```text
backend/code_lite_backend/agents/acp/runtime_manager.py
```

关闭流程大致是：

```text
cancel stderr task
-> sdk_connection.close()
-> process.terminate()
-> wait 5s
-> process.kill()
-> wait 3s
```

这里的 `process` 是 Python `asyncio.create_subprocess_exec()` 直接启动的 ACP wrapper 命令。Windows 下托管命令通常是 `.cmd` shim，例如：

```text
claude-agent-acp.cmd
  -> node dist/index.js
     -> @anthropic-ai/claude-agent-sdk-win32-x64/claude.exe

codex-acp.cmd
  -> node dist/index.js
     -> @openai/codex-*/codex.exe
```

杀掉 `.cmd` 或其直接 `node` 父进程，不一定能收掉所有孙进程和 runtime native binary。尤其当父进程已经退出、子进程脱离或 Windows job/process tree 没有被统一管理时，底层 `claude.exe` / `codex.exe` 会继续存在。

### 2.3 Tauri 侧已有可借鉴做法

Tauri 后端 sidecar 关闭逻辑已经使用 Windows 进程树清理：

```text
src-tauri/src/lib.rs
  taskkill /PID <pid> /T /F
```

这说明项目已有明确工程判断：Windows 上关闭一个“会继续拉起子进程”的工作进程时，必须按进程树结束，而不是只杀直接 child。

### 2.4 设置变更没有主动断开旧连接

现有设置接口直接更新配置或安装包：

```text
PATCH /api/settings/acp-packages
POST  /api/settings/acp-packages/install
PATCH /api/settings/agent-runtimes/{runtime_id}
POST  /api/settings/agent-runtimes/{runtime_id}/install
PATCH /api/settings/agent-runtimes/active
```

这些接口主要操作 `AgentRuntimeConfigStore`，没有在修改前后通知 `AcpRuntimeManager` 关闭受影响 runtime 的连接。因此即使 `ConnectionKey` 使用 command/env fingerprint，新配置也要等下一次 `ensure_connection()` 才会创建新连接；旧连接如果仍在内存或底层进程残留，会继续占用包目录或 runtime binary。

## 3. 根因

根因分两层：

1. **进程树清理缺失**：`_close_connection()` 只关闭 ACP wrapper 的直接进程，没有保证杀掉 `node`、`claude.exe`、`codex.exe` 等 descendants。
2. **配置变更缺少 runtime invalidation**：ACP 包目录、托管包安装、底层 executable、command/env/config 变更时，没有先关闭对应 runtime 的 active connection 和底层进程树。

这两个问题叠加后，用户看到的现象就是：

```text
UI 显示已释放
  -> manager 内存状态清了
  -> 但 OS 进程仍在
  -> 文件句柄仍占用旧 package/native executable
  -> 后续升级或切换配置失败
```

## 4. 修复目标

1. 点击“释放全部连接”后，必须结束所有由 code-lite ACP manager 启动的 ACP wrapper 和底层 runtime 进程。
2. 释放动作应清理 in-memory connection、session route、pending approval/input、stderr task 和 native session binding 状态。
3. 切换 ACP 包目录、安装/升级 ACP 包、切换底层 executable、修改 runtime command/env/config mode 前，必须先断开受影响 runtime。
4. 断开后再次对话时重新 `spawn -> initialize -> session/new|resume|load`，不复用旧 process。
5. 关闭必须可诊断：返回 attempted pids、closed count、failed count、stderr 或 taskkill 结果摘要。
6. 不能误杀用户系统中非 code-lite 启动的 Claude / Codex 进程。

## 5. 非目标

1. 本轮不重写多 session 路由架构。
2. 本轮不实现完整 idle TTL 自动回收。
3. 本轮不改变 ACP protocol 或 Python SDK 版本。
4. 本轮不删除 native session 历史；强断开是断开 runtime 进程，不等于删除 conversation transcript。
5. 本轮不引入 psutil 作为必选依赖，除非后续评估标准库加 `taskkill` 不够。

## 6. 目标语义

需要区分三类动作：

| 动作 | 语义 | 是否杀进程树 |
| --- | --- | --- |
| close session | 释放某个 native session，保留 connection 供其他 session 用 | 否，除非 connection 为空且要求关闭 |
| disconnect runtime | 关闭某个 runtime 的所有 ACP connections 和底层进程树 | 是 |
| cleanup all | 关闭所有 runtime 的所有 ACP connections 和底层进程树 | 是 |

设置页按钮“释放全部连接”应执行 `cleanup all`，不是仅 `session/close`。

设置变更中的 `install/update package`、`change package dir`、`change runtime executable` 应执行对应 runtime 的 `disconnect runtime`。

## 7. 方案概览

### 7.1 新增进程树工具

建议新增：

```text
backend/code_lite_backend/core/process_tree.py
```

职责：

1. 根据 pid 终止整棵进程树。
2. Windows 优先使用 `taskkill /PID <pid> /T /F`。
3. 非 Windows 使用 process group 或 direct process fallback。
4. 返回结构化结果，供 API 和日志记录。
5. 只接受 manager 记录的 pid，不按进程名全局扫描杀进程。

草案：

```python
@dataclass
class ProcessTreeKillResult:
    pid: int
    attempted: bool
    method: str
    returncode: int | None = None
    stdout: str = ""
    stderr: str = ""
    error: str | None = None


async def terminate_process_tree(pid: int, *, timeout: float = 8.0) -> ProcessTreeKillResult:
    ...
```

Windows 命令：

```powershell
taskkill /PID <pid> /T /F
```

调用时必须隐藏窗口，沿用 `CREATE_NO_WINDOW`。

### 7.2 spawn 时记录进程元数据

`AcpRuntimeConnection` 增加：

```python
root_pid: int
spawned_at: str
closed_at: str | None
close_reason: str | None
close_result: dict[str, Any] | None
```

状态 API 增加 `rootPid`、`closeReason`、`closeResult`。UI 可以继续显示 `PID`，但后端诊断应能看到 taskkill 结果。

### 7.3 `_close_connection()` 改为强关闭状态机

目标关闭顺序：

```text
mark connection not ready
-> reject pending approval/input for affected sessions
-> detach/remove routes
-> best effort session/close for active sessions
-> sdk_connection.close()
-> close stdin/stdout references if possible
-> try graceful direct terminate
-> Windows taskkill /T /F by root pid
-> fallback direct kill
-> wait and verify direct process returncode
-> write structured acp/diagnostic log
-> remove connection from manager
```

关键点：

1. `taskkill /T /F` 应在 direct parent pid 仍可用时尽早调用；如果 parent 已退出，至少记录“pid not found”。
2. `sdk_connection.close()` 失败不能阻止强杀。
3. 强杀后要清理 `connection.sessions`、handler route 和 manager binding。
4. 关闭结果不应被 `contextlib.suppress` 完全吞掉；失败要写日志和返回 API。

### 7.4 新增按 runtime 断开

`AcpRuntimeManager` 增加：

```python
async def disconnect_runtime(
    self,
    runtime_id: str,
    *,
    reason: str,
    delete_bindings: bool = False,
) -> dict[str, Any]:
    ...

async def disconnect_all(
    self,
    *,
    reason: str,
) -> dict[str, Any]:
    ...
```

`close_all()` 可以保留为兼容 wrapper，但内部调用 `disconnect_all(reason="backend_shutdown")`。

返回示例：

```json
{
  "closed": true,
  "reason": "manual_cleanup",
  "connections": [
    {
      "runtime": "claude_code",
      "pid": 8832,
      "sessions": ["conv_1"],
      "processTree": {
        "attempted": true,
        "method": "taskkill",
        "returncode": 0
      }
    }
  ],
  "failed": []
}
```

### 7.5 cleanup API 返回真实结果

现有：

```json
{"closed": true}
```

建议改为：

```json
{
  "closed": true,
  "summary": {
    "closedConnections": 2,
    "failedConnections": 0
  },
  "connections": []
}
```

前端可以先只看 `closed`，但日志页和调试时能展开详情。

## 8. 设置变更联动断开

### 8.1 需要强制断开的操作

| API | 影响范围 | 断开时机 |
| --- | --- | --- |
| `PATCH /settings/acp-packages` 指定 `runtimeId` | 指定 runtime | 修改前 |
| `PATCH /settings/acp-packages` 修改 root | Codex + Claude Code | 修改前 |
| `POST /settings/acp-packages/install` 指定 `runtimeId` | 指定 runtime | 安装前 |
| `POST /settings/acp-packages/install` 全部 | Codex + Claude Code | 安装前 |
| `PATCH /settings/agent-runtimes/{runtime_id}` 改 command/executable/config/mode | 指定 runtime | 保存前或保存后立即断开 |
| `POST /settings/agent-runtimes/{runtime_id}/install` | 指定 runtime | 安装前 |
| `PATCH /settings/agent-runtimes/active` | 通常不必全断开 | 可选，只断开旧 active runtime 的 idle connection |

建议策略：

1. 安装或覆盖目录前必须先断开，避免 Windows 文件占用。
2. 修改 runtime executable 或 command 前先断开旧 runtime，保存后下一次对话会用新配置。
3. 修改 mode、configMode、env 相关配置时也断开，因为旧 connection 的 env fingerprint 已经固定，继续保留会造成“新设置不生效”的错觉。

### 8.2 Service 注入方式

当前 `AgentRuntimeConfigStore` 是纯配置 store，不持有 `runtime_manager`。不要把 manager 硬塞进 store，建议在 API route 层编排：

```text
settings route
  -> await runtime_manager.disconnect_runtime(runtime_id, reason="runtime_config_update")
  -> await asyncio.to_thread(agent_runtime_config_store.update_runtime, ...)
```

这样配置存储仍保持无副作用，生命周期由 API 层负责。

### 8.3 错误策略

安装前断开失败时：

1. 如果进程树强杀失败，应阻止安装，返回 409 或 502。
2. 错误信息应提示“Runtime 仍在运行，请手动结束后重试”，并附 pid。
3. 不应继续 `shutil.rmtree(package_dir)`，避免半删除。

保存普通配置时：

1. 断开失败也应提示用户，避免用户误以为新设置已生效。
2. 可允许保存配置，但 response 要带 warning；下一次对话前仍需尝试断开旧连接。

## 9. Windows 进程树细节

### 9.1 为什么 `process.kill()` 不够

`asyncio.Process.kill()` 只作用于直接 child。Windows 的 `.cmd` shim、Node wrapper 和 native runtime 之间可能形成多层关系：

```text
python backend
  -> cmd.exe /c claude-agent-acp.cmd
     -> node.exe
        -> claude.exe
```

结束 `cmd.exe` 不等于结束 `node.exe` 和 `claude.exe`。ACP npm 包升级时，真正被占用的往往是底层 native binary 文件。

### 9.2 为什么不能按进程名全局杀

不能简单 `taskkill /IM claude.exe /F`，因为用户可能在系统里单独运行了 Claude Code。code-lite 只能杀自己启动的 root pid 及其 descendants。

### 9.3 可选增强：Job Object

后续可以在 Windows 上使用 Job Object 管理 ACP subprocess tree，但 Python 标准库没有直接封装，成本高于当前 bug 修复。当前建议先用 `taskkill /T /F` 达到可靠释放。

## 10. API 与 UI 调整

### 10.1 Backend API

保留现有接口：

```text
POST /api/runtimes/acp/cleanup
```

新增可选接口：

```text
POST /api/runtimes/acp/{runtime_id}/disconnect
```

用途：

1. 设置页可对单个 runtime 释放。
2. 设置变更 route 可内部复用 manager 方法，不一定需要前端直接调用。

### 10.2 UI

设置页“ACP 连接管理”建议：

1. “释放全部连接”文案改为“断开全部 Runtime”或“彻底断开全部连接”。
2. 每个 connection 卡片增加“断开此 Runtime”按钮。
3. 释放后显示关闭结果：关闭连接数、失败连接数、失败 pid。
4. 安装或切换 runtime executable 前，如当前 runtime 有活跃连接，提示会先断开。

UI 不需要自己杀进程，只调用 backend API。

## 11. 日志与诊断

结构化日志建议：

```json
{
  "category": "acp",
  "stage": "disconnect.runtime",
  "runtime": "claude_code",
  "message": "Disconnected ACP runtime process tree.",
  "fields": {
    "pid": 8832,
    "reason": "manual_cleanup",
    "method": "taskkill",
    "returncode": 0,
    "sessions": ["conv_..."]
  }
}
```

失败时写 diagnostic：

```text
code: acp.disconnect_failed
stage: disconnect.runtime
userAction: 请手动结束该 runtime 进程后重试升级或切换设置。
details: pid, runtime, command, taskkill stdout/stderr
```

## 12. 测试策略

### 12.1 单元测试

1. `close_all()` 会调用 process tree killer。
2. `disconnect_runtime("claude_code")` 只关闭 Claude connections，不影响 Codex。
3. `disconnect_all()` 清空 `_connections`、`_session_bindings`、`_turn_locks`。
4. process tree killer 返回失败时，API 返回可诊断 payload。
5. settings route 在 install/update 前调用对应 runtime disconnect。

### 12.2 Windows 集成测试

新增临时 helper：

```text
demo/acp-demo/process_tree_probe.py
```

模拟：

```text
parent cmd/python
  -> child python
     -> grandchild python sleep
```

验证：

1. 只 kill parent 时 grandchild 可能残留。
2. `terminate_process_tree(root_pid)` 后 parent/child/grandchild 都退出。

### 12.3 真实 runtime smoke

手工验证：

1. 启动 Claude Code ACP session，确认 status 有 `claude_code` connection。
2. 用 Process Explorer 或 `Get-CimInstance Win32_Process` 确认 `node.exe`、`claude.exe` 子进程存在。
3. 点击“释放全部连接”。
4. 确认 status 为空。
5. 确认相关 `claude.exe` / `node.exe` 不再存在。
6. 立即执行 ACP 包升级或重装，确认不再出现文件占用。
7. 再次进入对话，确认会重新 spawn 并初始化。

PowerShell 检查示例：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*claude-agent-acp*' -or $_.CommandLine -like '*claude-agent-sdk*' } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

## 13. 实施阶段

### 阶段 1：进程树工具与 manager 强关闭

1. 新增 `core/process_tree.py`。
2. `_close_connection()` 使用进程树终止。
3. `close_all()` 返回结构化结果。
4. cleanup API 返回结构化结果。
5. 补 runtime manager 单元测试。

验收：

1. 点击“释放全部连接”后，Windows 上 ACP wrapper 与底层 runtime 都退出。
2. UI status 为空。
3. ACP 包目录不再被 `claude.exe` / `codex.exe` 占用。

### 阶段 2：按 runtime 断开与设置变更联动

1. 新增 `disconnect_runtime(runtime_id, reason=...)`。
2. settings routes 在 package dir/root/install/runtime executable/command/config mode 变更前调用 disconnect。
3. 安装前断开失败则阻止安装。
4. 补 settings route 测试。

验收：

1. 切换 Claude SDK/system executable 后，旧 Claude ACP 进程立即退出。
2. 切换 ACP package dir 后，旧 package 目录不再被占用。
3. 重装或升级 ACP 包不再因旧 runtime 进程残留失败。

### 阶段 3：UI 反馈与诊断

1. 设置页显示断开结果。
2. 每个 runtime connection 卡片提供单独断开按钮。
3. 日志页可看到 `disconnect.runtime` 记录。
4. 失败时显示 pid 和建议动作。

验收：

1. 用户能看出是真的关闭了哪些 pid。
2. 失败时不是静默“已释放”，而是明确提示残留进程。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| taskkill 误杀用户进程 | 用户独立运行的 Claude/Codex 被结束 | 只按 code-lite 记录的 root pid 杀进程树，不按进程名杀 |
| 强杀中断正在运行的 prompt | 当前 turn 丢失 | UI 对“释放/断开”使用危险按钮，后端先 cancel pending approval/input |
| session/close 未完成就强杀 | native runtime 状态可能未保存 | 强断开用于设置变更和手动释放，优先保证文件句柄释放；后续可 resume/load/new |
| taskkill 不存在或失败 | Windows 释放不彻底 | 返回失败诊断，阻止安装；保留 direct kill fallback |
| 非 Windows process group 不完整 | Linux/macOS 子进程残留 | spawn 时考虑 start_new_session/process group，关闭时 killpg |
| 设置变更频繁触发断开 | 用户会话被打断 | 仅对影响 command/env/package/executable 的字段强断开，普通 UI 状态不触发 |

## 15. 回滚策略

1. 如果 process tree kill 在某些环境误伤，保留环境变量关闭强杀：

```text
CODE_LITE_ACP_FORCE_PROCESS_TREE_KILL=0
```

2. 回滚后仍保留当前 direct terminate/kill。
3. settings route 的“安装前断开”可以保留，即使强杀关闭，也能提前发现仍有 active connection。

## 16. 验收标准

1. `POST /api/runtimes/acp/cleanup` 后，status 返回 0 connections。
2. Windows 进程列表中不再存在 code-lite 启动的 `claude-agent-acp` / `codex-acp` / `node` / SDK `claude.exe` / `codex.exe` descendants。
3. Claude SDK 内置 `claude.exe` 不再因残留进程导致 ACP 包升级失败。
4. 切换底层 Runtime executable 后，下次对话使用新 executable。
5. 切换 ACP package dir 后，下次对话使用新 package command。
6. 断开失败时 API 和 UI 不显示“成功释放”，而是返回可诊断错误。
7. Backend shutdown、Tauri shutdown、手动 cleanup 三条路径都走同一套强关闭逻辑。

## 17. 最终建议

优先做小而硬的修复：在 Python backend 增加进程树终止工具，并让 `AcpRuntimeManager` 的连接关闭语义从“关闭直接子进程”升级为“断开该 ACP runtime process tree”。随后把设置页中会影响 command/env/package/executable 的操作全部接入 runtime invalidation。

这样不需要先完成多 session 架构重写，就能解决当前最伤体验的假释放、文件占用和设置不生效问题。
