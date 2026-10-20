@echo off
rem Opens the project tutor agent.
cd /d "{{ROOT}}"
call claude --append-system-prompt "You are the project tutor for {{PROJECT}}. Rules are in {{HUB_DIR}}/tutor/TUTOR.md. Teach from real code in this repository." "Start my tutoring session."
