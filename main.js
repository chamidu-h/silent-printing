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
const path = require("path");
const os = require("os");
const fs = require("fs");
const cheerio = require("cheerio");

// Initialize persistent store with defaults
const store = new Store({
  defaults: {
    port: 4000,
    printerName: "XP-80C",
  },
});

let tray = null;
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
      preload: path.join(__dirname, "preload.js"), // Best practice
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
  updateTrayMenu(); // Update tray to reflect new settings if needed

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
      const tempWindow = new BrowserWindow({ show: false });
      const printers = await tempWindow.webContents.getPrintersAsync();
      tempWindow.close();

      res.json({
        success: true,
        printers: printers.map((p) => ({
          name: p.name,
          displayName: p.displayName,
          status: p.status,
          isDefault: p.isDefault,
          options: p.options,
        })),
      });
    } catch (error) {
      console.error("❌ Error fetching printers:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

 // The updated endpoint
server.post("/print", async (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ success: false, error: "Missing html in request body" });

  const storedPrinterName = store.get("printerName");
  if (!storedPrinterName) return res.status(500).json({ success: false, error: "No printer configured." });

  let printWindow;
  try {
    // Resolve the target printer
    const tmp = new BrowserWindow({ show: false });
    const printers = await tmp.webContents.getPrintersAsync();
    tmp.close();
    const target = printers.find(p => p.name === storedPrinterName);
    if (!target) return res.status(404).json({ success: false, error: `Printer "${storedPrinterName}" not found.` });

    // Constants
    const PAGE_WIDTH_MICRONS = 80000;   // 80 mm wide roll (Chromium pageSize uses microns)
    const PRINTABLE_WIDTH_MM = 72;      // typical effective width on 80mm printers (≈576 dots @203 dpi)
    const X_OFFSET_MM = store.get('xOffsetMm') ?? 0; // optional fine horizontal nudge (+ right, – left)

    // Use on-screen composition to avoid offscreen rasterization/scaling
    printWindow = new BrowserWindow({
      show: false,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: false,
        zoomFactor: 1.0
      }
    });

    // Load raw payload unchanged
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Lock zoom to 1:1 for consistent layout metrics
    printWindow.webContents.setZoomFactor(1.0);
    printWindow.webContents.setVisualZoomLevelLimits(1, 1);

    // Ensure images/fonts/barcode have settled before measuring/printing
    await printWindow.webContents.executeJavaScript(`
      (async () => {
        const imgs = Array.from(document.images);
        await Promise.all(imgs.map(img => img.complete ? Promise.resolve()
          : new Promise(r => { img.onload = img.onerror = r; })));
        if (document.fonts && document.fonts.ready) { await document.fonts.ready; }
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      })();
    `, true);

    // Center a 72mm canvas on an 80mm page (runtime-only, does not modify payload source)
    const cssKey = await printWindow.webContents.insertCSS(`
      @media print {
        @page { size: 80mm auto; margin: 0; }
        html, body {
          width: ${PRINTABLE_WIDTH_MM}mm !important;
          margin-left: calc(4mm + ${X_OFFSET_MM}mm) !important; /* (80-72)/2 = 4mm, plus optional offset */
          margin-right: 4mm !important;
          padding: 0 !important;
          box-sizing: border-box;
          transform: translateX(0); /* reserved: we use margins for centering */
        }
      }
    `);

    // Remove any payload padding safely
    await printWindow.webContents.insertCSS(`body { padding: 0 !important }`);

    // Compute required height in microns from document scroll height (96 CSS px per inch)
    const heightMicrons = await printWindow.webContents.executeJavaScript(`
      (function() {
        const px = Math.ceil(document.documentElement.scrollHeight);
        const inches = px / 96;
        const mm = inches * 25.4;
        return Math.max(120000, Math.ceil(mm * 1000)); // at least 120mm
      })();
    `, true);

    // Silent print with explicit 80mm width and measured height
    printWindow.webContents.print({
      silent: true,
      deviceName: target.name,
      printBackground: true,
      color: false,
      margins: { marginType: "custom", top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: { width: PAGE_WIDTH_MICRONS, height: heightMicrons } // microns
    }, (success, failureReason) => {
      // Best-effort cleanup of injected CSS (safe even if cssKey undefined)
      if (cssKey) { printWindow.webContents.removeInsertedCSS(cssKey).catch(() => {}); }
      if (!printWindow.isDestroyed()) printWindow.close();
      if (success) return res.json({ success: true, message: "Bill sent to printer successfully" });
      return res.status(500).json({ success: false, error: failureReason || "Print failed" });
    });
  } catch (err) {
    if (printWindow && !printWindow.isDestroyed()) printWindow.close();
    return res.status(500).json({ success: false, error: err.message });
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

function testPrint() {
    const { dialog } = require("electron");
    const storedPrinterName = store.get("printerName");
  
    const testHtml = `
      <div style="font-family: monospace; width: 80mm; padding: 5px; box-sizing: border-box;">
        <h2 style="text-align: center;">Test Print</h2>
        <p>--------------------------------</p>
        <p>Printer: ${storedPrinterName}</p>
        <p>Status: Success</p>
        <p>Time: ${new Date().toLocaleTimeString()}</p>
        <p>--------------------------------</p>
        <p style="text-align: center;">Print Agent is working!</p>
      </div>
    `;
  
    // Reuse the print logic
    const printPayload = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: testHtml }),
    };
  
    fetch(`http://localhost:${store.get("port")}/print`, printPayload)
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          dialog.showMessageBox({
            type: "info",
            title: "Test Print",
            message: "Test print sent successfully!",
          });
        } else {
          throw new Error(data.error);
        }
      })
      .catch(err => {
        console.error("Test print failed:", err);
        dialog.showErrorBox("Test Print Failed", err.message || "Could not connect to the print server.");
      });
  
    console.log("Test print triggered from tray menu");
  }

function showLogs() {
    const { shell } = require("electron");
    // This is a basic implementation. For production, you'd use a real logging library
    // and open the log file. For now, we can open the dev tools of a hidden window.
    const logWindow = new BrowserWindow({ show: false });
    logWindow.webContents.openDevTools();
    console.log("Developer tools opened for log inspection. Close the new window to dismiss.");
}
