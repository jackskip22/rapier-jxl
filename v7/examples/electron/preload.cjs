const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('rapierDesktop', {save: (data, name) => ipcRenderer.invoke('save', data, name)});
