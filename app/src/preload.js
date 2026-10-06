const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pf', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  snap: () => ipcRenderer.send('win:snap'),
  openMessage: (item) =>
    ipcRenderer.send('open-message', { guildId: item.guildId, channelId: item.channelId, messageId: item.messageId }),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_e, d) => cb(d)),
  onDiscordStatus: (cb) => ipcRenderer.on('discord:status', (_e, s) => cb(s)),
});
