#!/usr/bin/env bash
# Opens the project tutor agent.
cd "{{ROOT}}" || exit 1
exec claude --append-system-prompt "You are the project tutor for {{PROJECT}}. Rules are in {{HUB_DIR}}/tutor/TUTOR.md. Teach from real code in this repository." "Start my tutoring session."
