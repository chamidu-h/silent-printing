// main.js - Complete Electron Print Agent with Settings UI
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
} = require("electron");
const express = require("express");
const bodyParser = require("body-parser");
const AutoLaunch = require("auto-launch");
const Store = require("electron-store");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const path = require("path");

// Initialize persistent store with defaults
const store = new Store({
  defaults: {
    port: 4000,
    printerName: "XP-80C",
  },
});

let tray = null;
let mainWindow = null;
let settingsWindow = null;
let server = null;

// Configure auto-launch on system boot
const autoLauncher = new AutoLaunch({
  name: "Silent Print Agent",
  isHidden: true,
});

// Initialize app when ready
app.whenReady().then(async () => {
  try {
    // Enable auto-start on boot
    const isEnabled = await autoLauncher.isEnabled();
    if (!isEnabled) {
      await autoLauncher.enable();
      console.log("✅ Auto-launch enabled");
    }
  } catch (error) {
    console.error("Auto-launch setup error:", error);
  }

  // Create system tray icon
  createTray();

  // Start local print server
  startPrintServer();

  console.log("🚀 Silent Print Agent started successfully");
});

// Prevent app from quitting when all windows are closed
app.on("window-all-closed", (e) => {
  // Keep app running in background
});

// macOS: Re-activate app when clicked in dock
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Don't create window, just show tray menu
  }
});

// Quit app completely
app.on("before-quit", () => {
  app.isQuitting = true;
});

function createTray() {
  // Create tray icon
  const iconPath = path.join(__dirname, "icon.png");

  // Create native image with proper sizing
  const icon = nativeImage.createFromPath(iconPath);
  const resizedIcon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(resizedIcon);
  tray.setToolTip("Silent Print Agent - Running");

  updateTrayMenu();

  // Show notification on tray click (optional)
  tray.on("click", () => {
    tray.popUpContextMenu();
  });
}

function updateTrayMenu() {
  const currentPort = store.get("port");
  const iconPath = path.join(__dirname, "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  const resizedIcon = icon.resize({ width: 16, height: 16 });

  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "🖨️ Silent Print Agent",
      enabled: false,
      icon: resizedIcon,
    },
    { type: "separator" },
    {
      label: `✓ Status: Running on port ${currentPort}`,
      enabled: false,
    },
    {
      label: `🌐 Endpoint: http://localhost:${currentPort}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => {
        openSettings();
      },
    },
    {
      label: "Test Print",
      click: () => {
        testPrint();
      },
    },
    {
      label: "View Logs",
      click: () => {
        showLogs();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Print Agent Settings",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  settingsWindow.loadFile("settings.html");

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// IPC handlers for settings
ipcMain.on("get-settings", (event) => {
  event.returnValue = {
    port: store.get("port"),
    printerName: store.get("printerName"),
  };
});

ipcMain.on("save-settings", (event, settings) => {
  const oldPort = store.get("port");

  store.set("port", settings.port);
  store.set("printerName", settings.printerName);

  event.returnValue = { success: true };

  // If port changed, notify user to restart
  if (oldPort !== settings.port) {
    const { dialog } = require("electron");
    dialog
      .showMessageBox(settingsWindow, {
        type: "info",
        title: "Restart Required",
        message: "Port settings updated successfully!",
        detail: "Please restart the Print Agent for changes to take effect.",
        buttons: ["Restart Now", "Later"],
      })
      .then((result) => {
        if (result.response === 0) {
          app.relaunch();
          app.quit();
        }
      });
  } else {
    settingsWindow.close();
  }
});

function startPrintServer() {
  const PORT = store.get("port");
  const defaultPrinter = store.get("printerName");

  server = express();
  server.use(bodyParser.json({ limit: "50mb" }));
  server.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

  const cors = require("cors");
  server.use(cors({ origin: "*" }));

  // Health check endpoint
  server.get("/", (req, res) => {
    res.json({
      status: "running",
      version: "1.0.0",
      port: PORT,
      platform: os.platform(),
      defaultPrinter: defaultPrinter,
      message: "Silent Print Agent is active",
    });
  });

  server.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Get available printers
  server.get("/printers", async (req, res) => {
    try {
      const printers = await getAvailablePrinters();
      res.json({ success: true, printers });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Main print endpoint (now accepts HTML and validates printer)
  server.post("/print", async (req, res) => {
    const { html } = req.body;
    if (!html) {
      return res
        .status(400)
        .json({ success: false, error: "Missing html in request body" });
    }

    // Always use the printer name from the store for consistency
    const storedPrinterName = store.get("printerName");
    if (!storedPrinterName) {
      console.error(
        "❌ Print failed: No printer name is configured in settings."
      );
      return res.status(500).json({
        success: false,
        error: "No printer configured in agent settings",
      });
    }

    let printWindow;

    try {
      // Get all available printers to find an exact match
      const printers = await getAvailablePrinters();
      const targetPrinter = printers.find((p) => p.name === storedPrinterName);

      if (!targetPrinter) {
        const errorMsg = `Configured printer "${storedPrinterName}" not found on this system.`;
        console.error(`❌ ${errorMsg}`);
        return res.status(404).json({ success: false, error: errorMsg });
      }

      console.log(`🖨️  Attempting to print to: ${targetPrinter.name}`);

      printWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      printWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
      );

      printWindow.webContents.on("did-finish-load", () => {
        setTimeout(() => {
          printWindow.webContents.print(
            {
              silent: true,
              deviceName: targetPrinter.name, // Use the validated device name
              printBackground: true,
              margins: { marginType: "none" },
            },
            (success, failureReason) => {
              if (!printWindow.isDestroyed()) printWindow.close();

              if (success) {
                console.log(
                  `✅ Print completed successfully for printer: ${targetPrinter.name}`
                );
                res.json({
                  success: true,
                  message: "Bill printed successfully",
                  printer: targetPrinter.name,
                });
              } else {
                const errorMsg =
                  failureReason || "An unknown error occurred during printing.";
                console.error("❌ Print failed:", errorMsg);
                res.status(500).json({ success: false, error: errorMsg });
              }
            }
          );
        }, 1000);
      });

      printWindow.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription) => {
          if (!printWindow.isDestroyed()) printWindow.close();
          console.error(
            "❌ Failed to load HTML for printing:",
            errorDescription
          );
          res.status(500).json({
            success: false,
            error: `Failed to load HTML: ${errorDescription}`,
          });
        }
      );
    } catch (error) {
      if (printWindow && !printWindow.isDestroyed()) printWindow.close();
      console.error(
        "❌ An unexpected error occurred in the print endpoint:",
        error.message
      );
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Start server
  server.listen(PORT, "localhost", () => {
    console.log("============================================================");
    console.log(`✅ Print Agent v1.0.0 running on http://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Print endpoint: http://localhost:${PORT}/print`);
    console.log(`   Default Printer: ${defaultPrinter}`);
    console.log(`   Platform: ${os.platform()}`);
    console.log("============================================================");
  });
}

