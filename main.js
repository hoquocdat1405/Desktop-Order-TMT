const { app, BrowserWindow, screen, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const handler = require("serve-handler");

let server;

function startLocalServer() {
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      return handler(request, response, {
        public: path.join(__dirname, "out"),
      });
    });

    // 🚀 CỐ ĐỊNH CỔNG 3095 KHI BUILD .EXE ĐỂ DỮ LIỆU LOCALSTORAGE KHÔNG BỊ XÓA
    const FIXED_PORT = 3095;
    server.listen(FIXED_PORT, () => {
      resolve(`http://localhost:${FIXED_PORT}`);
    });
  });
}

async function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const windowWidth = Math.round(screenWidth * 0.8);
  const windowHeight = Math.round(screenHeight * 0.85);

  const iconPath = path.join(__dirname, "public", "ic.ico");

  const win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1024,
    minHeight: 650,
    title: "Xử lý đơn hàng",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });

  // 🚀 BẬT CỬA SỔ DEVTOOLS NAY LẬP TỨC ĐỂ XEM LOG CẢ TRÊN DEV VÀ BẢN .EXE
  win.webContents.openDevTools();

  if (app.isPackaged) {
    const serverUrl = await startLocalServer();
    win.loadURL(serverUrl);
  } else {
    // Khi dev thì load thẳng server Next.js dev
    win.loadURL("http://localhost:3099");
  }
}

// =========================================================================
// 🚀 LẮNG NGHE IPC EVENTS
// =========================================================================

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("save-pdf-file", async (event, { folderPath, fileName, base64Data }) => {
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    const fullPath = path.join(folderPath, fileName);
    const buffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(fullPath, buffer);

    return { success: true };
  } catch (error) {
    console.error("Lỗi ghi file PDF:", error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (server) server.close();
  if (process.platform !== "darwin") app.quit();
});