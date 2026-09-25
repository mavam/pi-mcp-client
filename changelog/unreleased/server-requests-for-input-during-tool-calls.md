---
title: Server requests for input during tool calls
type: feature
authors:
  - mavam
created: 2026-09-25T08:45:57.512037Z
---

MCP servers can now ask you for information or send you to a web page while a tool call runs. Pi shows each request in a dialog that names the requesting server, and the tool call continues once you respond.

Form requests list the requested fields with their current values. Select a field to edit it; Pi checks each value against the field's type and constraints and sends values only when you choose **Submit**. **Decline** and **Cancel** send nothing.

Web page requests show the site and the full URL before anything opens. Choose **Open in browser**, or **I'll open it myself** when Pi runs over SSH. When a server refuses to run a tool until you finish a step on a web page, Pi waits for the server to confirm completion or for you to choose **Done**. The tool doesn't run again automatically; the model can call it again afterward.

Time spent answering doesn't count against `toolTimeoutMs`. Headless sessions don't offer this capability to servers, so servers fall back to their non-interactive behavior.
