const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { WebSocketServer } = require('ws'); // Changed import for clarity, WebSocket.Server is often used as WebSocketServer

const app = express();
const PORT = process.env.PORT || 3000;

// Define the path inside the Node.js container where host's temp directory will be mounted
// This corresponds to the target of a volume mount like:
// -v /mnt/code_execution_temp_on_host:/app/host_temp_files (when running this Node.js app's container)
const HOST_TEMP_FILES_PATH_INSIDE_CONTAINER = '/app/host_temp_files';
// Define the corresponding path on the EC2 host machine
const HOST_TEMP_FILES_PATH_ON_HOST = '/mnt/code_execution_temp_on_host'; // CHOOSE A PATH ON YOUR EC2 HOST

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Code editor backend is alive and well!');
});

// Create HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP Server is running on http://0.0.0.0:${PORT}`); // Listen on all interfaces
});

// Create WebSocket server and attach it to the HTTP server
const wss = new WebSocketServer({
    server, // Attach to the existing HTTP server
    verifyClient: (info, callback) => {
        const allowedOrigins = [
            'https://jolly-dasik-729c4a.netlify.app', // *** ENSURE THIS IS YOUR CORRECT NETLIFY URL ***
            // Add other origins if needed, e.g., for local development:
            // 'http://localhost:your_local_frontend_port'
        ];
        const origin = info.origin;

        if (allowedOrigins.includes(origin)) {
            console.log(`WebSocket connection from origin: ${origin} allowed.`);
            callback(true); // Allow connection
        } else {
            console.log(`WebSocket connection from origin: ${origin} DENIED (Origin: ${origin || 'Not specified'}).`);
            callback(false, 403, 'Forbidden origin'); // Deny connection
        }
    }
});

console.log(`WebSocket Server is attached to HTTP server, listening for connections.`);

