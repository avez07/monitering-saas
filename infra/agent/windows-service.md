# Windows host agent

The dependency-free agent runs on Windows with Node.js 22.12 or later. Enroll from the repository root using the command shown in Agent management. The credential is saved to `.env`.

For background operation, use Windows Task Scheduler: create a task under a dedicated normal user, set **Start in** to the repository root, program to the installed `node.exe`, and arguments to the absolute path to `backend/scripts/agent.mjs`. Select restart on failure. Administrator privileges are not required for the agent's CPU and memory measurements.

A native Windows Service installer is not included. Use a reviewed service wrapper such as WinSW if a Service is required; obtain it from its official repository, verify its published checksum, and inspect its configuration before installation. Service installation requires explicit administrator confirmation.

Update by stopping the task, replacing the reviewed version of the script, and restarting. Uninstall by stopping/deleting the task, revoking the credential in Pulse, and removing `AGENT_TOKEN` from `.env`.
