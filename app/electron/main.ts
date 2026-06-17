import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineIdSync } from 'node-machine-id'
import { autoUpdater } from 'electron-updater'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Disable GPU Acceleration for Windows 7
app.disableHardwareAcceleration()

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    title: 'SubVideo AI',
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// IPC endpoint to get unique machine ID
ipcMain.handle('get-machine-id', () => {
  try {
    return machineIdSync()
  } catch (error) {
    return 'fallback-id-1234'
  }
})

// IPC endpoint to select video file
ipcMain.handle('select-video-file', async () => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'avi', 'mov'] }]
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

// IPC endpoint to save video file
ipcMain.handle('save-video-file', async (event, tempPath) => {
  const result = await dialog.showSaveDialog(win!, {
    title: 'Lưu Video Đã Lồng Tiếng',
    defaultPath: 'video_dubbed.mp4',
    filters: [{ name: 'Videos', extensions: ['mp4'] }]
  })
  
  if (!result.canceled && result.filePath) {
    fs.copyFileSync(tempPath, result.filePath)
    try { fs.unlinkSync(tempPath) } catch(e) {} // Clean up temp file
    return result.filePath
  }
  return null
})

// IPC endpoint to run the AI Engine
ipcMain.handle('run-ai-engine', (event, videoPath, outputPath, modelSize, language, outputType) => {
  return new Promise((resolve, reject) => {
    const enginePath = app.isPackaged 
      ? join(process.resourcesPath, 'engine.exe')
      : join(__dirname, '../../engine/dist/engine.exe');

    const args = [
      '--video', videoPath,
      '--output', outputPath,
      '--model', modelSize,
      '--language', language || 'auto',
      '--mode', outputType || 'both'
    ];

    const aiProcess = spawn(enginePath, args);

    aiProcess.stdout.on('data', (data) => {
      try {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const parsed = JSON.parse(line);
            event.sender.send('ai-progress', parsed);
          }
        }
      } catch (e) {
        // Not a JSON string, ignore or log
      }
    });

    aiProcess.stderr.on('data', (data) => {
      console.error(`AI Stderr: ${data.toString()}`);
    });

    aiProcess.on('close', (code) => {
      if (code === 0) resolve('Thành công');
      else reject(`Lỗi khi chạy AI Engine (code ${code})`);
    });
  });
})

// IPC endpoint for Step 1: Transcribe & Translate
ipcMain.handle('run-ai-engine-step1', (event, videoPath, outputPath, modelSize, language, geminiKey) => {
  return new Promise((resolve, reject) => {
    const enginePath = app.isPackaged 
      ? join(process.resourcesPath, 'engine.exe')
      : join(__dirname, '../../engine/dist/engine.exe');

    const args = [
      '--video', videoPath,
      '--output', outputPath,
      '--model', modelSize,
      '--language', language || 'auto',
      '--step', '1'
    ];
    
    if (geminiKey) {
      args.push('--gemini-key', geminiKey);
    }

    const aiProcess = spawn(enginePath, args);

    aiProcess.stdout.on('data', (data) => {
      try {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const parsed = JSON.parse(line);
            event.sender.send('ai-progress', parsed);
          }
        }
      } catch (e) {
        // Not a JSON string, ignore or log
      }
    });

    aiProcess.stderr.on('data', (data) => {
      console.error(`AI Stderr: ${data.toString()}`);
    });

    aiProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const jsonPath = outputPath + '.json';
          const content = fs.readFileSync(jsonPath, 'utf-8');
          resolve(JSON.parse(content));
        } catch (e) {
          reject(`Không thể đọc file dữ liệu: ${e}`);
        }
      } else {
        reject(`Lỗi khi chạy AI Engine Bước 1 (code ${code})`);
      }
    });
  });
})

// IPC endpoint for Step 2: TTS & Render
ipcMain.handle('run-ai-engine-step2', (event, videoPath, outputPath, language, outputType, editedSubtitles) => {
  return new Promise((resolve, reject) => {
    // Write edited subtitles back to json
    try {
      const jsonPath = outputPath + '.json';
      fs.writeFileSync(jsonPath, JSON.stringify(editedSubtitles, null, 2), 'utf-8');
    } catch (e) {
      reject(`Không thể lưu file dữ liệu: ${e}`);
      return;
    }

    const enginePath = app.isPackaged 
      ? join(process.resourcesPath, 'engine.exe')
      : join(__dirname, '../../engine/dist/engine.exe');

    const args = [
      '--video', videoPath,
      '--output', outputPath,
      '--language', language || 'auto',
      '--mode', outputType || 'both',
      '--step', '2'
    ];

    const aiProcess = spawn(enginePath, args);

    aiProcess.stdout.on('data', (data) => {
      try {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const parsed = JSON.parse(line);
            event.sender.send('ai-progress', parsed);
          }
        }
      } catch (e) {
        // Not a JSON string, ignore or log
      }
    });

    aiProcess.stderr.on('data', (data) => {
      console.error(`AI Stderr: ${data.toString()}`);
    });

    aiProcess.on('close', (code) => {
      if (code === 0) resolve('Thành công');
      else reject(`Lỗi khi chạy AI Engine Bước 2 (code ${code})`);
    });
  });
})
