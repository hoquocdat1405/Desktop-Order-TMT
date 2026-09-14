const { app, BrowserWindow, screen, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

async function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const win = new BrowserWindow({
    width: Math.round(screenWidth * 0.8),
    height: Math.round(screenHeight * 0.85),
    minWidth: 1024,
    minHeight: 650,
    title: "Xử lý đơn hàng",
    icon: path.join(__dirname, "public", "ic.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });

  if (app.isPackaged) {
    // Load trực tiếp file index.html từ thư mục out
    win.loadFile(path.join(__dirname, "out", "index.html"));
  } else {
    // Khi Dev thì load server Next.js
    win.loadURL("http://localhost:3099");
  }
}

// =========================================================================
// 🚀 KHỞI TẠO CÁC KÊNH IPC INTERACTION
// =========================================================================

// 1. Kênh mở Hộp thoại chọn Thư mục
ipcMain.handle("select-folder", async () => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  } catch (error) {
    console.error("Lỗi mở dialog chọn thư mục:", error);
    return null;
  }
});

// 2. Kênh Ghi file PDF
ipcMain.handle("save-pdf-file", async (event, { folderPath, fileName, base64Data }) => {
  try {
    const cleanFolderPath = path.normalize(folderPath);

    if (!fs.existsSync(cleanFolderPath)) {
      fs.mkdirSync(cleanFolderPath, { recursive: true });
    }

    const fullPath = path.join(cleanFolderPath, fileName);
    const buffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(fullPath, buffer);

    return { success: true };
  } catch (error) {
    console.error("Lỗi ghi file PDF:", error);
    return { success: false, error: error.message };
  }
});

// =========================================================================
// 🚀 LIFECYCLE APP
// =========================================================================

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});