wss.on('connection', ws => {
    console.log('Client connected via WebSockets');

    let dockerProcess = null;
    let tempFilePathOnHostSystem = null; // Will store the path on the HOST system

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'code') {
                const code = data.value;
                // const language = data.language; // Language variable not used yet, but good to have

                if (!code) {
                    ws.send(JSON.stringify({ type: 'error', value: 'No code provided.' }));
                    return;
                }

                const uniqueId = uuidv4();
                const tempFilename = `temp_code_${uniqueId}.py`;

                // Path where Node.js (inside its container) will write the file.
                // This path *inside the container* must map to HOST_TEMP_FILES_PATH_ON_HOST on the host.
                const tempFilePathInsideNodeContainer = path.join(HOST_TEMP_FILES_PATH_INSIDE_CONTAINER, tempFilename);
                // Actual path on the host system, used for the Python container's volume mount
                tempFilePathOnHostSystem = path.join(HOST_TEMP_FILES_PATH_ON_HOST, tempFilename);

                // Ensure the directory inside the container exists (should be created by Dockerfile or mount)
                // For simplicity, we assume HOST_TEMP_FILES_PATH_INSIDE_CONTAINER is writable.
                // If HOST_TEMP_FILES_PATH_INSIDE_CONTAINER doesn't exist, fs.promises.writeFile will fail.
                // It's better if your Node app's Dockerfile creates HOST_TEMP_FILES_PATH_INSIDE_CONTAINER
                // or that the mount point ensures it's there.
                await fs.promises.mkdir(HOST_TEMP_FILES_PATH_INSIDE_CONTAINER, { recursive: true }); // Ensure directory exists
                await fs.promises.writeFile(tempFilePathInsideNodeContainer, code);
                console.log(`Code written to ${tempFilePathInsideNodeContainer} (inside Node container, maps to ${tempFilePathOnHostSystem} on host)`);
                ws.send(JSON.stringify({ type: 'status', value: 'Code received and preparing for execution...' }));

                const dockerImage = 'python:3.9-slim-buster';
                const command = 'docker';
                const args = [
                    'run',
                    '--rm',
                    '-i', // Interactive mode for stdin
                    '--network=none',
                    '--memory=128m',
                    '--cpus=0.5',
                    // IMPORTANT: Mount uses the host path (tempFilePathOnHostSystem)
                    '-v', `${tempFilePathOnHostSystem}:/app/code.py`,
                    dockerImage,
                    'python', '/app/code.py'
                ];

                console.log(`Executing Docker command: ${command} ${args.join(' ')}`);
                dockerProcess = spawn(command, args, { timeout: 30000 }); // 30-second timeout

                dockerProcess.stdout.on('data', data => {
                    const output = data.toString();
                    console.log(`Docker stdout: ${output.trim()}`);
                    ws.send(JSON.stringify({ type: 'output', value: output }));
                });
                dockerProcess.stderr.on('data', data => {
                    const errorOutput = data.toString();
                    console.error(`Docker stderr: ${errorOutput.trim()}`);
                    ws.send(JSON.stringify({ type: 'error', value: errorOutput }));
                });

                dockerProcess.on('close', (code, signal) => { // Added signal for more info
                    console.log(`Docker process exited with code ${code}, signal ${signal}`);
                    let finalStatus = '';
                    if (signal === 'SIGTERM' || signal === 'SIGKILL' || (code === null && signal === null /* check timeout */) ) { // timeout can result in code null, signal null
                        finalStatus = 'Program terminated (e.g., timed out, killed, or crashed).';
                    } else if (code === 0) {
                        finalStatus = 'Program finished successfully.';
                    } else {
                        finalStatus = `Program exited with error code ${code}.`;
                    }
                    ws.send(JSON.stringify({ type: 'status', value: finalStatus }));
                    ws.send(JSON.stringify({ type: 'end' }));
                    cleanup();
                });
                dockerProcess.on('error', err => {
                    console.error(`Failed to start Docker process: ${err.message}`);
                    ws.send(JSON.stringify({ type: 'error', value: `Backend error: Could not start Docker process. Error: ${err.message}` }));
                    ws.send(JSON.stringify({ type: 'end' }));
                    cleanup();
                });

            } else if (data.type === 'input') {
                if (dockerProcess && dockerProcess.stdin && !dockerProcess.stdin.destroyed) {
                    console.log(`Writing input to Docker: ${data.value}`);
                    dockerProcess.stdin.write(data.value + '\n');
                } else {
                    console.warn('Received input, but Docker process is not running or stdin not available/writable.');
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            ws.send(JSON.stringify({ type: 'error', value: `Server error: ${error.message}` }));
            // Consider if cleanup() is appropriate here or if the connection should remain open for more attempts
        }
    });

    ws.on('close', () => {
        console.log("Client disconnected from WebSocket");
        cleanup();
    });

    ws.on('error', (error) => { // Added error parameter
        console.error('WebSocket error:', error);
        cleanup();
    });

    const cleanup = () => {
        if (dockerProcess) {
            console.log('Attempting to kill Docker process...');
            if (!dockerProcess.killed) {
                dockerProcess.kill('SIGKILL'); // Force kill
            }
            dockerProcess = null;
        }

        // tempFilePathOnHostSystem stores the path on the HOST.
        // The Node.js process (inside its container) cannot directly delete files on the HOST
        // unless it has that specific host path mounted AND has permissions.
        // It wrote to tempFilePathInsideNodeContainer. So it should delete that.
        const fileToDelete = path.join(HOST_TEMP_FILES_PATH_INSIDE_CONTAINER, path.basename(tempFilePathOnHostSystem || ''));
        if (tempFilePathOnHostSystem && fs.existsSync(fileToDelete)) { // Check existence of file via its path *inside* the Node container
            fs.unlink(fileToDelete, (err) => {
                if (err) console.error(`Error deleting temp file ${fileToDelete}:`, err);
                else console.log(`Temporary file ${fileToDelete} deleted.`);
            });
        }
        tempFilePathOnHostSystem = null;
    };
});