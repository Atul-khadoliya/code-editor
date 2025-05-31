# Online Code Editor

A web-based application that allows users to write and execute Python code directly in their browser with an interactive terminal.

## Live Demo

* **Frontend:** [https://jolly-dasik-729c4a.netlify.app/](https://jolly-dasik-729c4a.netlify.app/)
* **Backend Service Endpoint (via Custom Domain):** `wss://myonlinepython.in` (This is what the frontend connects to)

## Features

* **Rich Code Editor:** Uses Monaco Editor (the editor that powers VS Code) for a familiar coding experience with syntax highlighting.
* **Python Code Execution:** Executes Python 3 code in a sandboxed environment.
* **Interactive Terminal:**
    * Displays real-time output from the executed code.
    * Supports programs that require user input via `input()`.
* **Real-time Communication:** Uses WebSockets for instant communication between the frontend editor and the backend execution engine.
* **Secure Connection:** The deployed version uses HTTPS for the frontend and WSS (Secure WebSockets) for backend communication, ensuring data is encrypted.

## Tech Stack

* **Frontend:**
    * HTML5, CSS3, Vanilla JavaScript
    * [Monaco Editor](https://microsoft.github.io/monaco-editor/)
    * Hosted on: [Netlify](https://www.netlify.com/)

* **Backend:**
    * Node.js
    * `ws` library (for WebSockets)
    * Express.js (minimal, for base HTTP server)
    * Docker (for sandboxed code execution)
    * Hosted on: AWS EC2 instance

* **Deployment & Infrastructure:**
    * **AWS EC2:** Hosts the backend Node.js application and Docker.
    * **Docker:** Containerizes the backend application and runs user code in isolated Python containers.
    * **Nginx:** Acts as a reverse proxy on EC2, handles SSL termination for the custom domain.
    * **Let's Encrypt (via Certbot):** Provides free SSL/TLS certificates for `myonlinepython.in`.
    * **Custom Domain:** `myonlinepython.in`

## Architecture Overview

1.  The **Frontend** is a static site hosted on Netlify, providing the user interface with the Monaco Editor and terminal display.
2.  When the user runs code, the frontend establishes a **Secure WebSocket (WSS) connection** to `wss://myonlinepython.in`.
3.  **Nginx** on the EC2 instance receives this `wss://` connection, terminates SSL, and proxies the WebSocket traffic to the backend Node.js application (running as a Docker container and listening on `ws://localhost:3000` from Nginx's perspective).
4.  The **Backend Node.js Application** receives the code.
    * It writes the user's code to a temporary file.
    * It then spawns a new, isolated **Docker container** (e.g., `python:3.9-slim-buster`) to execute this code.
    * `stdout`, `stderr`, and `stdin` for the user's code are piped through the WebSocket connection to/from the frontend, allowing for interactive I/O.
5.  Temporary files and execution containers are cleaned up after execution.

Author
Atul Khadoliya
GitHub: https://github.com/Atul-khadoliya
