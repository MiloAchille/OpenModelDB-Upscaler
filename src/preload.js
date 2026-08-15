const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || null;
    }
  },
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (partial) => ipcRenderer.invoke("set-settings", partial),
  listModels: () => ipcRenderer.invoke("list-models"),
  deleteModel: (modelPath) => ipcRenderer.invoke("delete-model", modelPath),
  importModel: () => ipcRenderer.invoke("import-model"),
  openModelsFolder: () => ipcRenderer.invoke("open-models-folder"),
  pickImage: () => ipcRenderer.invoke("pick-image"),
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  pickSave: (opts) => ipcRenderer.invoke("pick-save", opts),
  readImagePreview: (filePath) => ipcRenderer.invoke("read-image-preview", filePath),
  openPath: (target) => ipcRenderer.invoke("open-path", target),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  omdbList: (opts) => ipcRenderer.invoke("omdb-list", opts),
  omdbRefresh: () => ipcRenderer.invoke("omdb-refresh"),
  downloadModel: (opts) => ipcRenderer.invoke("download-model", opts),
  upscale: (opts) => ipcRenderer.invoke("upscale", opts),
  cancelUpscale: () => ipcRenderer.invoke("cancel-upscale"),
  pythonStatus: () => ipcRenderer.invoke("python-status"),
  diagnoseRuntime: () => ipcRenderer.invoke("diagnose-runtime"),
  installRuntime: () => ipcRenderer.invoke("install-runtime"),
  cancelRuntimeInstall: () => ipcRenderer.invoke("cancel-runtime-install"),
  pickPythonEnv: () => ipcRenderer.invoke("pick-python-env"),
  clearCustomPython: () => ipcRenderer.invoke("clear-custom-python"),
  setInstallTarget: (target) => ipcRenderer.invoke("set-install-target", target),
  openRuntimeFolder: () => ipcRenderer.invoke("open-runtime-folder"),
  openDownloadCache: () => ipcRenderer.invoke("open-download-cache"),
  onUpscaleProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("upscale-progress", listener);
    return () => ipcRenderer.removeListener("upscale-progress", listener);
  },
  onUpscaleLog: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("upscale-log", listener);
    return () => ipcRenderer.removeListener("upscale-log", listener);
  },
  onDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
  onRuntimeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("runtime-progress", listener);
    return () => ipcRenderer.removeListener("runtime-progress", listener);
  },
  onRuntimeLog: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("runtime-log", listener);
    return () => ipcRenderer.removeListener("runtime-log", listener);
  },
});
