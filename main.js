const { app, BrowserWindow, screen, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

let win; // Khai báo biến global để quản lý window trên Mac tốt hơn

async function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  win = new BrowserWindow({
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
    // 🚀 Load file tĩnh index.html từ thư mục out và bẫy lỗi nếu không thấy file
    const indexPath = path.join(__dirname, "out", "index.html");
    win.loadFile(indexPath).catch((err) => {
      console.error("Không tìm thấy file tĩnh HTML:", err);
    });
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

// 2. Kênh Ghi file PDF (Đã tối ưu: Nhận Binary Buffer trực tiếp từ ArrayBuffer/Uint8Array)
ipcMain.handle("save-pdf-file", async (event, { folderPath, fileName, arrayBufferData }) => {
  try {
    const cleanFolderPath = path.normalize(folderPath);

    if (!fs.existsSync(cleanFolderPath)) {
      fs.mkdirSync(cleanFolderPath, { recursive: true });
    }

    const fullPath = path.join(cleanFolderPath, fileName);

    // 🚀 Chuyển trực tiếp ArrayBuffer/Uint8Array sang Node.js Buffer
    const buffer = Buffer.from(arrayBufferData);
    fs.writeFileSync(fullPath, buffer);

    return { success: true };
  } catch (error) {
    console.error("Lỗi ghi file PDF:", error);
    return { success: false, error: error.message };
  }
});

// =========================================================================
// 🚀 LIFECYCLE APP (Chuẩn hóa cho cả Windows & macOS)
// =========================================================================

app.whenReady().then(() => {
  createWindow();

  // 🚀 Xử lý chuẩn cho macOS: Click icon ở Dock mà chưa có window thì mở lại window mới
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});