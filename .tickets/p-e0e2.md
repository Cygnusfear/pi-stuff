---
id: p-e0e2
status: closed
deps: []
links: []
created: 2026-02-13T07:09:26Z
type: task
priority: 2
assignee: api-docs
tags: [team]
---
# Find all uses of sendMessage and sendUserMessage across this codebase (including node_modules/@mariozechner/pi-coding-agent if accessible). Document the difference between the two APIs, all the options each supports, and create a reference guide. Also check if triggerTurn defaults to true or false by examining the implementation. Save as a ticket tagged 'research,api'.

Find all uses of sendMessage and sendUserMessage across this codebase (including node_modules/@mariozechner/pi-coding-agent if accessible). Document the difference between the two APIs, all the options each supports, and create a reference guide. Also check if triggerTurn defaults to true or false by examining the implementation. Save as a ticket tagged 'research,api'.


## Notes

**2026-02-13T07:10:48Z**

DONE: Created sendMessage-vs-sendUserMessage-reference.md in .pi-teams/api-docs/. Key findings: sendMessage injects custom-role messages (triggerTurn defaults to false, supports nextTurn delivery), sendUserMessage sends user-role messages (always triggers a turn, no nextTurn mode). Both support steer/followUp delivery during streaming. SDK equivalents are sendCustomMessage and sendUserMessage on AgentSession.
