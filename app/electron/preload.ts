const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ipcAPI', {
  getMachineId: () => ipcRenderer.invoke('get-machine-id'),
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  runAIEngine: (videoPath, outputPath, modelSize, language) => ipcRenderer.invoke('run-ai-engine', videoPath, outputPath, modelSize, language),
  onAIProgress: (callback) => ipcRenderer.on('ai-progress', (_event, data) => callback(data))
})