async function silentPrint(pdfPath, printerName) {
  const platform = os.platform();

  if (platform === "win32") {
    // Windows: Use Electron's native print API
    return new Promise((resolve, reject) => {
      const printWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      printWindow.loadFile(pdfPath);

      printWindow.webContents.on("did-finish-load", () => {
        // Wait for rendering to complete
        setTimeout(() => {
          printWindow.webContents.print(
            {
              silent: true,
              deviceName: printerName,
              printBackground: true,
              margins: {
                marginType: "none",
              },
            },
            (success, failureReason) => {
              printWindow.close();

              if (!success) {
                reject(new Error(failureReason || "Print failed"));
              } else {
                console.log("✓ Windows print successful");
                resolve();
              }
            }
          );
        }, 1000);
      });

      printWindow.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription) => {
          printWindow.close();
          reject(new Error(`Failed to load PDF: ${errorDescription}`));
        }
      );
    });
  } else if (platform === "darwin") {
    // macOS: Use lp command
    try {
      await execPromise(`lp -d "${printerName}" "${pdfPath}"`);
      console.log("✓ macOS print successful");
    } catch (error) {
      throw new Error(`macOS print failed: ${error.message}`);
    }
  } else {
    // Linux: Use lp command
    try {
      await execPromise(`lp -d "${printerName}" "${pdfPath}"`);
      console.log("✓ Linux print successful");
    } catch (error) {
      throw new Error(`Linux print failed: ${error.message}`);
    }
  }
}

async function savePDF(base64Data) {
  // Remove data URL prefix if present
  const base64Clean = base64Data.replace(/^data:application\/pdf;base64,/, "");

  const buffer = Buffer.from(base64Clean, "base64");
  const tempPath = path.join(os.tmpdir(), `receipt_${Date.now()}.pdf`);

  fs.writeFileSync(tempPath, buffer);

  return tempPath;
}

async function getAvailablePrinters() {
  const platform = os.platform();

  if (platform === "darwin" || platform === "linux") {
    const { stdout } = await execPromise("lpstat -p -d");
    return stdout.trim().split("\n");
  } else if (platform === "win32") {
    // Windows: Get printers using WMI
    const { stdout } = await execPromise("wmic printer get name");
    const printers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "Name");
    return printers;
  }

  return [];
}

function testPrint() {
  console.log("Test print triggered from tray menu");
}

function showLogs() {
  console.log("Show logs clicked");
}
