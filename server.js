const express = require('express');
const {spawn} = require('child_process')
const fs = require('fs')
const path= require('path')
const {v4:uuidv4} = require('uuid')
const {WebSocket} = require('ws')

const app = express();
const PORT =  process.env.PORT || 3000;
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Code editor backend is alive and well!');
});

const server = app.listen(PORT,'0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
const wss = new WebSocket.Server({server})

wss.on('connection',ws=>{
    console.log('client connected via Websokets')

    let dockerProcess = null;

    ws.on('message',async message => {
        try{const data = JSON.parse(message) ;

        if(data.type==='code'){
            const code = data.value ;
            const language = data.language;
        
           if (!code) {
                    ws.send(JSON.stringify({ type: 'error', value: 'No code provided.' }));
                    return;
                }
        
        const uniqueId = uuidv4() ;
        const tempFilename = `temp_code_${uniqueId}.py`;
        
        const tempFilePathForDockerMount = path.join('/temp_files', tempFilename);


        const dockerImage = 'python:3.9-slim-buster';
       await fs.promises.writeFile(tempFilePathForDockerMount, code);
       console.log(`Code written to ${tempFilePathForDockerMount} (inside container)`);
        ws.send(JSON.stringify({ type: 'status', value: 'Code received and preparing for execution...' }));

        
        const command = 'docker';
                const args = [
                    'run',
                    '--rm',
                    '-i', // -i for interactive mode, crucial for stdin
                    '--net=none', // Restrict network access for security
                    '--memory=128m', // Limit memory to 128MB
                    '--cpus=0.5', // Limit CPU to 0.5 cores
                    '-v', `${tempFilePathForDockerMount}:/app/code.py`, // <-- Changed variable name
                    dockerImage,
                    'python', '/app/code.py'
                ];

        console.log(`Executing Docker command: ${command} ${args.join(' ')}`);
        dockerProcess = spawn(command, args, { timeout: 30000 });

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
        
        dockerProcess.on('close', (code) => {
                    console.log(`Docker process exited with code ${code}`);
                    let finalStatus = '';
                    if (code === 0) {
                        finalStatus = 'Program finished successfully.';
                    } else if (code === null) {
                        finalStatus = 'Program terminated (e.g., timed out or crashed).';
                    } else {
                        finalStatus = `Program exited with error code ${code}.`;
                    }
                    ws.send(JSON.stringify({ type: 'status', value: finalStatus }));
                    ws.send(JSON.stringify({ type: 'end' })); // Signal end of execution
                    cleanup();
                });
         dockerProcess.on('error', err => {
                    console.error(`Failed to start Docker process: ${err.message}`);
                    ws.send(JSON.stringify({ type: 'error', value: `Backend error: Could not start Docker process. Is Docker Desktop running? Error: ${err.message}` }));
                    ws.send(JSON.stringify({ type: 'end' }));
                    cleanup();
                });
        }else if(data.type === 'input'){
            if(dockerProcess && dockerProcess.stdin){
                console.log(`Writing input to Docker: ${data.value}`);
                dockerProcess.stdin.write(data.value+'\n')
             }else{
                console.warn('Received input, but Docker process is not running or stdin not available.');
                
             }
        }}catch(error){
            console.error('Error processing WebSocket message:', error);
            ws.send(JSON.stringify({ type: 'error', value: `Server error: ${error.message}` }));
            cleanup();
        }
    })
    ws.on('close',()=>{
        console.log("client disconnected from web soket")
         cleanup();
    })
    ws.on('error',()=>{
         console.error('WebSocket error:', error);
        cleanup();
    })

    const cleanup = ()=>{
        if(dockerProcess){
            console.log('Attempting to kill Docker process...');
            dockerProcess.kill()
            dockerProcess = null ;
        }

   if (tempFilePathForDockerMount && fs.existsSync(tempFilePathForDockerMount)) {
    fs.unlink(tempFilePathForDockerMount, (err) => {
        if (err) console.error(`Error deleting temp file ${tempFilePathForDockerMount}:`, err);
        else console.log(`Temporary file ${tempFilePathForDockerMount} deleted.`);
    });
    // tempFilePathForDockerMount = null; // No need to nullify a const, it's defined inside the if block
}
    }
})
console.log('Waiting for WebSocket connections...');